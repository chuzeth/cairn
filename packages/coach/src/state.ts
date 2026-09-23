import type {
  Activity, ActivityAnalysis, AthleteProfile, DailyCheckIn, DeclaredAbsence, PhysiologyModel,
  PlannedSession, PmcSeries, RaceGoal, ReadinessScore, TrainingPlan, TrainingWeek,
} from '@cairn/core';
import * as db from '@cairn/db';
import {
  EASY_SPEED_WINDOW_DAYS, aggregateDurability, analyzeActivity, buildPmcSeries, buildPhysiologyModel, buildZones,
  computeReadiness, decayedEnvelopeWithCompanion, estimateHrMax, fitCriticalSpeed, hrHistogramOf, interpretAcwr,
  interpretTsb, maximalEffortSupport, modelFromLabOnly, monotonize, movingIndices, projectFrom, projectLoadRatios,
  ratioExceedances, type DailyLoad, type EasyRun, type FieldEvidence, type LoadRatioExceedance, type MmpCurve,
  type ReadinessDay,
} from '@cairn/physiology';
import { absenceCovering } from './adapt.js';
import { addDays, mondayOf } from './periodization.js';
import { withHistory } from './presentation.js';
import { carriesEccentricStrength, eccentricStrengthOf } from './sessionLibrary.js';

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
    /** Ratio charge aiguë / chronique de la filière mécanique, circuits faits compris. */
    mechanicalAcwr: number;
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
  /**
   * Circuits excentriques que l'athlète a faits : le rang de son prochain
   * circuit, donc ses tours. Zéro, il n'en a jamais fait.
   */
  eccentricCircuitsDone: number;
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

  // ── Courbes verticales ─────────────────────────────────────────────────────
  const { climb: vamCurve, descent: descentVamCurve } = verticalEnvelopes(
    runLike.map((a) => analyses.get(a.id)),
  );

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
          // Absente d'une analyse antérieure au moteur 1.3.0 : sa pente
          // verticale ne prouve rien, et l'agrégat ne la compte pas.
          timeVertCorrelation: an.durabilitySignal.timeVertCorrelation ?? null,
        },
        ageDays: (now - new Date(a.startDate).getTime()) / dayMs,
        durationS: a.movingTimeS,
        vertM: a.totalElevationGainM,
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

  // ── Allure facile ──────────────────────────────────────────────────────────
  // La FC de chaque sortie récente dit sous quel plafond elle s'est courue :
  // c'est là que se lit l'allure à laquelle se comptent les séances faciles.
  const easyRuns = await easyRunsOf(
    activities, analyses, now, estimateHrMax(observedMaxHrs, lab.hrMax).value,
  );

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
    descentVamCurve,
    dataDays,
    easyRuns,
  };

  const model = buildPhysiologyModel(lab, evidence, asOf);

  // ── Aisance en descente, apprise depuis le terrain ─────────────────────────
  model.descentSkill = estimateDescentSkill(runLike, analyses);

  if (opts.persist !== false) await db.saveModel(athleteId, model);
  return model;
}

/** Sports dont l'allure dit ce que l'athlète court : une randonnée n'en dit rien. */
const RUNNING_SPORTS = new Set(['Run', 'TrailRun', 'VirtualRun']);

/**
 * Les sorties courues de la fenêtre de l'allure facile, avec leur FC en
 * mouvement. Une sortie sans flux, ou dont la FC couvre trop peu du temps, ne
 * dit rien d'un plafond : elle n'en fait pas partie.
 */
async function easyRunsOf(
  activities: readonly Activity[],
  analyses: Map<string, ActivityAnalysis>,
  now: number,
  hrMax: number,
): Promise<EasyRun[]> {
  const out: EasyRun[] = [];
  for (const a of activities) {
    const ageDays = (now - new Date(a.startDate).getTime()) / dayMs;
    const an = analyses.get(a.id);
    if (!RUNNING_SPORTS.has(a.sportType) || ageDays > EASY_SPEED_WINDOW_DAYS || !an) continue;
    const stored = await db.getStreams(a.id);
    const hr = stored ? hrHistogramOf(stored.streams, hrMax) : null;
    if (!stored || !hr) continue;
    const idx = movingIndices(stored.streams);
    out.push({
      ageDays,
      durationS: idx.length,
      normalizedGradedSpeedMs: an.load.normalizedGradedSpeedMs,
      groundSpeedMs: idx.reduce((sum, i) => sum + (stored.streams.velocity[i] ?? 0), 0) / idx.length,
      hr,
    });
  }
  return out;
}

