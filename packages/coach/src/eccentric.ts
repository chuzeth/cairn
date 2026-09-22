import type { PlannedSession, SessionType } from '@cairn/core';
import { writtenOn } from '@cairn/core';
import { addDays } from './periodization.js';
import { carriesEccentricStrength, eccentricRoundsOf } from './sessionLibrary.js';

/**
 * Le renforcement excentrique dans la semaine : où il se place, et combien.
 *
 * Un premier travail excentrique produit des courbatures qui culminent 24 à
 * 72 h après ; l'effet de la répétition protège dès la séance suivante, pas
 * celle-là. D'où deux règles :
 *
 *  · aucun circuit excentrique dans les 48 h qui précèdent une sortie longue,
 *    une rando-course, une séance de descente ou une course — ni la veille, ni
 *    l'avant-veille ;
 *  · un athlète sans historique commence petit : un tour pour ses deux premiers
 *    circuits, deux pour les deux suivants, puis les trois du dossier.
 *
 * Elles vivent ici pour que le planificateur et les règles de charge
 * (`adapt.ts`) répondent la même chose au même plan. Module pur.
 */

/** Ce qu'un circuit excentrique ne précède pas de moins de 48 h, et comment le nommer. */
const DESCENDING: Partial<Record<SessionType, string>> = {
  long_run: 'la sortie longue',
  long_trail: 'la rando-course',
  downhill: 'la séance de descente',
  race: 'la course',
};

/** Jours avant une séance qui descend où aucun circuit ne se place : la veille et l'avant-veille. */
const CLEARANCE_DAYS = 2;

/** Tours du circuit selon le nombre de circuits excentriques faits avant lui. */
const ROUNDS_BY_RANK = [1, 1, 2, 2];
export const FULL_ECCENTRIC_ROUNDS = 3;

export const eccentricRoundsFor = (done: number): number => ROUNDS_BY_RANK[done] ?? FULL_ECCENTRIC_ROUNDS;

type Dated = { date: string; type: SessionType };

/** Une séance qui aura lieu : à faire, ou déplacée. */
const standing = (s: Pick<PlannedSession, 'status'>) => s.status === 'planned' || s.status === 'moved';

/** La première séance qui descend dans les `days` jours qui suivent `date` — 48 h par défaut. */
export function descentAfter<T extends Dated>(
  date: string,
  sessions: Iterable<T>,
  days: number = CLEARANCE_DAYS,
): T | undefined {
  const last = addDays(date, days);
  let found: T | undefined;
  for (const s of sessions) {
    if (!(s.type in DESCENDING) || s.date <= date || s.date > last) continue;
    if (!found || s.date < found.date) found = s;
  }
  return found;
}

/** « la rando-course du 27/09 ». */
export const nameDescent = (s: Dated): string => `${DESCENDING[s.type] ?? 'la séance'} du ${writtenOn(s.date)}`;

const ORDINALS = ['premier', 'deuxième', 'troisième', 'quatrième'];

export interface EccentricVerdict {
  session: PlannedSession;
  /** La séance qui descend dans les 48 h : le circuit n'a pas sa place ce jour-là. */
  before?: Dated;
  /** Rang du circuit : les circuits faits, ou prévus et maintenus, avant lui. */
  rank: number;
  /** Tours que le circuit prescrit, et ceux que son rang autorise. */
  prescribed: number;
  allowed: number;
}

/**
 * Ce que les deux règles disent de chaque circuit excentrique à venir.
 *
 * Les circuits se comptent dans l'ordre des dates : ceux que l'athlète a faits
 * (`done`), puis ceux qui le précèdent dans le plan et que rien n'empêche. Un
 * circuit qu'une descente chasse ne compte pas — il n'aura pas lieu —, et un
 * circuit ramené à un tour compte comme une séance faite : c'est le nombre de
 * séances qui protège, pas celui des tours. `descents` ajoute ce qui descend
 * sans être une séance du plan, la course.
 */
export function eccentricVerdicts(
  sessions: readonly PlannedSession[],
  done: number,
  today: string,
  descents: readonly Dated[] = [],
): EccentricVerdict[] {
  const ahead = sessions
    .filter((s) => standing(s) && s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const descending = [...ahead, ...descents];
  const out: EccentricVerdict[] = [];
  let rank = done;
  for (const s of ahead) {
    if (!carriesEccentricStrength(s.blocks)) continue;
    const before = descentAfter(s.date, descending);
    out.push({
      session: s,
      ...(before ? { before } : {}),
      rank,
      prescribed: eccentricRoundsOf(s.blocks),
      allowed: eccentricRoundsFor(rank),
    });
    if (!before) rank++;
  }
  return out;
}

/** Pourquoi un circuit n'a pas sa place ce jour-là — une suite de phrase, après deux points. */
export const descentReason = (before: Dated): string =>
  `${nameDescent(before)} suit de moins de 48 h, et les courbatures d'un circuit excentrique ` +
  `culminent 24 à 72 h après — pendant ses descentes.`;

/** Pourquoi un circuit porte moins de tours que le dossier — une suite de phrase, après deux points. */
export const progressionReason = (rank: number): string =>
  `${ORDINALS[rank] ?? `${rank + 1}e`} circuit excentrique, et un premier travail de ce type donne des ` +
  `courbatures qui culminent 24 à 72 h après. La répétition protège dès la séance suivante : un tour de plus ` +
  `toutes les deux séances, jusqu'aux ${FULL_ECCENTRIC_ROUNDS} du dossier.`;

/** Jours où culminent les courbatures d'une première exposition : jusqu'à 72 h après. */
const SORENESS_DAYS = 3;

/**
 * Ce qu'une première séance de descente doit dire à l'athlète : la consigne est
 * « vite mais maîtrisé », et pour une première exposition, c'est « maîtrisé »
 * qui l'emporte — les courbatures culminent 24 à 72 h après, et la séance qui
 * descend dans cet intervalle les porterait. `sessions` est le plan autour
 * d'elle ; une séance qui ne tiendra pas n'y compte pas.
 */
export function firstDescentNote(date: string, sessions: Iterable<Dated & Pick<PlannedSession, 'status'>>): string {
  const next = descentAfter(date, [...sessions].filter(standing), SORENESS_DAYS);
  return (
    `Première séance de descente : « maîtrisé » l'emporte sur « vite » — ses courbatures culmineront 24 à 72 h ` +
    `après${next ? `, pendant ${nameDescent(next)}` : ''}.`
  );
}

/** « 1 tour », « 2 tours ». */
export const roundsLabel = (n: number): string => `${n} tour${n > 1 ? 's' : ''}`;
