import type {
  PhysiologyModel, PlannedSession, SessionBlock, SessionCompliance, SessionType, SportType,
} from '@cairn/core';
import { isAnnex, recoveryTimes } from '@cairn/core';
import { CS_FIT_MIN_S } from './criticalSpeed.js';
import { checkHrCeiling, isEasyZone, type CeilingCheck, type HrHistogram } from './easy.js';

/**
 * Rattachement d'une activité à la séance prescrite.
 *
 * Une activité n'atteste pas d'une séance parce qu'elle tombe le bon jour. Le
 * rattachement compare ce qui a été fait à ce qui était prescrit, retient parmi
 * les séances du jour celle dont l'activité s'approche le plus, et a le droit de
 * n'en retenir aucune : une place déjà prise par une autre activité, une nage un
 * jour de seuil, une séance annulée ne sont pas des candidates.
 *
 * Elle ne tombe pas non plus forcément le bon jour : décaler une séance d'un
 * jour sans prévenir est la norme, pas l'exception. Une séance de la veille ou
 * du lendemain est donc candidate, quand aucune séance du jour ne correspond
 * mieux à l'activité et que l'activité la réalise — au sens de `sessionOutcome`,
 * le même qu'une séance de son jour. Une séance d'un autre jour n'est jamais
 * « remplacée » : elle a eu lieu, ou elle reste à sa place.
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
  /** Jour local de l'activité : il dit quelles séances sont de son jour, de la veille ou du lendemain. */
  date: string;
  /** Temps en mouvement retenu par l'analyse, s. */
  durationS: number;
  /** Charge métabolique réalisée. */
  load: number;
  /** Vitesse graduée moyenne des blocs d'effort détectés, m/s. `null` sans bloc. */
  blockSpeedMs?: number | null;
  /**
   * FC moyenne du meilleur effort, par durée (s) — la contrepartie cardiaque de
   * la courbe des vitesses. C'est elle qui dit si l'effort d'un test a été maximal.
   */
  bestEffortHr?: Record<string, number>;
  /**
   * Secondes de mouvement passées à chaque FC : ce qui dit si un plafond a été
   * tenu. Absent quand la FC couvre trop peu de la sortie pour en juger.
   */
  hrSeconds?: HrHistogram;
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
 * Ce que la séance prescrit de courir, s : sa durée sans ce qui s'y ajoute.
 *
 * Une activité ne porte que la course. « Décrassage 45 min + souplesse et
 * respiration 20 min » comparé à 65 minutes faisait d'un décrassage couru
 * 45 minutes une séance écourtée d'un tiers, et d'un footing suivi de son
 * renforcement une séance remplacée. Sans blocs, la durée enregistrée.
 */
export function runDurationOf(session: Pick<PlannedSession, 'blocks' | 'plannedDurationS'>): number {
  if (session.blocks.length === 0) return session.plannedDurationS;
  return session.blocks
    .filter((b) => !isAnnex(b))
    .reduce(
      (a, b) => a + (b.repeat ?? 1) * (b.durationS ?? 0) + recoveryTimes(b) * (b.recovery?.durationS ?? 0),
      0,
    );
}

/**
 * Distance entre l'effort réalisé et la prescription, en écarts logarithmiques
 * de durée et de charge : un facteur deux pèse autant dans un sens que dans
 * l'autre, et aucune des deux grandeurs n'écrase l'autre.
 */
function divergence(session: PlannedSession, realized: RealizedEffort): number {
  return (
    logGap(realized.durationS, runDurationOf(session)) +
    logGap(realized.load, session.plannedLoad)
  );
}

const dayGap = (a: string, b: string): number =>
  Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

/**
 * La séance que cette activité rattache, s'il y en a une.
 *
 * Une séance que l'activité tient déjà reste la sienne : refaire le
 * rattachement — une ré-analyse, la passe des sept derniers jours — ne défait
 * jamais un rattachement existant. Sinon, la séance du jour la plus proche de
 * ce qui a été fait ; une séance de la veille ou du lendemain ne la déloge que
 * si l'activité la réalise, et s'en approche strictement davantage.
 */
