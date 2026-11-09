import type { Activity, PhysiologyModel, PlannedSession, SportType } from '@cairn/core';
import { isRunFree, spikesAlong, type RunDistance, type SpikeVerdict } from '@cairn/physiology';
import { sessionTotals } from './sessionLibrary.js';

/**
 * Les pics de séance du plan (`@cairn/physiology`, `spike.ts`), sur ce qui a
 * été couru et ce qui est prévu.
 *
 * La distance prévue est celle que la séance écrit, sinon celle que ses blocs
 * parcourent à leurs allures ; la distance réalisée, celle de l'activité — la
 * marche d'une course-marche comprise, comme dans l'étude, qui lisait la
 * distance du GPS.
 */

/** Sous ce nombre de sorties en trente jours, la plus longue ne dit pas ce que les tissus tolèrent. */
export const SPIKE_MIN_RUNS = 3;

const RUNS: ReadonlySet<SportType> = new Set(['Run', 'TrailRun', 'VirtualRun']);

export interface PlanSpike extends SpikeVerdict {
  id: string;
  date: string;
  distanceM: number;
}

const live = (s: PlannedSession) => s.status === 'planned' || s.status === 'moved';

/** Les courses faites, en distance. */
export function runDistancesOf(activities: readonly Activity[]): RunDistance[] {
  return activities
    .filter((a) => RUNS.has(a.sportType) && a.distanceM > 0)
    .map((a) => ({ date: a.startDateLocal.slice(0, 10), distanceM: a.distanceM }));
}

/** Combien de courses dans les `window` jours avant `today`. */
export function doneRunsWithin(activities: readonly Activity[], today: string, window: number): number {
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - window * 86_400_000).toISOString().slice(0, 10);
  return runDistancesOf(activities).filter((r) => r.date >= from && r.date < today).length;
}

/** La distance qu'une séance prévue fait courir. */
export function plannedRunDistance(s: Pick<PlannedSession, 'plannedDistanceM' | 'blocks'>, model: PhysiologyModel): number {
  if (s.plannedDistanceM && s.plannedDistanceM > 0) return s.plannedDistanceM;
  return Math.round(sessionTotals(model, [...s.blocks]).distanceM);
}

/** Le pic de chaque course prévue à partir d'aujourd'hui. */
export function planSpikes(
  model: PhysiologyModel,
  sessions: readonly PlannedSession[],
  activities: readonly Activity[],
  today: string,
): PlanSpike[] {
  const planned = sessions
    .filter((s) => live(s) && s.date >= today && s.type !== 'rest' && !isRunFree(s.type))
    .map((s) => ({ id: s.id, date: s.date, distanceM: plannedRunDistance(s, model) }))
    .filter((p) => p.distanceM > 0);
  return spikesAlong(runDistancesOf(activities), planned);
}

const km = (m: number) => (m / 1000).toFixed(1).replace('.', ',');
const dm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** « +55 % sur ta plus longue sortie des 30 jours (8,5 km le 19/11) ». */
export function describeSpike(v: SpikeVerdict): string {
  if (v.cls === 'no_reference' || v.ratio == null) return 'aucune course dans les 30 jours d\'avant : rien à quoi la comparer';
  const sign = v.ratio >= 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(v.ratio) * 100)} % sur ta plus longue sortie des 30 jours d'avant (${km(v.referenceM!)} km le ${dm(v.referenceDate!)})`;
}
