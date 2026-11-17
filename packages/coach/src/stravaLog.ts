import type { Activity, PlannedSession, SessionBlock } from '@cairn/core';
import { annexOf } from '@cairn/core';
import * as db from '@cairn/db';
import { canWriteActivities, type StravaClient } from '@cairn/strava';

/**
 * La séance prescrite, écrite dans la description de la sortie Strava qui la
 * réalise : une trace de ce qui était demandé, lisible d'un coup d'œil.
 *
 * Le 17/11, Pierre : « échauffement 20 minutes, sub 155, retour à la ligne,
 * 6 fois 90 secondes entre X et Y bpm, récup… un truc très simple, bien
 * condensé, pour qu'on garde une trace des séances. » Une ligne par bloc : sa
 * durée, sa cible, sa récupération — ni les consignes, ni les notes. La
 * souplesse qui s'ajoute tient en une dernière ligne.
 *
 * Seule la description s'écrit, une fois, sur une sortie des trois derniers
 * jours : jamais l'historique, jamais la visibilité (l'API ne le permet pas),
 * et ce que l'athlète a déjà écrit reste au-dessus.
 */

/** « 20′ », « 90″ », « 1 h 25 », « 2′30 ». */
export function prime(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 120 && s % 60 !== 0) return `${s}″`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
  return r === 0 ? `${m}′` : `${m}′${String(r).padStart(2, '0')}`;
}

/** La cible d'un bloc : sa fourchette de FC, à défaut son allure. */
function target(range?: [number, number], pace?: [string, string]): string {
  if (range) return range[0] <= 0 ? `< ${range[1]} bpm` : `${range[0]}–${range[1]} bpm`;
  if (pace) return `${pace[0]}–${pace[1]}/km`;
  return '';
}

/** Ce que mesure un bloc : sa durée, ou sa distance. */
const amount = (b: SessionBlock) =>
  b.distanceM ? (b.distanceM >= 1000 ? `${String(b.distanceM / 1000).replace('.', ',')} km` : `${b.distanceM} m`) : prime(b.durationS ?? 0);

/** Une ligne par bloc couru. */
export function blockLine(b: SessionBlock): string {
  const reps = b.repeat && b.repeat > 1;
  const label = b.label.trim();
  const what = reps ? `${b.repeat} × ${amount(b)} ${label.toLowerCase()}` : `${label} ${amount(b)}`;
  const goal = target(b.hrRange, b.paceRange);
  const recovery = b.recovery && reps
    ? ` · récup ${prime(b.recovery.durationS)}${(b.recovery.elevationLossM ?? 0) > 0 ? ' en redescendant' : (b.recovery.elevationGainM ?? 0) > 0 ? ' en remontant' : ''}`
    : '';
  const optional = b.lastOptional ? ' (dernière facultative)' : '';
  return `${what}${goal ? ` ${goal}` : ''}${recovery}${optional}`;
}

/**
 * La séance en quelques lignes : son nom, un bloc par ligne, la souplesse au
 * bout. Une séance d'un seul bloc tient en une ligne. Une séance que la sortie
 * a remplacée se dit « Prévu » : c'est la trace de ce qui était demandé, pas
 * de ce qui a été fait.
 */
export function sessionLog(session: Pick<PlannedSession, 'title' | 'blocks' | 'status'>): string {
  const name = session.title.replace(/\s+[·+—].*$/, '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:min|h)(?:\s*\d+)?$/i, '').trim();
  const annex = annexOf(session.blocks);
  const run = session.blocks.filter((b) => !b.kind).map(blockLine);
  const head = session.status === 'replaced' ? `Prévu : ${name}` : name;
  const lines = run.length === 1 && run[0]!.startsWith(name)
    ? [session.status === 'replaced' ? `Prévu : ${run[0]}` : run[0]!]
    : [head, ...run];
  if (annex) lines.push(`+ ${annex.name} ${prime(annex.durationS)}`);
  return lines.join('\n');
}

/** Ce qui s'écrit sur l'activité : ce que l'athlète y a mis, puis la séance. */
export function describedWith(current: string | undefined, log: string): string | null {
  const mine = (current ?? '').trim();
  if (mine.includes(log)) return null;
  return mine ? `${mine}\n\n${log}` : log;
}

const KEY = (activityId: string) => `strava-log:v1:${activityId}`;
/** Une sortie plus vieille que ça garde sa description : l'historique ne se réécrit pas. */
const RECENT_DAYS = 3;

/**
 * Écrit la séance prescrite dans les sorties récentes qui en réalisent une et
 * ne l'ont pas encore. Rend le nombre de sorties écrites. Sans le droit
 * d'écrire — un jeton d'avant le 17/11 —, ne fait rien.
 */
export async function logSessionsToStrava(
  athleteId: string,
  client: Pick<StravaClient, 'updateDescription' | 'getActivity'>,
  today: string,
): Promise<number> {
  const tokens = await db.getStravaTokens(athleteId);
  if (!canWriteActivities(tokens?.scope)) return 0;
  const from = new Date(Date.parse(`${today}T12:00:00Z`) - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const sessions = (await db.listPlannedSessions(athleteId, from, today))
    .filter((s) => s.completedActivityId && s.blocks.length > 0 && ['completed', 'partial', 'replaced'].includes(s.status));
  let written = 0;
  for (const s of sessions) {
    const activity: Activity | null = await db.getActivity(s.completedActivityId!);
    if (!activity?.stravaId || activity.startDateLocal.slice(0, 10) < from) continue;
    if (await db.getGeo(KEY(activity.id))) continue;
    const log = sessionLog(s);
    // La description publique telle que Strava la tient maintenant — pas celle
    // de la base, qui retombe sur la note privée quand il n'y en a pas : une
    // note privée ne doit jamais passer dans la description.
    const fresh = await client.getActivity(activity.stravaId);
    const description = describedWith(fresh.description ?? undefined, log);
    if (description) await client.updateDescription(activity.stravaId, description);
    await db.putGeo(KEY(activity.id), { log, sessionId: s.id });
    written++;
  }
  return written;
}
