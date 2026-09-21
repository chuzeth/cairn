import type { PlannedSession } from '@cairn/core';
import { fingerprintOf, prescribe, type WatchWorkout } from './workout.js';

/**
 * Le réconciliateur : faire converger ce que Garmin porte vers ce que Cairn veut.
 *
 * L'état voulu, ce sont les séances des sept prochains jours. L'état réel, ce
 * que le calendrier Garmin porte, relu à chaque passage. Ce module ne parle à
 * personne : il reçoit les deux et rend la liste des opérations qui les
 * rapprochent. Tout ce qui touche au risque de se tromper de séance — ne rien
 * toucher de ce que Pierre a construit, ne rien toucher au passé — est décidé
 * ici, où chaque cas se teste sans réseau.
 *
 * Deux règles le tiennent. Il ne voit que les séances que Cairn a créées : son
 * registre les identifie par leur numéro Garmin, et une séance absente du
 * registre n'existe pas pour lui, quel que soit son nom. Et une date antérieure
 * à aujourd'hui n'est jamais modifiée, ni une journée dont la séance est déjà
 * faite.
 */

/** Statuts d'une séance qu'on attend encore — les mêmes que la projection de forme. */
const STANDING = new Set<PlannedSession['status']>(['planned', 'moved']);
/** Une séance faite, ou en train de l'être : sa journée appartient à l'historique. */
const DONE = new Set<PlannedSession['status']>(['completed', 'partial', 'replaced']);

/** Nombre de jours que l'état voulu couvre, aujourd'hui compris. */
export const HORIZON_DAYS = 7;

export interface DesiredWorkout {
  sessionId: string;
  date: string;
  workout: WatchWorkout;
  fingerprint: string;
  /** Ce que Garmin ne pouvait pas porter en entier (`prescribe`). */
  abridged: string[];
}

export interface UnsentSession {
  sessionId: string;
  date: string;
  reason: string;
}

