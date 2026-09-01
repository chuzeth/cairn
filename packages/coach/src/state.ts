import type {
  Activity, ActivityAnalysis, AthleteProfile, PhysiologyModel,
  PmcSeries, RaceGoal, ReadinessScore, TrainingPlan, TrainingWeek,
} from '@cairn/core';
import * as db from '@cairn/db';
import {
  aggregateDurability, analyzeActivity, buildPmcSeries, buildPhysiologyModel, buildZones,
  computeReadiness, decayedEnvelope, fitCriticalSpeed, interpretAcwr, interpretTsb,
  modelFromLabOnly, monotonize, type FieldEvidence, type MmpCurve,
} from '@cairn/physiology';

/**
 * État de l'athlète.
 *
 * Point de convergence unique : le modèle physiologique, la charge chronique,
 * la disponibilité du jour et le plan en cours sont calculés ici, une fois, et
 * consommés partout ailleurs — API, outils du chat, serveur MCP, front.
 * Aucun de ces chiffres n'est produit par un modèle de langage.
 */

const dayMs = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * dayMs));

export interface AthleteState {
  profile: AthleteProfile;
  model: PhysiologyModel;
  zones: ReturnType<typeof buildZones>;
  pmc: PmcSeries;
  today: {
    date: string;
    ctl: number;
    atl: number;
    tsb: number;
    mechanicalTsb: number;
    acwr: number;
    rampRate: number;
    monotony: number;
    tsbLabel: string;
    acwrLabel: string;
    acwrRisk: 'low' | 'moderate' | 'high';
  };
  readiness: ReadinessScore;
  plan: { plan: TrainingPlan; weeks: TrainingWeek[] } | null;
  upcomingRaces: RaceGoal[];
  recentActivities: Activity[];
  /** Courbe vitesse-durée corrigée de la pente, enveloppe 90 jours. */
  speedCurve: MmpCurve;
  vamCurve: Record<string, number>;
  weeklyTotals: { weekStart: string; load: number; mechanical: number; durationS: number; vertM: number }[];
}

/**
 * Reconstruit le modèle physiologique depuis l'ensemble des preuves terrain.
 * Appelé après chaque nouvelle activité — c'est ce qui fait que le système
 * « connaît » l'athlète mieux chaque semaine.
 */