export function matchPlannedSession(
  candidates: readonly PlannedSession[],
  realized: RealizedEffort,
  model: Pick<PhysiologyModel, 'vt2'>,
): PlannedSession | null {
  const eligible = candidates.filter((s) => isEligible(s, realized));
  const held = eligible.find((s) => s.completedActivityId === realized.activityId);
  if (held) return held;

  const sameDay = eligible.filter((s) => s.date === realized.date);
  // Une prescription muette sur sa durée — un repos — ne peut rien attester à
  // un jour d'écart : il faut que l'activité ait de quoi la réaliser.
  const neighbours = eligible.filter(
    (s) =>
      dayGap(s.date, realized.date) === 1 &&
      s.plannedDurationS > 0 &&
      outcomeOf(s, realized, model) === 'fulfilled',
  );

  let best: PlannedSession | null = null;
  let bestScore = Infinity;
  for (const session of [...sameDay, ...neighbours]) {
    const score = divergence(session, realized);
    if (score < bestScore) {
      best = session;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Le bloc qui fait d'une séance un test maximal, ou −1 : un effort d'un seul
 * tenant — ni répété, ni coupé de récupérations —, prescrit au-delà du seuil 2,
 * et assez long pour entrer dans l'ajustement de la vitesse critique.
 *
 * C'est la signature de la preuve d'effort maximal du modèle, lue sur ce qu'on
 * demande à l'athlète. Une seule lecture : le planificateur qui entoure le test
 * de repos et le rattachement qui dit s'il a eu lieu lisent le même bloc.
 */
export function maximalEffortIndex(blocks: readonly SessionBlock[], model: Pick<PhysiologyModel, 'vt2'>): number {
  return blocks.findIndex(
    (b) =>
      !b.kind &&
      !b.circuit &&
      (b.repeat ?? 1) <= 1 &&
      !b.recovery &&
      (b.durationS ?? 0) >= CS_FIT_MIN_S &&
      (b.zone === 'Z5' || (b.hrRange != null && b.hrRange[0] >= model.vt2.hr)),
  );
}

/**
 * Ce qu'un test maximal demande à l'activité, et si elle l'a produit. `null`
 * quand la séance n'est pas un test.
 *
 * Le critère est celui de la preuve d'effort maximal du modèle : le meilleur
 * effort de l'activité sur la durée du test s'est tenu, en moyenne, à la FC du
 * seuil 2 au moins. Sans FC, rien n'est prouvé.
 */
export function maximalTestProof(
  session: Pick<PlannedSession, 'blocks'>,
  realized: RealizedEffort,
  model: Pick<PhysiologyModel, 'vt2'>,
): { effortS: number; hr: number | null; proven: boolean } | null {
  const i = maximalEffortIndex(session.blocks, model);
  if (i < 0) return null;
  const effortS = session.blocks[i]!.durationS ?? 0;
  const hr = realized.bestEffortHr?.[String(effortS)] ?? null;
  return { effortS, hr, proven: hr != null && model.vt2.hr > 0 && hr >= model.vt2.hr };
}

export interface SessionDeviations {
  loadPct: number;
  /** Écart à la durée de course prescrite (`runDurationOf`). */
  durationPct: number;
  /** `null` quand la prescription ne cible pas d'allure, ou qu'aucun bloc n'a été détecté. */
  intensityPct: number | null;
}

/**
 * Écarts entre ce qui a été fait et ce qui était prescrit, en %. L'intensité
 * compare la vitesse graduée des blocs détectés à la cible du premier bloc de
 * travail prescrit.
 */
export function deviationsFrom(session: PlannedSession, realized: RealizedEffort): SessionDeviations {
  const pct = (actual: number, planned: number) => (planned > 0 ? ((actual - planned) / planned) * 100 : 0);
  const target = session.blocks.find((b) => b.speedRangeMs && b.zone !== 'Z1' && b.zone !== 'Z2');
  let intensityPct: number | null = null;
  if (target?.speedRangeMs && realized.blockSpeedMs != null) {
    const mid = (target.speedRangeMs[0] + target.speedRangeMs[1]) / 2;
    if (mid > 0) intensityPct = pct(realized.blockSpeedMs, mid);
  }
  return {
    loadPct: pct(realized.load, session.plannedLoad),
    durationPct: pct(realized.durationS, runDurationOf(session)),
    intensityPct,
  };
}

/**
 * Le plafond de FC d'une séance qui ne prescrit que lui et une durée — un
 * décrassage, un footing, un footing prolongé —, ou `null`.
 *
 * Lu sur le contenu : tout ce qui s'y court est un bloc continu de zone facile,
 * sans répétition, sans consigne d'effort ni vitesse ascensionnelle, et porte sa
 * plage de FC. Une rando-course n'en est pas une : elle prescrit aussi son
 * dénivelé.
 */
export function hrCeilingOf(session: Pick<PlannedSession, 'type' | 'blocks'>): number | null {
  if (session.type === 'long_trail') return null;
  const run = session.blocks.filter((b) => !isAnnex(b) && (b.durationS ?? 0) > 0);
  const steadyEasy = (b: SessionBlock) =>
    isEasyZone(b.zone) && b.hrRange != null && !b.effort && !b.recovery && (b.repeat ?? 1) <= 1 &&
    b.vamTargetMh == null;
  if (run.length === 0 || !run.every(steadyEasy)) return null;
  return Math.max(...run.map((b) => (b.hrRange as [number, number])[1]));
}

/**
 * Le plafond d'une séance facile, confronté à la FC de l'activité. `null` quand
 * la séance n'en prescrit pas, ou que la FC manque pour en juger.
 */
export function ceilingCheckOf(
  session: Pick<PlannedSession, 'type' | 'blocks'>,
  realized: RealizedEffort,
): CeilingCheck | null {
  const ceiling = hrCeilingOf(session);
  return ceiling != null && realized.hrSeconds ? checkHrCeiling(realized.hrSeconds, ceiling) : null;
}

/** La séance a-t-elle eu lieu, lue sur ce que cette activité a produit. */
export function outcomeOf(
  session: PlannedSession,
  realized: RealizedEffort,
  model: Pick<PhysiologyModel, 'vt2'>,
): SessionCompliance['outcome'] {
  const test = maximalTestProof(session, realized, model);
  return sessionOutcome(
    deviationsFrom(session, realized),
    test ?? undefined,
    ceilingCheckOf(session, realized) ?? undefined,
  );
}

/**
 * La séance prescrite a-t-elle eu lieu, ou une autre l'a-t-elle remplacée ?
 *
 * Les seuils sont bien plus larges que ceux du verdict de conformité, parce que
 * les deux questions sont distinctes : le verdict note l'exécution d'une séance
 * qui a eu lieu, l'issue dit si c'est bien celle-là qui a eu lieu. Une sortie de
 * 103 min à 134 points n'est pas un décrassage de 40 min mal exécuté.
 *
 * Un test maximal a eu lieu si son effort maximal a eu lieu. Sa charge et son
 * allure ne sont pas des consignes mais des résultats : un échauffement couru
 * plus vite, une vitesse critique sous-estimée les font dévier sans que le test
 * cesse d'être le test — et une sortie de même durée et de même charge, sans
 * effort maximal, n'en est pas un.
 *
 * Une séance facile a eu lieu si son plafond de FC a été tenu, sur sa durée.
 * Sa charge n'est pas davantage une consigne : c'est une estimation, et le
 * décrassage du 22/09, couru à 133 bpm pour un plafond de 141, a été déclaré
 * remplacé parce qu'elle était fausse.
 */
export function sessionOutcome(
  deviations: SessionDeviations,
  maximalTest?: { proven: boolean },
  ceiling?: { respected: boolean },
): SessionCompliance['outcome'] {
  const { loadPct, durationPct, intensityPct } = deviations;
  if (Math.abs(durationPct) > MATERIAL_DEVIATION_PCT.duration) return 'replaced';
  if (maximalTest) return maximalTest.proven ? 'fulfilled' : 'replaced';
  if (ceiling) return ceiling.respected ? 'fulfilled' : 'replaced';
  const replaced =
    Math.abs(loadPct) > MATERIAL_DEVIATION_PCT.load ||
    (intensityPct != null && Math.abs(intensityPct) > MATERIAL_DEVIATION_PCT.intensity);
  return replaced ? 'replaced' : 'fulfilled';
}