export interface DesiredState {
  today: string;
  /** Dernier jour couvert, inclus. */
  horizon: string;
  desired: DesiredWorkout[];
  /** Jours dont une séance est faite : rien n'y est touché. */
  frozen: string[];
  /** Séances attendues que la montre ne recevra pas, et pourquoi. */
  unsent: UnsentSession[];
  /** Résumé de l'état voulu : il change dès qu'une séance à envoyer change. */
  signature: string;
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Ce que Garmin doit porter, lu sur les séances du plan de `today` à `today + 6`. */
export function desiredState(sessions: readonly PlannedSession[], today: string): DesiredState {
  const horizon = addDays(today, HORIZON_DAYS - 1);
  const inWindow = sessions.filter((s) => s.date >= today && s.date <= horizon);
  const frozen = [...new Set(inWindow.filter((s) => DONE.has(s.status)).map((s) => s.date))].sort();
  const desired: DesiredWorkout[] = [];
  const unsent: UnsentSession[] = [];
  for (const s of inWindow) {
    if (!STANDING.has(s.status) || frozen.includes(s.date)) continue;
    const p = prescribe(s);
    if (!p.sendable) {
      if (s.type !== 'rest') unsent.push({ sessionId: s.id, date: s.date, reason: p.reason });
      continue;
    }
    desired.push({
      sessionId: s.id, date: s.date, workout: p.workout, fingerprint: fingerprintOf(s.date, p.workout), abridged: p.abridged,
    });
  }
  desired.sort((a, b) => a.date.localeCompare(b.date) || a.fingerprint.localeCompare(b.fingerprint));
  const signature = fingerprintKey([today, frozen, desired.map((d) => [d.date, d.fingerprint])]);
  return { today, horizon, desired, frozen, unsent, signature };
}

const fingerprintKey = (value: unknown) => JSON.stringify(value);

// ─────────────────────────────────────────────────────────────────────────────
// Registre et calendrier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sending` : créée sur Garmin, pas encore relue. `verified` et `mismatch` : relue,
 * conforme ou non. `deleted` : retirée de Garmin — une ligne d'historique.
 */
export type LedgerState = 'sending' | 'verified' | 'mismatch' | 'deleted';

/** Une séance que Cairn a créée sur Garmin. */
export interface LedgerEntry {
  workoutId: number;
  scheduleId: number | null;
  sessionId: string;
  date: string;
  fingerprint: string;
  name: string;
  state: LedgerState;
  discrepancies: string[] | null;
  sentAt: string | null;
  verifiedAt: string | null;
  deletedAt: string | null;
}

/** Une séance planifiée sur le calendrier Garmin, qu'elle soit de Cairn ou non. */
export interface CalendarWorkout {
  scheduleId: number;
  workoutId: number | null;
  date: string;
  title: string;
}

export type Operation =
  /** Retirer une séance de Cairn : la séance elle-même, ou seulement certaines de ses planifications. */
  | { op: 'remove'; entry: LedgerEntry; scheduleIds: number[]; deleteWorkout: boolean; reason: string }
  | { op: 'create'; desired: DesiredWorkout }
  /** Déjà en place ; relue si elle ne l'a jamais été. */
  | { op: 'keep'; entry: LedgerEntry; desired: DesiredWorkout; verify: boolean };

export interface ReconcileInput {
  state: Pick<DesiredState, 'today' | 'horizon' | 'desired' | 'frozen'>;
  ledger: readonly LedgerEntry[];
  calendar: readonly CalendarWorkout[];
}

/**
 * Les opérations qui amènent le calendrier Garmin sur l'état voulu.
 *
 * Par jour de la fenêtre, chaque séance voulue cherche parmi les séances de
 * Cairn planifiées ce jour-là une empreinte identique : trouvée, elle reste ;
 * absente, elle se crée. Ce qui reste de Cairn ce jour-là sans séance voulue en
 * face se retire. Les retraits viennent avant les créations : entre les deux,
 * la montre peut n'avoir rien pour ce jour, jamais deux versions dont une
 * fausse.
 */
export function planReconciliation({ state, ledger, calendar }: ReconcileInput): Operation[] {
  const { today, horizon } = state;
  const frozen = new Set(state.frozen);
  const touchable = (date: string) => date >= today && date <= horizon && !frozen.has(date);

  const ours = new Map(ledger.filter((e) => e.state !== 'deleted').map((e) => [e.workoutId, e]));
  const placements = new Map<number, CalendarWorkout[]>();
  // Une planification ne compte qu'une fois, quel que soit le nombre de fois
  // que Garmin la renvoie : son doublon passerait pour une planification en
  // trop, et la séance serait retirée.
  const seen = new Set<number>();
  for (const item of calendar) {
    if (seen.has(item.scheduleId)) continue;
    seen.add(item.scheduleId);
    if (item.workoutId == null || !ours.has(item.workoutId)) continue;
    placements.set(item.workoutId, [...(placements.get(item.workoutId) ?? []), item]);
  }

  const creates: Operation[] = [];
  const keeps: Operation[] = [];
  /** Planifications de Cairn que rien ne réclame, par séance Garmin. */
  const stale = new Map<number, number[]>();

  const dates = new Set([
    ...state.desired.map((d) => d.date),
    ...[...placements.values()].flat().map((p) => p.date),
  ]);
  for (const date of [...dates].sort()) {
    if (!touchable(date)) continue;
    const present = [...placements.entries()].flatMap(([workoutId, list]) =>
      list.filter((p) => p.date === date).map((p) => ({ entry: ours.get(workoutId)!, scheduleId: p.scheduleId })),
    );
    const claimed = new Set<number>();
    for (const d of state.desired.filter((x) => x.date === date)) {
      const i = present.findIndex((p, k) => !claimed.has(k) && p.entry.fingerprint === d.fingerprint);
      if (i >= 0) {
        claimed.add(i);
        keeps.push({ op: 'keep', entry: present[i]!.entry, desired: d, verify: present[i]!.entry.state === 'sending' });
      } else {
        creates.push({ op: 'create', desired: d });
      }
    }
    present.forEach((p, k) => {
      if (claimed.has(k)) return;
      stale.set(p.entry.workoutId, [...(stale.get(p.entry.workoutId) ?? []), p.scheduleId]);
    });
  }

  const removes: Operation[] = [];
  for (const [workoutId, scheduleIds] of stale) {
    const entry = ours.get(workoutId)!;
    // Une séance planifiée aussi dans le passé ou sur une journée faite garde sa
    // trace : on ne retire que la planification périmée, pas la séance.
    const kept = (placements.get(workoutId) ?? []).filter((p) => !scheduleIds.includes(p.scheduleId));
    removes.push({
      op: 'remove',
      entry,
      scheduleIds,
      deleteWorkout: kept.length === 0,
      reason: 'plus prévue ce jour-là dans le plan',
    });
  }
  // Une séance de Cairn que le calendrier ne porte plus nulle part : retirée de
  // Garmin à la main, ou jamais planifiée. Elle se nettoie — sauf si sa journée
  // est passée ou faite.
  for (const entry of ours.values()) {
    if (placements.has(entry.workoutId) || !touchable(entry.date)) continue;
    removes.push({ op: 'remove', entry, scheduleIds: [], deleteWorkout: true, reason: 'absente du calendrier Garmin' });
  }

  return [...removes, ...creates, ...keeps];
}

/** Mois de calendrier (année, mois de 0 à 11) qui couvrent la fenêtre — un ou deux appels. */
export function monthsOf(today: string, horizon: string): { year: number; month: number }[] {
  const months: { year: number; month: number }[] = [];
  for (let d = today; d <= horizon; d = addDays(d, 1)) {
    const year = Number(d.slice(0, 4));
    const month = Number(d.slice(5, 7)) - 1;
    if (!months.some((m) => m.year === year && m.month === month)) months.push({ year, month });
  }
  return months;
}
