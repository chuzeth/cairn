import type {
  Activity, ActivityAnalysis, AthleteProfile, DailyCheckIn, DeclaredAbsence, PhysiologyModel,
  PmcSeries, RaceGoal, ReadinessScore, TrainingPlan, TrainingWeek,
} from '@cairn/core';
import * as db from '@cairn/db';
import {
  aggregateDurability, analyzeActivity, buildPmcSeries, buildPhysiologyModel, buildZones,
  computeReadiness, decayedEnvelopeWithCompanion, fitCriticalSpeed, interpretAcwr, interpretTsb,
  maximalEffortSupport, modelFromLabOnly, monotonize, type FieldEvidence, type MmpCurve,
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

/** Entrée d'enveloppe : la courbe d'une séance et la FC qui l'a accompagnée. */
type CurveEntry = { curve: MmpCurve; companion: MmpCurve | undefined; ageDays: number };
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * dayMs));

/**
 * Fenêtre d'observation de la courbe vitesse-durée.
 *
 * Une année entière, très au-delà de la demi-vie de fraîcheur (60 j) et de celle
 * d'une preuve d'effort maximal (90 j) : la pertinence d'une performance doit
 * s'éteindre par décroissance continue, jamais parce qu'une requête s'arrête à
 * une date. Une coupure posée là où une séance pèse encore fait sauter la
 * vitesse critique d'un jour à l'autre, sans qu'aucune donnée n'ait changé.
 */
const CURVE_WINDOW_DAYS = 365;