/**
 * Enveloppes verticales : la meilleure vitesse tenue sur chaque durée, en montée
 * et en descente, toutes séances confondues.
 *
 * Une analyse antérieure au moteur 1.2.0 ne porte pas de courbe de descente :
 * elle ne compte que pour la montée, et une descente sans aucun point retombe
 * sur sa valeur par défaut, déclarée comme telle.
 */
export function verticalEnvelopes(
  analyses: readonly (ActivityAnalysis | undefined)[],
): { climb: Record<string, number>; descent: Record<string, number> } {
  const climb: Record<string, number> = {};
  const descent: Record<string, number> = {};
  const fold = (into: Record<string, number>, curve: Record<string, number> | undefined) => {
    for (const [k, v] of Object.entries(curve ?? {})) {
      if (!into[k] || v > (into[k] as number)) into[k] = v;
    }
  };
  for (const an of analyses) {
    if (!an) continue;
    fold(climb, an.meanMaximalVam);
    fold(descent, an.meanMaximalDescentVam);
  }
  return { climb, descent };
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

/**
 * Sports dont la foulée frappe le sol.
 *
 * « Sans impact » n'est pas « sans entraînement » : une semaine de vélo laisse
 * la charge métabolique presque intacte et le tendon d'Achille déshabitué. La
 * reprise se compte donc sur ce qui percute, pas sur ce qui fatigue.
 */
const IMPACT_SPORTS = new Set(['Run', 'TrailRun', 'VirtualRun', 'Hike']);

/** Séances dont il n'y a plus rien à faire : elles ont eu lieu. */
const DONE_STATUSES = new Set<PlannedSession['status']>(['completed', 'replaced']);

/**
 * Ce que la journée tient, pour la recommandation de disponibilité.
 *
 * La règle de lecture est celle de l'écran du matin, et doit le rester : une
 * journée peut porter une séance et un repos, c'est la séance qui l'emporte ;
 * une séance retirée par une absence ou annulée n'est plus au programme. Deux
 * lectures divergentes, ce serait le titre de l'écran et le conseil juste
 * dessous qui parlent de deux journées différentes — précisément le défaut
 * qu'on ferme ici.
 */
async function situationOn(
  athleteId: string,
  date: string,
  absences: DeclaredAbsence[],
  recent: Activity[],
): Promise<ReadinessDay> {
  const held = (await db.listPlannedSessions(athleteId, date, date)).filter(
    (s) => s.status !== 'withdrawn' && s.status !== 'cancelled',
  );
  const planned = held.find((s) => s.type !== 'rest') ?? held[0];
  const ranToday = recent.some((a) => a.startDateLocal.slice(0, 10) === date);

  const session: ReadinessDay['session'] =
    planned == null ? (ranToday ? 'done' : 'none')
    : DONE_STATUSES.has(planned.status) ? 'done'
    : planned.type === 'rest' ? 'rest'
    : 'work';

  return {
    session,
    absence: absenceCovering(absences, date)?.kind,
    daysWithoutImpact: await daysWithoutImpact(athleteId, date, recent),
  };
}

/**
 * Jours pleins sans impact avant `date` — onze entre une dernière sortie le
 * 02/09 et une reprise le 14/09.
 *
 * La fenêtre des activités récentes répond dans tous les cas ordinaires. Quand
 * elle ne contient aucun impact, on redemande sans borne de date : annoncer la
 * largeur de la fenêtre pour une coupure de six mois serait donner un chiffre
 * faux plutôt qu'aucun.
 */
async function daysWithoutImpact(
  athleteId: string,
  date: string,
  recent: Activity[],
): Promise<number | undefined> {
  const isImpact = (a: Activity) => IMPACT_SPORTS.has(a.sportType);
  const last =
    recent.find(isImpact) ?? (await db.listActivities(athleteId, { limit: 40 })).find(isImpact);
  if (!last) return undefined;
  const gap = Math.round(
    (new Date(`${date}T00:00:00Z`).getTime() -
      new Date(`${last.startDateLocal.slice(0, 10)}T00:00:00Z`).getTime()) / dayMs,
  );
  return Math.max(0, gap - 1);
}

/**
 * Le modèle courant : le dernier enregistré, à défaut celui du seul test
 * d'effort. C'est celui dont `loadAthleteState` part, sans le reste de l'état.
 */
export async function currentModel(athleteId: string): Promise<PhysiologyModel> {
  const saved = await db.getLatestModel(athleteId);
  if (saved) return saved;
  const lab = (await db.getAthlete(athleteId))?.labTests[0];
  if (!lab) throw new Error("Aucun modèle physiologique disponible : importe d'abord un test d'effort.");
  return modelFromLabOnly(lab, new Date().toISOString().slice(0, 10));
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
  const loads = await realizedDailyLoads(athleteId, daysAgo(400), today);
  const eccentricCircuitsDone = await countEccentricCircuits(athleteId, daysAgo(400), today);
  const pmc = buildPmcSeries(loads, loads[0]?.date ?? daysAgo(90), today);
  const checkIns = await db.listCheckIns(athleteId, daysAgo(60));

  const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];
  const met = last(pmc.metabolic);
  const mech = last(pmc.mechanical);
  const acwr = last(pmc.acwr)?.value ?? 0;
  const mechanicalAcwr = last(pmc.mechanicalAcwr)?.value ?? 0;
  const ramp = last(pmc.rampRate)?.value ?? 0;
  const monotony = last(pmc.monotony)?.value ?? 0;

  const plan = await db.getActivePlan(athleteId);
  // Même fenêtre que celle où les règles jugent des séances passées.
  const absences = await db.listAbsences(athleteId, { from: daysAgo(60) });
  const upcomingRaces = await db.listRaceGoals(athleteId, today);
  const recentActivities = await db.listActivities(athleteId, { from: daysAgo(45), limit: 60 });

  // La disponibilité se calcule après le plan et les absences, et pas avant :
  // ce qu'il faut faire d'un score dépend de ce que la journée tient, et le
  // paquet `physiology` ne va rien chercher — on le lui donne.
  const readiness = computeReadiness({
    date: today,
    pmc,
    checkIns,
    day: await situationOn(athleteId, today, absences, recentActivities),
  });

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
      mechanicalAcwr,
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
    eccentricCircuitsDone,
  };
}

