import type { Activity, ActivityAnalysis, AthleteAnswer, PhysiologyModel, PlannedSession, PmcSeries } from '@cairn/core';
import * as db from '@cairn/db';
import { buildPmcSeries, modelFromLabOnly, type DebriefRun, type SessionDebrief } from '@cairn/physiology';
import { debriefRun, isRunActivity, referenceGapFor } from './debriefs.js';
import { addDays } from './periodization.js';
import { realizedLoads } from './state.js';
import { airTemperatureOf, knownAirTemperatures } from './weather.js';

/**
 * Le compte rendu d'une sortie, tel que l'écran, le coach et les règles le
 * lisent.
 *
 * `debriefSession` (`@cairn/physiology`) est pur : il reçoit l'historique, la
 * séance prévue, ce que l'athlète a dit, la charge du matin. Ce module va les
 * chercher. Il n'écrit rien : le compte rendu se recalcule à chaque lecture,
 * et une sortie arrivée après lui ne change pas ce qu'il dit — il ne lit que
 * ce qui précède.
 */

/** Les six mois d'avant : de quoi trouver la meilleure forme, la tendance et le bruit. */
const HISTORY_DAYS = 200;

export interface DebriefSources {
  activity: Activity;
  analysis: ActivityAnalysis | null;
  history: DebriefRun[];
  model: PhysiologyModel;
  referenceGapMs: number;
  planned: PlannedSession | null;
  answers: AthleteAnswer[];
  pmc: PmcSeries;
}

/** Tout ce que le compte rendu d'une sortie lit, allé chercher en base. */
export async function debriefSources(athleteId: string, activityId: string): Promise<DebriefSources | null> {
  const activity = await db.getActivity(activityId);
  if (!activity) return null;
  const profile = await db.getAthlete(athleteId);
  if (!profile) return null;
  const date = activity.startDateLocal.slice(0, 10);
  const model =
    (await db.getLatestModel(athleteId)) ??
    (profile.labTests[0] ? modelFromLabOnly(profile.labTests[0], date) : null);
  if (!model) return null;

  const activities = await db.listActivities(athleteId, { from: addDays(date, -HISTORY_DAYS), to: addDays(date, 1), limit: 400 });
  const analyses = await db.getAnalyses(activities.map((a) => a.id));
  const temps = await knownAirTemperatures(activities.map((a) => a.id));
  const history = activities.map((a) => ({ activity: a, analysis: analyses.get(a.id) ?? null, airTempC: temps.get(a.id) ?? null }));
  const analysis = analyses.get(activity.id) ?? (await db.getAnalysis(activity.id));

  const nearby = await db.listPlannedSessions(athleteId, addDays(date, -1), addDays(date, 1));
  const planned =
    nearby.find((s) => s.completedActivityId === activity.id) ??
    (analysis?.compliance ? nearby.find((s) => s.id === analysis.compliance!.plannedSessionId) : undefined) ??
    null;
  const answers = await db.listAnswers(athleteId, `${addDays(date, -1)}T00:00:00.000Z`);

  // La charge jusqu'à la veille au soir : le matin de la sortie.
  const eve = addDays(date, -1);
  const realized = await realizedLoads(athleteId, addDays(date, -400), eve);
  const pmc = buildPmcSeries(realized.loads, realized.loads[0]?.date ?? addDays(date, -90), eve);

  return { activity, analysis, history, model, referenceGapMs: referenceGapFor(profile, model), planned, answers, pmc };
}

/** Le compte rendu, à partir de ce qui a été allé chercher. */
export function debriefFrom(sources: DebriefSources): SessionDebrief {
  const { activity, analysis, history, model, referenceGapMs, planned, answers, pmc } = sources;
  const airTempC = history.find((h) => h.activity.id === activity.id)?.airTempC ?? null;
  return debriefRun({ activity, analysis, airTempC }, {
    history, model, referenceGapMs, sessions: planned ? [planned] : [], answers, pmc,
  });
}

/** Le compte rendu d'une sortie, ou rien si elle n'existe pas. */
export async function debriefActivity(athleteId: string, activityId: string): Promise<SessionDebrief | null> {
  const sources = await debriefSources(athleteId, activityId);
  return sources ? debriefFrom(sources) : null;
}

/**
 * Les comptes rendus des courses des `days` derniers jours, la plus récente
 * d'abord : ce que les règles lisent pour la suite — la récupération que
 * demande la dernière sortie, la réponse du cœur à allure égale.
 */
export async function recentDebriefs(athleteId: string, today: string, days = 4): Promise<SessionDebrief[]> {
  const recent = await db.listActivities(athleteId, { from: addDays(today, -days), to: addDays(today, 1), limit: 20 });
  const runs = recent
    .filter(isRunActivity)
    .sort((a, b) => b.startDateLocal.localeCompare(a.startDateLocal));
  const out: SessionDebrief[] = [];
  for (const a of runs) {
    const d = await debriefActivity(athleteId, a.id);
    if (d) out.push(d);
  }
  return out;
}