export async function rebuildPhysiologyModel(
  athleteId: string,
  opts: { persist?: boolean } = {},
): Promise<PhysiologyModel> {
  const profile = await db.getAthlete(athleteId);
  if (!profile) throw new Error(`Athlète inconnu : ${athleteId}`);
  const lab = profile.labTests[0];
  if (!lab) throw new Error(`Aucun test de laboratoire enregistré pour ${athleteId}.`);

  const since = daysAgo(120);
  const activities = await db.listActivities(athleteId, { from: since, limit: 400 });
  const analyses = await db.getAnalyses(activities.map((a) => a.id));
  const checkIns = await db.listCheckIns(athleteId, daysAgo(180));

  const now = Date.now();
  const runLike = activities.filter((a) =>
    ['Run', 'TrailRun', 'VirtualRun', 'Hike'].includes(a.sportType),
  );

  // ── Courbe vitesse-durée, pondérée par la fraîcheur ────────────────────────
  const curveEntries = runLike
    .map((a) => {
      const an = analyses.get(a.id);
      if (!an) return null;
      const ageDays = (now - new Date(a.startDate).getTime()) / dayMs;
      return { curve: an.meanMaximalSpeed, ageDays };
    })
    .filter((x): x is { curve: MmpCurve; ageDays: number } => x != null);

  const speedCurve = monotonize(decayedEnvelope(curveEntries, 60));

  // ── Courbe VAM ─────────────────────────────────────────────────────────────
  const vamCurve: Record<string, number> = {};
  for (const a of runLike) {
    const an = analyses.get(a.id);
    if (!an) continue;
    for (const [k, v] of Object.entries(an.meanMaximalVam)) {
      if (!vamCurve[k] || v > (vamCurve[k] as number)) vamCurve[k] = v;
    }
  }

  // ── FC max & FC de repos ───────────────────────────────────────────────────
  const observedMaxHrs = activities
    .map((a) => a.maxHr)
    .filter((h): h is number => h != null && h > 100);
  const restingHrs = checkIns.map((c) => c.restingHr).filter((h): h is number => h != null);

  // ── Masse corporelle ───────────────────────────────────────────────────────
  const bodyMasses = checkIns.map((c) => c.bodyMassKg).filter((m): m is number => m != null);

  // ── Couples vitesse graduée / FC pour recaler le seuil ─────────────────────
  const hrSpeedPairs: { gradedSpeedMs: number; hr: number }[] = [];
  for (const a of runLike) {
    const an = analyses.get(a.id);
    if (!an) continue;
    for (const interval of an.intervals) {
      if (interval.avgHr != null && interval.durationS >= 180) {
        hrSpeedPairs.push({ gradedSpeedMs: interval.avgGradedSpeedMs, hr: interval.avgHr });
      }
    }
  }

  // ── Durabilité ─────────────────────────────────────────────────────────────
  const durabilityEntries = runLike
    .map((a) => {
      const an = analyses.get(a.id);
      if (!an) return null;
      return {
        result: {
          pctPer1000mVert: an.durabilitySignal.efDeclinePctPer1000mVert,
          pctPerHour: an.durabilitySignal.efDeclinePctPerHour,
          baselineEf: null,
          windows: [],
          sampleQuality: an.durabilitySignal.sampleQuality,
          r2Time: 0,
        },
        ageDays: (now - new Date(a.startDate).getTime()) / dayMs,
        durationS: a.movingTimeS,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x != null);

  const durability = aggregateDurability(durabilityEntries);

  const dataDays = new Set(activities.map((a) => a.startDateLocal.slice(0, 10))).size;

  const evidence: FieldEvidence = {
    gradedSpeedCurve: speedCurve,
    observedMaxHrs,
    restingHrs,
    bodyMasses,
    hrSpeedPairs,
    durability,
    vamCurve,
    dataDays,
  };

  const model = buildPhysiologyModel(lab, evidence, new Date().toISOString().slice(0, 10));

  // ── Aisance en descente, apprise depuis le terrain ─────────────────────────
  model.descentSkill = estimateDescentSkill(runLike, analyses);

  if (opts.persist !== false) await db.saveModel(athleteId, model);
  return model;
}

/**
 * Estime l'aisance en descente en comparant les vitesses réellement tenues aux
 * plafonds de référence, sur les tranches de pente descendantes.
 */
function estimateDescentSkill(
  activities: Activity[],
  analyses: Map<string, ActivityAnalysis>,
): number {
  // Référence : vitesse attendue au milieu de chaque tranche, terrain roulant.
  const reference: Record<string, number> = {
    '-30..-20': 3.9, '-20..-12': 4.4, '-12..-6': 4.9, '-6..-2': 5.2,
  };
  let weighted = 0;
  let totalWeight = 0;

  for (const a of activities) {
    const an = analyses.get(a.id);
    if (!an) continue;
    for (const bucket of an.gradeProfile) {
      if (bucket.to > -0.02 || bucket.seconds < 120 || bucket.avgSpeedMs <= 0) continue;
      const key = `${Math.round(bucket.from * 100)}..${Math.round(bucket.to * 100)}`;
      const ref = reference[key];
      if (!ref) continue;
      // On observe la vitesse *courante*, pas maximale : on prend un centile haut
      // implicite en pondérant par le temps passé.
      weighted += (bucket.avgSpeedMs / ref) * bucket.seconds;
      totalWeight += bucket.seconds;
    }
  }

  if (totalWeight < 600) return 1;
  // La vitesse moyenne sous-estime la capacité (footings inclus) : on relève de 15 %.
  const raw = (weighted / totalWeight) * 1.15;
  return Math.round(Math.min(1.3, Math.max(0.65, raw)) * 100) / 100;
}

/** Charge l'état complet de l'athlète. */
export async function loadAthleteState(athleteId: string): Promise<AthleteState> {
  const profile = await db.getAthlete(athleteId);
  if (!profile) throw new Error(`Athlète inconnu : ${athleteId}`);

  const model =
    (await db.getLatestModel(athleteId)) ??
    (profile.labTests[0]
      ? modelFromLabOnly(profile.labTests[0], new Date().toISOString().slice(0, 10))
      : null);
  if (!model) throw new Error("Aucun modèle physiologique disponible : importe d'abord un test d'effort.");

  const today = iso(new Date());
  const loads = await db.getDailyLoads(athleteId, daysAgo(400));
  const pmc = buildPmcSeries(loads, loads[0]?.date ?? daysAgo(90), today);
  const checkIns = await db.listCheckIns(athleteId, daysAgo(60));
  const readiness = computeReadiness({ date: today, pmc, checkIns });

  const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];
  const met = last(pmc.metabolic);
  const mech = last(pmc.mechanical);
  const acwr = last(pmc.acwr)?.value ?? 0;
  const ramp = last(pmc.rampRate)?.value ?? 0;
  const monotony = last(pmc.monotony)?.value ?? 0;

  const plan = await db.getActivePlan(athleteId);
  const upcomingRaces = await db.listRaceGoals(athleteId, today);
  const recentActivities = await db.listActivities(athleteId, { from: daysAgo(45), limit: 60 });

  const analyses = await db.getAnalyses(recentActivities.map((a) => a.id));
  const speedCurve = monotonize(
    decayedEnvelope(
      recentActivities
        .map((a) => {
          const an = analyses.get(a.id);
          return an ? { curve: an.meanMaximalSpeed, ageDays: 0 } : null;
        })
        .filter((x): x is { curve: MmpCurve; ageDays: number } => x != null),
      60,
    ),
  );

  const vamCurve: Record<string, number> = {};
  for (const a of recentActivities) {
    const an = analyses.get(a.id);
    if (!an) continue;
    for (const [k, v] of Object.entries(an.meanMaximalVam)) {
      if (!vamCurve[k] || v > (vamCurve[k] as number)) vamCurve[k] = v;
    }
  }

  const acwrInterp = interpretAcwr(acwr);

  return {
    profile,
    model,
    zones: buildZones(model),
    pmc,
    today: {
      date: today,
      ctl: met?.ctl ?? 0,
      atl: met?.atl ?? 0,
      tsb: met?.tsb ?? 0,
      mechanicalTsb: mech?.tsb ?? 0,
      acwr,
      rampRate: ramp,
      monotony,
      tsbLabel: interpretTsb(met?.tsb ?? 0).label,
      acwrLabel: acwrInterp.label,
      acwrRisk: acwrInterp.risk,
    },
    readiness,
    plan,
    upcomingRaces,
    recentActivities,
    speedCurve,
    vamCurve,
    weeklyTotals: computeWeeklyTotals(recentActivities, analyses),
  };
}

function computeWeeklyTotals(
  activities: Activity[],
  analyses: Map<string, ActivityAnalysis>,
): AthleteState['weeklyTotals'] {
  const byWeek = new Map<string, { load: number; mechanical: number; durationS: number; vertM: number }>();
  for (const a of activities) {
    const d = new Date(`${a.startDateLocal.slice(0, 10)}T00:00:00Z`);
    const dow = d.getUTCDay();
    const monday = iso(new Date(d.getTime() + (dow === 0 ? -6 : 1 - dow) * dayMs));
    const entry = byWeek.get(monday) ?? { load: 0, mechanical: 0, durationS: 0, vertM: 0 };
    const an = analyses.get(a.id);
    entry.load += an?.load.metabolic ?? 0;
    entry.mechanical += an?.load.mechanical ?? 0;
    entry.durationS += a.movingTimeS;
    entry.vertM += a.totalElevationGainM;
    byWeek.set(monday, entry);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, v]) => ({
      weekStart,
      load: Math.round(v.load),
      mechanical: Math.round(v.mechanical),
      durationS: Math.round(v.durationS),
      vertM: Math.round(v.vertM),
    }));
}

