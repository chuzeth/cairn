import type { PlannedSession, SessionCompliance, SessionType, SportType } from '@cairn/core';

/**
 * Rattachement d'une activité à la séance prescrite.
 *
 * Une activité n'atteste pas d'une séance parce qu'elle tombe le bon jour. Le
 * rattachement compare ce qui a été fait à ce qui était prescrit, retient parmi
 * les séances du jour celle dont l'activité s'approche le plus, et a le droit de
 * n'en retenir aucune : une place déjà prise par une autre activité, une nage un
 * jour de seuil, une séance annulée ne sont pas des candidates.
 *
 * Rattacher n'est pas attester : la séance retenue peut avoir été *remplacée*
 * plutôt que réalisée. C'est `sessionOutcome` qui tranche, et le plan qui
 * l'enregistre — un « réalisé » posé sur une séance qui n'a pas eu lieu fait
 * perdre au coach le fil de ce qui s'est passé.
 */

/** Sports capables de réaliser une séance de course — la rando-course en fait partie. */
const RUN_LIKE: ReadonlySet<SportType> = new Set(['Run', 'TrailRun', 'VirtualRun', 'Hike', 'Walk']);

/** Séances qui n'attendent pas une activité de course. */
const NON_RUNNING_SESSIONS: ReadonlySet<SessionType> = new Set([
  'strength', 'mobility', 'cross_training', 'rest',
]);

/** Ce qu'une activité a réellement produit, réduit à ce dont le rattachement décide. */
export interface RealizedEffort {
  activityId: string;
  sportType: SportType;
  /** Temps en mouvement retenu par l'analyse, s. */
  durationS: number;
  /** Charge métabolique réalisée. */
  load: number;
}

/**
 * Écart forfaitaire appliqué quand la prescription est muette sur une grandeur
 * (un renforcement sans charge chiffrée). Zéro ferait gagner la séance la moins
 * spécifiée, ce qui est exactement l'inverse du but.
 */
const SILENT_PRESCRIPTION_GAP = 0.5;

/** Seuils au-delà desquels l'exécution ne réalise plus la séance : elle s'y substitue. */
export const MATERIAL_DEVIATION_PCT = { duration: 40, load: 50, intensity: 15 } as const;

/**
 * Une séance peut-elle recevoir cette activité ?
 *
 * `missed` reste éligible : les règles de charge constatent l'absence dès le
 * lendemain, alors qu'une activité peut n'arriver de Strava qu'ensuite. Refuser
 * la reprise laisserait la journée « manquée » alors qu'elle a été courue.
 *
 * `withdrawn` ne l'est pas : la séance a été retirée du plan par une absence
 * déclarée, et plus rien n'est prescrit ce jour-là. Une sortie faite pendant
 * une coupure est une sortie de plus, pas une prescription honorée — la
 * rattacher ferait remonter une conformité à un plan qui ne demandait rien.
 */
function isEligible(session: PlannedSession, realized: RealizedEffort): boolean {
  if (session.status === 'cancelled' || session.status === 'moved') return false;
  if (session.status === 'withdrawn') return false;
  // Une place déjà tenue par une *autre* activité ne se reprend pas : la première
  // sortie du jour garde sa séance, la seconde reste une sortie en plus.
  if (session.completedActivityId != null && session.completedActivityId !== realized.activityId) return false;
  return RUN_LIKE.has(realized.sportType) !== NON_RUNNING_SESSIONS.has(session.type);
}

const logGap = (actual: number, planned: number): number =>
  actual > 0 && planned > 0 ? Math.abs(Math.log(actual / planned)) : SILENT_PRESCRIPTION_GAP;

/**
 * Distance entre l'effort réalisé et la prescription, en écarts logarithmiques
 * de durée et de charge : un facteur deux pèse autant dans un sens que dans
 * l'autre, et aucune des deux grandeurs n'écrase l'autre.
 */
function divergence(session: PlannedSession, realized: RealizedEffort): number {
  return (
    logGap(realized.durationS, session.plannedDurationS) +
    logGap(realized.load, session.plannedLoad)
  );
}

/** La séance du jour que cette activité rattache, s'il y en a une. */
export function matchPlannedSession(
  candidates: readonly PlannedSession[],
  realized: RealizedEffort,
): PlannedSession | null {
  let best: PlannedSession | null = null;
  let bestScore = Infinity;
  for (const session of candidates) {
    if (!isEligible(session, realized)) continue;
    const score = divergence(session, realized);
    if (score < bestScore) {
      best = session;
      bestScore = score;
    }
  }
  return best;
}

/**
 * La séance prescrite a-t-elle eu lieu, ou une autre l'a-t-elle remplacée ?
 *
 * Les seuils sont bien plus larges que ceux du verdict de conformité, parce que
 * les deux questions sont distinctes : le verdict note l'exécution d'une séance
 * qui a eu lieu, l'issue dit si c'est bien celle-là qui a eu lieu. Une sortie de
 * 103 min à 134 points n'est pas un décrassage de 40 min mal exécuté.
 */
export function sessionOutcome(deviations: {
  loadPct: number;
  durationPct: number;
  intensityPct: number | null;
}): SessionCompliance['outcome'] {
  const { loadPct, durationPct, intensityPct } = deviations;
  const replaced =
    Math.abs(loadPct) > MATERIAL_DEVIATION_PCT.load ||
    Math.abs(durationPct) > MATERIAL_DEVIATION_PCT.duration ||
    (intensityPct != null && Math.abs(intensityPct) > MATERIAL_DEVIATION_PCT.intensity);
  return replaced ? 'replaced' : 'fulfilled';
}
