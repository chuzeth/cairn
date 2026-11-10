import type { Activity, PlanRevision, PlannedSession } from '@cairn/core';
import { sessionDuration } from '@cairn/core';
import { runDurationOf } from '@cairn/physiology';
import { firstSentence } from './presentation.js';
import type { Question } from './questions.js';
import { formatOf } from './sessionLibrary.js';

/**
 * Ce que Cairn dit au téléphone sans qu'on l'ouvre, et quand.
 *
 * Le 10/11, Pierre : « j'ouvre mon ordinateur, il faut que l'application, même
 * si je ne l'ouvre pas sur mon téléphone, puisse se synchroniser. » Le
 * téléphone sert quand le Mac dort, et une app web ne se réveille pas seule :
 * la seule chose qui l'atteigne fermée est une notification. Chaque fois que le
 * Mac a du neuf — il vient de se réveiller, une sortie est arrivée de Strava,
 * les règles ont réécrit une séance, une question attend —, il en envoie une, et
 * le téléphone en profite pour tout relire et envoyer ce qu'il gardait
 * (`apps/web/public/sw.js`).
 *
 * iOS exige que chaque envoi se voie : pas de synchronisation muette. Une
 * notification doit donc mériter d'être lue. Ce module décide laquelle, et
 * n'en propose aucune quand rien de ce qu'elle dirait n'a changé — ni la nuit.
 */

export interface DeviceNotice {
  kind: 'question' | 'activity' | 'plan' | 'day';
  title: string;
  body: string;
  /** Ce que la notification décrit, partie par partie : la même ne part pas deux fois. */
  digest: string;
}

/** Ce qu'une notification décrit ; ce qui a changé depuis la précédente décide de ce qu'elle dit. */
interface Parts {
  /** Le jour. */
  d: string;
  /** La séance du jour : son identité, son contenu, son statut. */
  s: string;
  /** Les questions qui attendent. */
  q: string;
  /** La dernière sortie arrivée. */
  a: string;
  /** La dernière réécriture du plan par les règles. */
  r: string;
}

/** Les heures où rien ne part : une notification à 3 h du matin n'est pas une synchronisation, c'est un réveil. */
export const QUIET = { from: 22.5, to: 6.5 } as const;

/** L'écart minimal entre deux notifications, ms : une relève qui en déclenche trois n'en envoie qu'une. */
export const NOTICE_GAP_MS = 10 * 60_000;

const live = (s: PlannedSession) => s.status !== 'cancelled' && s.status !== 'withdrawn';
const DONE = new Set(['completed', 'replaced', 'partial']);
const km = (m: number) => (m / 1000).toFixed(1).replace('.', ',');
/**
 * Ce qu'un écran verrouillé montre d'une notification : quatre lignes environ.
 * Trop longue, elle perd ses dernières phrases, entières ; une seule phrase trop
 * longue se coupe à un mot.
 */