/**
 * Statuts d'une séance qu'on attend encore. Elles seules pèsent sur la forme à
 * venir : une séance retirée, annulée ou déjà remplacée ne produira aucune
 * charge.
 */
const STANDING_STATUSES = new Set<PlannedSession['status']>(['planned', 'moved']);

/** Forme reportée d'une date à une autre. */
export interface CarriedFitness {
  ctl: number;
  atl: number;
  /** Jours franchis entre les deux dates. Zéro : rien n'a été reporté. */
  gapDays: number;
  /** Charge attendue sur ces jours-là, en points. */
  gapLoad: number;
}

/**
 * Reporte la forme d'aujourd'hui au premier jour d'un plan à venir.
 *
 * Calibrer un plan sur la forme du jour où on le construit est faux dès qu'il
 * commence plus tard : entre les deux dates, la charge chronique continue de
 * vivre — elle se perd pendant une coupure, elle monte si l'athlète s'entraîne.
 * Onze jours d'écart suffisent à faire proposer une semaine de reprise que
 * personne ne peut plus tenir.
 *
 * Les jours intercalaires portent ce que le plan y prévoit encore : une séance
 * retirée par une absence déclarée ne pèse rien, et un jour sans séance vaut
 * zéro — c'est ainsi qu'une coupure se paie.
 */