/** Vitesse critique ajustée depuis la courbe courante — utilisée par les outils. */
export function currentCriticalSpeed(state: AthleteState) {
  const fit = fitCriticalSpeed(state.speedCurve);
  return {
    modelled: state.model.criticalSpeedMs,
    fieldFit: fit.criticalSpeedMs,
    dPrime: state.model.dPrimeM,
    quality: fit.quality,
    r2: fit.r2,
  };
}

/** Analyse (ou ré-analyse) une activité et persiste le résultat. */
export async function analyzeAndStore(
  athleteId: string,
  activityId: string,
  model: PhysiologyModel,
): Promise<ActivityAnalysis | null> {
  const activity = await db.getActivity(activityId);
  if (!activity) return null;
  const stored = await db.getStreams(activityId);
  if (!stored) return null;

  const planned = await db.listPlannedSessions(
    athleteId,
    activity.startDateLocal.slice(0, 10),
    activity.startDateLocal.slice(0, 10),
  );
  // On rattache la séance prévue du jour dont le type est le plus proche.
  const match = planned.find((p) => p.status === 'planned' || p.status === 'completed');

  const analysis = analyzeActivity(activity, stored.streams, model, {
    sex: 'M',
    gpsQuality: stored.gpsQuality as 'good' | 'poor' | 'none',
    plannedSession: match,
  });

  await db.saveAnalysis(athleteId, activity.startDateLocal, analysis);

  if (match && match.status === 'planned') {
    await db.updateSession(match.id, { status: 'completed', completedActivityId: activityId });
  }
  return analysis;
}