function short(text: string, max = 220): string {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g)?.map((x) => x.trim()) ?? [];
  let out = '';
  for (const sentence of sentences) {
    if (`${out} ${sentence}`.trim().length > max) break;
    out = `${out} ${sentence}`.trim();
  }
  return out || `${text.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/** « Endurance vallonnée, 52 min » : ce que la séance est, et ce qu'elle dure à courir. */
function headline(s: PlannedSession): string {
  if (s.type === 'rest') return 'Repos';
  const run = runDurationOf(s);
  const name = formatOf(s.title).replace(/\s+\d+(?:[.,]\d+)?\s*(?:min|h)(?:\s*\d+)?$/i, '').trim();
  return run > 0 ? `${name}, ${sessionDuration(run)}` : name;
}

function parts(input: NoticeInput): { parts: Parts; session?: PlannedSession; question?: Question; activity?: Activity; revision?: PlanRevision['changes'][number] } {
  const { today, sessions, questions, activities, revisions } = input;
  const day = sessions.filter((s) => s.date === today && live(s));
  const session = day.find((s) => s.type !== 'rest') ?? day[0];
  const question = questions[0];
  const activity = [...activities].sort((a, b) => b.startDateLocal.localeCompare(a.startDateLocal))[0];
  // Ce que les règles ont réécrit, pour aujourd'hui ou la suite : une séance passée marquée manquée n'est pas une nouvelle.
  const ruled = revisions
    .filter((r) => r.origin !== 'coach' && r.origin !== 'athlete' && r.trigger !== 'initial' && r.trigger !== 'recount' && r.trigger !== 'terrain')
    .flatMap((r) => r.changes.filter((c) => c.date >= today).map((c) => ({ at: r.at, change: c })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1);
  return {
    parts: {
      d: today,
      s: session ? `${session.id}|${session.title}|${session.status}` : '',
      q: questions.map((x) => x.id).join(','),
      a: activity?.id ?? '',
      r: ruled?.at ?? '',
    },
    session, question, activity, revision: ruled?.change,
  };
}

export interface NoticeInput {
  /** Le jour, YYYY-MM-DD, et l'heure locale en heures décimales (7,5 pour 7 h 30). */
  today: string;
  hour: number;
  /** Les séances autour d'aujourd'hui. */
  sessions: readonly PlannedSession[];
  /** Les questions qui attendent, la plus utile d'abord (`pendingQuestions`). */
  questions: readonly Question[];
  /** Les sorties récentes. */
  activities: readonly Activity[];
  /** Les dernières révisions du plan. */
  revisions: readonly PlanRevision[];
  /** La dernière notification partie vers cet appareil. */
  last: { digest: string | null; sentAt: string | null };
  /** L'instant présent, ISO. */
  now: string;
}

function previous(digest: string | null): Partial<Parts> {
  if (!digest) return {};
  try {
    return JSON.parse(digest) as Partial<Parts>;
  } catch {
    return {};
  }
}

/**
 * La notification à envoyer maintenant, ou `null` : rien de neuf à dire, trop tôt
 * après la précédente, ou la nuit.
 *
 * Ce qui a changé décide de ce qu'elle dit, dans cet ordre : une sortie arrivée
 * (et ce que les règles en ont fait), une question nouvelle, une séance réécrite,
 * puis le jour lui-même — la séance d'aujourd'hui, une fois, le matin.
 */
export function deviceNotice(input: NoticeInput): DeviceNotice | null {
  if (input.hour >= QUIET.from || input.hour < QUIET.to) return null;
  if (input.last.sentAt && Date.parse(input.now) - Date.parse(input.last.sentAt) < NOTICE_GAP_MS) return null;

  const { parts: now, session, question, activity, revision } = parts(input);
  const before = previous(input.last.digest);
  const digest = JSON.stringify(now);
  if (digest === input.last.digest) return null;

  const asks = question ? ` ${input.questions.length > 1 ? `${input.questions.length} questions t'attendent` : 'Une question t\'attend'}.` : '';
  const todayLine = session
    ? DONE.has(session.status) ? `${headline(session)} : fait.` : `Aujourd'hui : ${headline(session)}.`
    : 'Rien de prévu aujourd\'hui.';

  // Une sortie vient d'arriver : ce qu'elle est, et ce qui en découle.
  if (activity && now.a !== before.a && before.a !== undefined && activity.startDateLocal.slice(0, 10) >= shift(input.today, -1)) {
    const what = `${activity.name} · ${activity.distanceM > 0 ? `${km(activity.distanceM)} km, ` : ''}${sessionDuration(activity.movingTimeS)}`;
    const then = revision && now.r !== before.r ? ` ${firstSentence(revision.reason)}` : '';
    return { kind: 'activity', title: 'Séance reçue et analysée', body: short(`${what}.${then}${asks}`), digest };
  }
  // Une question nouvelle : c'est elle qu'on lit.
  if (question && now.q !== before.q && !(before.q ?? '').split(',').includes(question.id)) {
    return { kind: 'question', title: 'Cairn a une question', body: short(question.prompt), digest };
  }
  // Les règles ont réécrit une séance à venir.
  if (revision && now.r !== before.r && before.r !== undefined) {
    return { kind: 'plan', title: 'Plan ajusté', body: short(firstSentence(revision.reason)), digest };
  }
  // Un nouveau jour, ou la séance du jour qui n'est plus celle qu'on avait dite.
  if (now.d !== before.d || now.s.split('|').slice(0, 2).join('|') !== (before.s ?? '').split('|').slice(0, 2).join('|')) {
    const intent = session && !DONE.has(session.status) && session.type !== 'rest' ? ` ${firstSentence(session.intent)}` : '';
    return { kind: 'day', title: todayLine.replace(/\.$/, ''), body: short(`${intent}${asks}`.trim() || 'Cairn est à jour.'), digest };
  }
  // Le reste — un statut qui change, une question qui disparaît — ne mérite pas une notification.
  return null;
}

const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