export function carryFitness(
  from: { date: string; ctl: number; atl: number },
  until: string,
  planned: PlannedSession[],
  absences: DeclaredAbsence[],
): CarriedFitness {
  const here = { ctl: from.ctl, atl: from.atl, gapDays: 0, gapLoad: 0 };
  const start = addDays(from.date, 1);
  const end = addDays(until, -1);
  if (end < start) return here;

  const loads = planned
    .filter(
      (s) =>
        s.date >= start &&
        s.date <= end &&
        STANDING_STATUSES.has(s.status) &&
        !absenceCovering(absences, s.date),
    )
    .map((s) => ({ date: s.date, load: s.plannedLoad }));

  const points = projectFrom({ ctl: from.ctl, atl: from.atl }, loads, start, end);
  const last = points[points.length - 1];
  if (!last) return here;
  return {
    ctl: last.ctl,
    atl: last.atl,
    gapDays: points.length,
    gapLoad: Math.round(loads.reduce((a, l) => a + l.load, 0)),
  };
}

/** `carryFitness` alimenté par le plan actif : ce que `rebuild_plan` appelle. */
export async function fitnessAtPlanStart(
  state: AthleteState,
  planStart: string,
): Promise<CarriedFitness> {
  const from = { date: state.today.date, ctl: state.today.ctl, atl: state.today.atl };
  const planned = await db.listPlannedSessions(
    state.profile.id,
    addDays(state.today.date, 1),
    addDays(planStart, -1),
  );
  return carryFitness(from, planStart, planned, state.absences);
}

/**
 * Charges quotidiennes réalisées, sur les deux filières, jusqu'à `to` inclus.
 *
 * Le flux d'activité ne voit pas un circuit de renforcement : la filière
 * mécanique ignorait tout l'excentrique hors course, et un palier de trois
 * tours ne pesait rien le soir où il avait été fait. Une séance faite y compte
 * ce que son circuit prescrivait — c'est tout ce qui existe de ce travail-là.
 */