/** Fenêtre de comptage du volume de données, qui mesure la densité *récente*. */
const DATA_DENSITY_WINDOW_DAYS = 120;

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
  /** Le point du jour, s'il a été fait. Sa note libre n'est pas notée : elle est lue. */
  todayCheckIn?: DailyCheckIn;
  /**
   * Notes libres dont rien n'a encore été fait, la plus récente d'abord, sur
   * les soixante derniers jours.
   *
   * Une note n'entre dans aucun calcul : si personne ne la reprend, elle dort
   * dans sa colonne. « Je coupe dix jours » mérite mieux que d'être lu une
   * fois puis oublié.
   */
  pendingNotes: { date: string; notes: string }[];
  plan: { plan: TrainingPlan; weeks: TrainingWeek[] } | null;
  /**
   * Absences déclarées encore vivantes : en cours, à venir, ou assez récentes
   * pour recouvrir des séances que les règles vont juger. Sans elles, une
   * coupure annoncée ne se distingue pas d'un mois d'entraînements manqués.
   */
  absences: DeclaredAbsence[];
  upcomingRaces: RaceGoal[];
  recentActivities: Activity[];
  /** Courbe vitesse-durée corrigée de la pente, enveloppe 90 jours. */
  speedCurve: MmpCurve;
  /** FC moyenne de l'effort qui a produit chaque point de `speedCurve`. */
  speedCurveHr: MmpCurve;
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
  opts: { persist?: boolean; asOf?: string } = {},
): Promise<PhysiologyModel> {
  const profile = await db.getAthlete(athleteId);
  if (!profile) throw new Error(`Athlète inconnu : ${athleteId}`);
  const lab = profile.labTests[0];
  if (!lab) throw new Error(`Aucun test de laboratoire enregistré pour ${athleteId}.`);

  // `asOf` permet de rejouer le modèle à une date donnée — indispensable pour
  // vérifier qu'il évolue continûment plutôt que par sauts.
  const now = opts.asOf ? new Date(`${opts.asOf}T12:00:00Z`).getTime() : Date.now();
  const at = (n: number) => iso(new Date(now - n * dayMs));

  const activities = (
    await db.listActivities(athleteId, { from: at(CURVE_WINDOW_DAYS), limit: 400 })
  ).filter((a) => new Date(a.startDate).getTime() <= now);
  const analyses = await db.getAnalyses(activities.map((a) => a.id));
  const checkIns = await db.listCheckIns(athleteId, at(180));

  const runLike = activities.filter((a) =>
    ['Run', 'TrailRun', 'VirtualRun', 'Hike'].includes(a.sportType),
  );

  // ── Courbe vitesse-durée, pondérée par la fraîcheur ────────────────────────
  const curveEntries = runLike
    .map((a) => {
      const an = analyses.get(a.id);
      if (!an) return null;
      const ageDays = (now - new Date(a.startDate).getTime()) / dayMs;
      return { curve: an.meanMaximalSpeed, companion: an.meanMaximalSpeedHr, ageDays };
    })
    .filter((x): x is CurveEntry => x != null);

  const envelope = decayedEnvelopeWithCompanion(curveEntries, 60);
  const speedCurve = monotonize(envelope.curve);
  const asOf = iso(new Date(now));

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

  // La densité de données reste mesurée sur la fenêtre récente : élargir
  // l'observation de la courbe ne doit pas faire passer une année clairsemée
  // pour un trimestre dense.
  const densitySince = at(DATA_DENSITY_WINDOW_DAYS);
  const dataDays = new Set(
    activities.filter((a) => a.startDateLocal.slice(0, 10) >= densitySince)
      .map((a) => a.startDateLocal.slice(0, 10)),
  ).size;

  const evidence: FieldEvidence = {
    gradedSpeedCurve: speedCurve,
    gradedSpeedCurveHr: envelope.companion,
    gradedSpeedCurveAgeDays: envelope.ageDays,
    observedMaxHrs,
    restingHrs,
    bodyMasses,
    hrSpeedPairs,
    durability,
    vamCurve,
    dataDays,
  };

  const model = buildPhysiologyModel(lab, evidence, asOf);

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
  // Même fenêtre que celle où les règles jugent des séances passées.
  const absences = await db.listAbsences(athleteId, { from: daysAgo(60) });
  const upcomingRaces = await db.listRaceGoals(athleteId, today);
  const recentActivities = await db.listActivities(athleteId, { from: daysAgo(45), limit: 60 });

  const analyses = await db.getAnalyses(recentActivities.map((a) => a.id));
  const envelope = decayedEnvelopeWithCompanion(
    recentActivities
      .map((a) => {
        const an = analyses.get(a.id);
        return an ? { curve: an.meanMaximalSpeed, companion: an.meanMaximalSpeedHr, ageDays: 0 } : null;
      })
      .filter((x): x is CurveEntry => x != null),
    60,
  );
  const speedCurve = monotonize(envelope.curve);

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
    todayCheckIn: checkIns.find((c) => c.date === today),
    pendingNotes: checkIns
      .filter((c) => c.notes?.trim() && !c.noteHandledAt)
      .map((c) => ({ date: c.date, notes: c.notes as string }))
      .reverse(),
    plan,
    absences,
    upcomingRaces,
    recentActivities,
    speedCurve,
    speedCurveHr: envelope.companion,
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
  const labVt2Hr = state.profile.labTests[0]?.vt2.hr ?? 0;
  const support = maximalEffortSupport(fit, state.speedCurveHr, labVt2Hr);
  return {
    modelled: state.model.criticalSpeedMs,
    fieldFit: fit.criticalSpeedMs,
    dPrime: state.model.dPrimeM,
    quality: fit.quality,
    r2: fit.r2,
    maximalEffortSupport: support.support,
    maximalEffortTestedS: support.testedS,
    maximalEffortUntestableS: support.untestableS,
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

  const day = activity.startDateLocal.slice(0, 10);
  // Le rattachement choisit parmi les séances du jour, ou n'en choisit aucune.
  const planned = await db.listPlannedSessions(athleteId, day, day);

  const analysis = analyzeActivity(activity, stored.streams, model, {
    sex: 'M',
    gpsQuality: stored.gpsQuality as 'good' | 'poor' | 'none',
    plannedSessions: planned,
  });

  await db.saveAnalysis(athleteId, activity.startDateLocal, analysis);

  const compliance = analysis.compliance;
  if (compliance) {
    const target = planned.find((p) => p.id === compliance.plannedSessionId);
    const status = compliance.outcome === 'fulfilled' ? 'completed' : 'replaced';
    // Le statut est recalculé à chaque analyse, sans garde sur l'état précédent :
    // une séance passée en « manquée » par les règles doit pouvoir être reprise
    // par l'activité qui arrive après elles.
    await db.updateSession(compliance.plannedSessionId, {
      status,
      completedActivityId: activityId,
      // La justification du planificateur reste en place tant qu'elle dit vrai.
      // Elle est remplacée quand ce qui s'est passé la dément : une séance
      // remplacée, ou une « non réalisée » que l'activité vient contredire.
      ...(status === 'replaced' || target?.status === 'missed' ? { rationale: compliance.detail } : {}),
    });
  }
  return analysis;
}
