import webpush from 'web-push';
import * as db from '@cairn/db';
import { deviceNotice, loadAthleteState, pendingQuestions, type DeviceNotice } from '@cairn/coach';

/**
 * Les notifications : ce qui atteint le téléphone sans qu'on l'ouvre.
 *
 * Web Push, la norme : le téléphone s'abonne auprès du service de notification
 * de son système — Apple pour un iPhone —, et donne à Cairn une adresse et deux
 * clefs. Le message part chiffré pour ces clefs : le relais d'Apple le transporte
 * sans pouvoir le lire. Rien ne coûte, rien ne s'ouvre de plus vers internet : la
 * requête part du Mac.
 *
 * Ce qui décide d'envoyer, et quoi, est dans `@cairn/coach` (`notify.ts`). Ici :
 * les clefs du service, les abonnements, l'envoi, et ce qu'on fait d'un refus —
 * un abonnement que le téléphone a résilié (404, 410) est retiré.
 */

const SECRET = 'vapid';
const SUBJECT = 'push-subject';

/** La paire de clefs qui signe les envois, créée au premier besoin et gardée en base. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  return JSON.parse(await db.ensureServiceSecret(SECRET, () => JSON.stringify(webpush.generateVAPIDKeys()))) as {
    publicKey: string; privateKey: string;
  };
}

/**
 * À qui le relais peut écrire en cas d'abus : la norme exige une adresse. C'est
 * celle de l'app elle-même, telle que le téléphone l'a ouverte en s'abonnant.
 */
export async function rememberOrigin(origin: string): Promise<void> {
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(origin)) return;
  if ((await db.getServiceSecret(SUBJECT)) !== origin) await db.setServiceSecret(SUBJECT, origin);
}

/**
 * Les relais auxquels Cairn accepte d'écrire : ceux des navigateurs. Une adresse
 * d'abonnement est une adresse où le Mac enverra des requêtes ; elle ne se
 * choisit pas librement.
 */
const RELAYS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

/** Un abonnement tel que le navigateur le rend, vérifié ; `null` s'il n'en est pas un. */
export function readSubscription(raw: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  const sub = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (typeof sub?.endpoint !== 'string' || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') return null;
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !RELAYS.some((r) => r.test(url.hostname))) return null;
  if (sub.endpoint.length > 2000 || sub.keys.p256dh.length > 200 || sub.keys.auth.length > 100) return null;
  return { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth };
}

export interface PushOutcome {
  sent: number;
  /** Pourquoi rien n'est parti, quand rien n'est parti. */
  skipped: string | null;
}

type Send = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

/** Ce qu'une notification porte jusqu'au téléphone. */
export interface PushPayload {
  title: string;
  body: string;
  /** L'écran qu'elle ouvre. */
  url: string;
  /** L'instant de l'envoi : le téléphone date sa synchronisation. */
  at: string;
}

/**
 * Prévient chaque appareil abonné, si le plan a du neuf à lui dire — ou de toute
 * façon, quand `force` porte le message (l'essai depuis l'app).
 */
export async function notifyDevices(
  athleteId: string,
  opts: { force?: Pick<DeviceNotice, 'title' | 'body'>; now?: Date; send?: Send; log?: (line: string) => void } = {},
): Promise<PushOutcome> {
  const subscriptions = await db.listPushSubscriptions(athleteId);
  if (subscriptions.length === 0) return { sent: 0, skipped: 'aucun appareil abonné' };
  const subject = await db.getServiceSecret(SUBJECT);
  if (!subject) return { sent: 0, skipped: 'adresse de l\'app inconnue' };

  const now = opts.now ?? new Date();
  const keys = await vapidKeys();
  const send: Send = opts.send ?? ((s, p, o) => webpush.sendNotification(s, p, o));
  const log = opts.log ?? (() => {});

  // Ce que chaque appareil verrait en ouvrant l'app : lu une fois, comparé à ce qu'il a déjà reçu.
  const state = opts.force ? null : await loadAthleteState(athleteId);
  const today = state?.today.date ?? localDay(now);
  const sessions = state ? await db.listPlannedSessions(athleteId, shift(today, -21), shift(today, 10)) : [];
  const questions = state
    ? pendingQuestions({
        today, sessions, activities: state.recentActivities, answers: state.answers,
        easyCeiling: Math.round(state.zones.find((z) => z.key === 'Z2')?.hrMax ?? 155),
      })
    : [];

  let sent = 0;
  let skipped: string | null = 'rien de neuf';
  for (const sub of subscriptions) {
    const notice = opts.force
      ? { ...opts.force, kind: 'day' as const, digest: sub.lastDigest ?? '' }
      : deviceNotice({
          today, hour: now.getHours() + now.getMinutes() / 60, sessions, questions,
          activities: state!.recentActivities, revisions: (state!.plan?.plan.revisionLog ?? []).slice(-30),
          last: { digest: sub.lastDigest ?? null, sentAt: sub.lastSentAt ?? null }, now: now.toISOString(),
        });
    if (!notice) continue;
    const payload: PushPayload = { title: notice.title, body: notice.body, url: '/', at: now.toISOString() };
    try {
      await send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          // Douze heures : un téléphone éteint la reçoit en se rallumant. Un seul
          // message en attente à la fois (`topic`) : le plus récent remplace l'autre.
          TTL: 12 * 3600,
          urgency: 'normal',
          topic: 'cairn',
        },
      );
      await db.markPushSent(sub.endpoint, { at: now.toISOString(), digest: notice.digest });
      log(`notification (${notice.kind}) → ${sub.device ?? 'appareil'} : ${notice.title}`);
      sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      const why = e instanceof Error ? e.message : String(e);
      if (status === 404 || status === 410) {
        // Le téléphone a résilié : l'app désinstallée, ou les notifications coupées.
        await db.deletePushSubscription(sub.endpoint);
        log(`abonnement résilié par ${sub.device ?? 'l\'appareil'} : retiré`);
      } else {
        await db.markPushSent(sub.endpoint, { error: `${status ?? ''} ${why}`.trim().slice(0, 300) });
        log(`notification refusée (${status ?? 'réseau'}) : ${why}`);
      }
      skipped = why;
    }
  }
  return { sent, skipped: sent > 0 ? null : skipped };
}

const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