export async function realizedDailyLoads(athleteId: string, from: string, to: string): Promise<DailyLoad[]> {
  const measured = (await db.getDailyLoads(athleteId, from)).filter((l) => l.date <= to);
  const strength = (await db.listPlannedSessions(athleteId, from, to))
    .filter((s) => s.status === 'completed')
    .map((s) => ({ date: s.date, metabolic: 0, mechanical: eccentricStrengthOf(s.blocks) }))
    .filter((l) => l.mechanical > 0);
  return [...measured, ...strength].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Circuits excentriques faits entre deux dates : les séances réalisées qui en
 * portaient un. C'est la même lecture que la charge réalisée — une séance faite
 * a fait son circuit, faute de flux qui dise le contraire.
 */
export async function countEccentricCircuits(athleteId: string, from: string, to: string): Promise<number> {
  return (await db.listPlannedSessions(athleteId, from, to)).filter(
    (s) => s.status === 'completed' && carriesEccentricStrength(s.blocks),
  ).length;
}

/** Ce qu'une séance attendue pèsera, sur les deux filières. */
const plannedLoadOf = (s: PlannedSession): DailyLoad => ({
  date: s.date,
  metabolic: s.plannedLoad,
  mechanical: s.plannedMechanicalLoad,
});

/** Séances qui pèseront encore : attendues, et hors d'une absence déclarée. */
const expected = (sessions: readonly PlannedSession[], absences: DeclaredAbsence[]) =>
  sessions.filter((s) => STANDING_STATUSES.has(s.status) && !absenceCovering(absences, s.date));

/**
 * Charges connues avant le premier jour d'un plan à construire : le réalisé
 * jusqu'à aujourd'hui, puis ce que le plan actif prévoit encore d'ici là — les
 * mêmes jours intercalaires que `carryFitness`. C'est la charge chronique sur
 * laquelle le planificateur lit les ratios du plan qu'il écrit.
 */
export async function knownLoadsBefore(state: AthleteState, planStart: string): Promise<DailyLoad[]> {
  const today = state.today.date;
  const realized = await realizedDailyLoads(state.profile.id, addDays(today, -400), today);
  const gap = addDays(planStart, -1) > today
    ? expected(
        await db.listPlannedSessions(state.profile.id, addDays(today, 1), addDays(planStart, -1)),
        state.absences,
      ).map(plannedLoadOf)
    : [];
  return [...realized, ...gap].filter((l) => l.date < planStart);
}

/** Ratios de charge du plan actif au-delà de leur seuil, avant et après une modification. */
export interface RatioProjection {
  from: string;
  to: string;
  before: LoadRatioExceedance[];
  after: LoadRatioExceedance[];
}

/**
 * Ce que le plan actif produit comme ratios de charge d'aujourd'hui à la veille
 * de sa course, et ce qu'une modification de séance en ferait.
 *
 * Le réalisé fait foi jusqu'à aujourd'hui ; à partir d'aujourd'hui, les séances
 * qu'on attend encore. C'est ce qui fait qu'un pic se voit quand la séance
 * s'écrit, et pas seulement le soir où sa charge est réalisée. `null` quand il
 * n'y a rien à projeter.
 */
export async function projectPlanRatios(
  athleteId: string,
  today: string,
  change?: { sessionId: string; patch: Partial<PlannedSession> },
): Promise<RatioProjection | null> {
  const sessions = await db.listPlannedSessions(athleteId, today, addDays(today, 400));
  if (sessions.length === 0) return null;
  const race = sessions.find((s) => s.type === 'race' && s.date > today);
  const to = race ? addDays(race.date, -1) : sessions[sessions.length - 1]!.date;
  if (to < today) return null;

  const absences = await db.listAbsences(athleteId, { from: today });
  const realized = await realizedDailyLoads(athleteId, addDays(today, -400), today);
  const exceedances = (list: readonly PlannedSession[]) =>
    ratioExceedances(projectLoadRatios(realized, expected(list, absences).map(plannedLoadOf), today, to));

  const modified = change
    ? sessions.map((s) => (s.id === change.sessionId ? { ...s, ...change.patch } : s))
    : sessions;
  return { from: today, to, before: exceedances(sessions), after: exceedances(modified) };
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

/** Ce que dit un statut de séance jugée, tel que l'athlète le lit. */
const JUDGED_FR: Partial<Record<PlannedSession['status'], string>> = {
  completed: '« réalisée »',
  replaced: '« remplacée »',
};

/**
 * Analyse (ou ré-analyse) une activité et persiste le résultat.
 *
 * `onlyIfMatched` : rien n'est écrit si l'activité ne rattache aucune séance —
 * c'est la passe de rattachement, qui ne réécrit une analyse que pour y poser
 * un rattachement. `onlyIfRejudged` : rien n'est écrit si le jugement de la
 * séance rattachée ne change pas — c'est la même passe, sur une activité
 * qu'une séance tient déjà.
 */
export async function analyzeAndStore(
  athleteId: string,
  activityId: string,
  model: PhysiologyModel,
  opts: { onlyIfMatched?: boolean; onlyIfRejudged?: boolean } = {},
): Promise<ActivityAnalysis | null> {
  const activity = await db.getActivity(activityId);
  if (!activity) return null;
  const stored = await db.getStreams(activityId);
  if (!stored) return null;

  const day = activity.startDateLocal.slice(0, 10);
  // Le rattachement choisit parmi les séances du jour, de la veille et du
  // lendemain, ou n'en choisit aucune.
  const planned = await db.listPlannedSessions(athleteId, addDays(day, -1), addDays(day, 1));

  const analysis = analyzeActivity(activity, stored.streams, model, {
    sex: 'M',
    gpsQuality: stored.gpsQuality as 'good' | 'poor' | 'none',
    plannedSessions: planned,
  });

  const compliance = analysis.compliance;
  if ((opts.onlyIfMatched || opts.onlyIfRejudged) && !compliance) return null;
  const target = compliance ? planned.find((p) => p.id === compliance.plannedSessionId) : undefined;
  const status = compliance?.outcome === 'fulfilled' ? 'completed' : 'replaced';
  if (opts.onlyIfRejudged && target?.status === status) return null;
  await db.saveAnalysis(athleteId, activity.startDateLocal, analysis);

  if (compliance) {
    const dayMonth = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    const at = new Date().toISOString();
    // Une séance déjà jugée que le jugement d'aujourd'hui contredit : ce qu'on
    // lui avait fait dire est faux, et l'athlète l'a lu.
    const before = target ? JUDGED_FR[target.status] : undefined;
    const rejudged = before != null && target?.status !== status;
    let history = target?.history;
    // Réalisée la veille ou le lendemain, la séance prend sa date réelle et
    // garde celle du plan. Tout ce qui lit une séance par sa date — le
    // lendemain d'un test maximal, les 48 h entre deux séances exigeantes, la
    // charge de la semaine, ce que porte la montre — la lit alors au jour où
    // elle a eu lieu.
    const moved = target != null && target.date !== day;
    if (moved) {
      history = withHistory(history, {
        at,
        by: 'rules',
        text:
          `Prévue le ${dayMonth(target.date)}, réalisée le ${dayMonth(day)} : « ${activity.name} » ` +
          `en porte le contenu. La séance prend sa date réelle.`,
      });
    }
    if (rejudged) {
      history = withHistory(history, {
        at,
        by: 'rules',
        text: `Rejugée : ${JUDGED_FR[status]}, et non plus ${before}. ${compliance.detail}`,
      });
    }
    // Le statut est recalculé à chaque analyse, sans garde sur l'état précédent :
    // une séance passée en « manquée » par les règles doit pouvoir être reprise
    // par l'activité qui arrive après elles.
    await db.updateSession(compliance.plannedSessionId, {
      status,
      completedActivityId: activityId,
      // La justification du planificateur reste en place tant qu'elle dit vrai.
      // Elle est remplacée quand ce qui s'est passé la dément : une séance
      // remplacée, une « non réalisée » que l'activité vient contredire, ou un
      // jugement que le jugement d'aujourd'hui contredit.
      ...(status === 'replaced' || target?.status === 'missed' || rejudged ? { rationale: compliance.detail } : {}),
      ...(moved ? { date: day, weekStart: mondayOf(day), plannedDate: target.plannedDate ?? target.date } : {}),
      ...(history !== target?.history ? { history } : {}),
    });
  }
  return analysis;
}

/**
 * Le rattachement des sept derniers jours, refait — et le jugement avec lui.
 *
 * Une activité peut avoir été analysée avant que la séance qu'elle réalisait
 * ne soit candidate : un plan reconstruit depuis, ou le rattachement d'avant,
 * qui ne regardait que le jour même — le test maximal couru le 21/09 pour le
 * 22/09. La passe reprend, dans l'ordre où elles ont été courues, les activités
 * récentes qu'aucune séance ne tient. Rien n'est écrit pour une activité qui ne
 * rattache toujours rien.
 *
 * Celles qu'une séance tient la gardent : refaire le rattachement ne défait
 * jamais un rattachement existant. Mais elles sont rejugées, parce qu'un
 * jugement peut avoir été faux : le décrassage du 22/09, couru à 133 bpm pour un
 * plafond de 141, avait été déclaré remplacé sur une charge prévue cinq fois
 * trop basse. Seul un jugement qui change s'écrit.
 */
export async function rematchRecent(
  athleteId: string,
  model: PhysiologyModel,
  today: string,
  days = 7,
): Promise<{ activityId: string; sessionId: string }[]> {
  const from = addDays(today, -days);
  const activities = await db.listActivities(athleteId, { from, to: today });
  const held = new Set(
    (await db.listPlannedSessions(athleteId, addDays(from, -1), addDays(today, 1)))
      .map((s) => s.completedActivityId)
      .filter((id): id is string => id != null),
  );
  const matched: { activityId: string; sessionId: string }[] = [];
  for (const a of [...activities].sort((x, y) => x.startDateLocal.localeCompare(y.startDateLocal))) {
    const analysis = await analyzeAndStore(
      athleteId, a.id, model, held.has(a.id) ? { onlyIfRejudged: true } : { onlyIfMatched: true },
    );
    if (analysis?.compliance) matched.push({ activityId: a.id, sessionId: analysis.compliance.plannedSessionId });
  }
  return matched;
}
