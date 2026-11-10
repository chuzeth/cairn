import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity, PlanRevision, PlannedSession } from '@cairn/core';
import { PIERRE } from '@cairn/core';
import { buildZones } from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Ce que Cairn dit au téléphone sans qu'on l'ouvre (`notify.ts`, `push.ts`).
 *
 * Le 10/11, Pierre : le téléphone ne se synchronise pas, et il n'ose pas s'y
 * fier. Il sert quand le Mac dort ; une app web fermée ne se réveille que par une
 * notification. Le Mac en envoie une quand il a du neuf, et le téléphone en
 * profite pour tout relire. iOS exige que chacune se voie : elle doit donc dire
 * quelque chose, ne pas se répéter, et se taire la nuit.
 */

const store = vi.hoisted(() => ({
  subs: [] as Record<string, unknown>[],
  secrets: new Map<string, string>(),
  sessions: [] as unknown[],
  state: null as unknown,
}));

vi.mock('@cairn/db', () => ({
  ensurePushTables: async () => {},
  listPushSubscriptions: async () => store.subs.map((s) => ({ ...s })),
  deletePushSubscription: async (endpoint: string) => { store.subs = store.subs.filter((s) => s.endpoint !== endpoint); },
  markPushSent: async (endpoint: string, o: { at?: string; digest?: string; error?: string }) => {
    const s = store.subs.find((x) => x.endpoint === endpoint)!;
    if (o.error) s.lastError = o.error; else Object.assign(s, { lastSentAt: o.at, lastDigest: o.digest, lastError: null });
  },
  getServiceSecret: async (k: string) => store.secrets.get(k) ?? null,
  setServiceSecret: async (k: string, v: string) => { store.secrets.set(k, v); },
  ensureServiceSecret: async (k: string, create: () => string) => {
    if (!store.secrets.has(k)) store.secrets.set(k, create());
    return store.secrets.get(k)!;
  },
  listPlannedSessions: async () => store.sessions,
}));

vi.mock('@cairn/coach', async (original) => ({
  ...(await original<typeof import('@cairn/coach')>()),
  loadAthleteState: async () => store.state,
}));

const { deviceNotice } = await import('@cairn/coach');
const { notifyDevices, readSubscription, rememberOrigin } = await import('../apps/api/src/push.js');

const session = (over: Partial<PlannedSession> = {}): PlannedSession => ({
  id: 's11', athleteId: 'pierre', date: '2026-11-11', type: 'endurance',
  title: 'Endurance vallonnée 52 min + souplesse et respiration 20 min · 100 m D+',
  intent: 'Le même footing, un peu de dénivelé, et six lignes droites. Le cœur sous 155 du début à la fin.',
  priority: 'key', status: 'planned', blocks: [{ label: 'Endurance vallonnée', zone: 'Z2', durationS: 45 * 60 }],
  plannedLoad: 50, plannedMechanicalLoad: 10, plannedDurationS: 65 * 60, ...over,
});

const run: Activity = {
  id: 'a1', athleteId: 'pierre', name: 'Course à pied le matin', sportType: 'Run', startDate: '2026-11-11T07:10:00Z',
  startDateLocal: '2026-11-11T08:10:00', distanceM: 8540, movingTimeS: 46 * 60, elapsedTimeS: 47 * 60,
  totalElevationGainM: 104, totalElevationLossM: 104, averageSpeedMs: 3.1,
} as Activity;

const question = { id: 'run_pain:s11', question: 'run_pain' as const, subject: 's11', prompt: 'Ta course d\'aujourd\'hui : une douleur, pendant ou juste après ?', why: '', choices: [], asksSite: true };

const base = {
  today: '2026-11-11', hour: 7.75, sessions: [session()], questions: [], activities: [] as Activity[],
  revisions: [] as PlanRevision[], last: { digest: null as string | null, sentAt: null as string | null },
  now: '2026-11-11T06:45:00.000Z',
};

describe('Ce qu’une notification dit', () => {
  it('dit la séance du jour, une fois, à la première synchronisation du matin', () => {
    const first = deviceNotice(base)!;
    expect(first).toMatchObject({ kind: 'day', title: 'Aujourd\'hui : Endurance vallonnée, 45 min' });
    expect(first.body).toBe('Le même footing, un peu de dénivelé, et six lignes droites.');
    // La relève suivante, sans rien de neuf : rien ne part.
    expect(deviceNotice({ ...base, last: { digest: first.digest, sentAt: base.now }, now: '2026-11-11T07:15:00.000Z' })).toBeNull();
    // Le lendemain, un jour de repos : il se dit aussi.
    const rest = deviceNotice({
      ...base, today: '2026-11-12', sessions: [session({ id: 'r', date: '2026-11-12', type: 'rest', title: 'Repos complet', blocks: [] })],
      last: { digest: first.digest, sentAt: base.now }, now: '2026-11-12T07:00:00.000Z',
    })!;
    expect([rest.kind, rest.title, rest.body]).toEqual(['day', 'Aujourd\'hui : Repos', 'Cairn est à jour.']);
  });

  it('annonce une sortie arrivée, ce que les règles en ont fait, et la question qui l’attend', () => {
    const seen = deviceNotice(base)!.digest;
    const revisions: PlanRevision[] = [{
      at: '2026-11-11T08:30:00.000Z', trigger: 'new_activity', origin: 'rules', summary: '1 ajustement',
      changes: [{ date: '2026-11-13', before: 'Seuil', after: 'Footing', reason: 'Course ramenée à la marche 3 au lieu de 4 : une douleur de 3 sur 10 pendant la course. Détail.' }],
    }];
    const notice = deviceNotice({
      ...base, hour: 9.6, activities: [run], questions: [question], revisions,
      sessions: [session({ status: 'completed' })], last: { digest: seen, sentAt: base.now }, now: '2026-11-11T08:35:00.000Z',
    })!;
    expect(notice.kind).toBe('activity');
    expect(notice.title).toBe('Séance reçue et analysée');
    expect(notice.body).toBe(
      'Course à pied le matin · 8,5 km, 46 min. Course ramenée à la marche 3 au lieu de 4 : une douleur de 3 sur 10 pendant la course. Une question t\'attend.',
    );
    // Trop longue, elle perd ses dernières phrases, entières — jamais un mot coupé.
    const long = deviceNotice({
      ...base, hour: 9.6, activities: [{ ...run, name: 'Sortie longue vallonnée du dimanche matin par Fourvière, la Sarra et Sainte-Foy-lès-Lyon avec retour par les quais' }],
      questions: [question], revisions, last: { digest: seen, sentAt: base.now }, now: '2026-11-11T08:35:00.000Z',
    })!;
    expect(long.body.length).toBeLessThanOrEqual(220);
    expect(long.body).toMatch(/pendant la course\.$/);
  });

  it('pose une question nouvelle, et ne la repose pas', () => {
    const seen = deviceNotice(base)!.digest;
    const asked = deviceNotice({ ...base, questions: [question], last: { digest: seen, sentAt: base.now }, now: '2026-11-11T09:00:00.000Z' })!;
    expect([asked.kind, asked.title, asked.body]).toEqual(['question', 'Cairn a une question', question.prompt]);
    expect(deviceNotice({ ...base, questions: [question], last: { digest: asked.digest, sentAt: '2026-11-11T09:00:00.000Z' }, now: '2026-11-11T09:30:00.000Z' })).toBeNull();
  });

  it('se tait la nuit, et dix minutes après la précédente', () => {
    expect(deviceNotice({ ...base, hour: 3 })).toBeNull();
    expect(deviceNotice({ ...base, hour: 22.75 })).toBeNull();
    expect(deviceNotice({ ...base, questions: [question], last: { digest: deviceNotice(base)!.digest, sentAt: base.now }, now: '2026-11-11T06:50:00.000Z' })).toBeNull();
  });

  it('ne dit rien d’un statut qui change ou d’une question qui disparaît', () => {
    const seen = deviceNotice({ ...base, questions: [question] })!.digest;
    expect(deviceNotice({ ...base, sessions: [session({ status: 'completed' })], last: { digest: seen, sentAt: base.now }, now: '2026-11-11T12:00:00.000Z' })).toBeNull();
  });
});

describe('L’envoi', () => {
  const SUB = { endpoint: 'https://web.push.apple.com/abc', athleteId: 'pierre', p256dh: 'k', auth: 'a', device: 'iPhone', createdAt: '2026-11-10T10:00:00Z' };
  const at = new Date(2026, 10, 11, 7, 45);

  beforeEach(() => {
    store.subs = [{ ...SUB }];
    store.secrets = new Map([['push-subject', 'https://cairn.example']]);
    store.sessions = [session()];
    store.state = {
      today: { date: '2026-11-11' }, recentActivities: [], answers: [], zones: buildZones(PIERRE_MODEL),
      plan: { plan: { revisionLog: [] }, weeks: [] }, model: PIERRE_MODEL, profile: PIERRE,
    };
  });

  it('part chiffré vers le relais du téléphone, une fois : le même message ne repart pas', async () => {
    const send = vi.fn(async () => ({}));
    expect(await notifyDevices('pierre', { now: at, send })).toEqual({ sent: 1, skipped: null });
    const [sub, payload, options] = send.mock.calls[0] as unknown as [{ endpoint: string }, string, { TTL: number; topic: string; vapidDetails: { subject: string; publicKey: string } }];
    expect(sub.endpoint).toBe(SUB.endpoint);
    expect(JSON.parse(payload)).toMatchObject({ title: 'Aujourd\'hui : Endurance vallonnée, 45 min', url: '/' });
    expect([options.TTL, options.topic, options.vapidDetails.subject]).toEqual([43200, 'cairn', 'https://cairn.example']);
    expect(options.vapidDetails.publicKey).toHaveLength(87);
    // La relève suivante, un quart d'heure plus tard, sans rien de neuf.
    expect(await notifyDevices('pierre', { now: new Date(2026, 10, 11, 8, 0), send })).toEqual({ sent: 0, skipped: 'rien de neuf' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('retire un abonnement que le téléphone a résilié, et garde la trace d’un autre refus', async () => {
    const gone = vi.fn(async () => { throw Object.assign(new Error('Gone'), { statusCode: 410 }); });
    await notifyDevices('pierre', { now: at, send: gone });
    expect(store.subs).toEqual([]);
    store.subs = [{ ...SUB }];
    const busy = vi.fn(async () => { throw Object.assign(new Error('Too Many Requests'), { statusCode: 429 }); });
    expect((await notifyDevices('pierre', { now: at, send: busy })).sent).toBe(0);
    expect(store.subs[0]).toMatchObject({ lastError: '429 Too Many Requests' });
  });

  it('ne fait rien sans appareil abonné, ni sans connaître l’adresse de l’app', async () => {
    const send = vi.fn(async () => ({}));
    store.secrets.delete('push-subject');
    expect((await notifyDevices('pierre', { now: at, send })).skipped).toBe('adresse de l\'app inconnue');
    store.subs = [];
    expect((await notifyDevices('pierre', { now: at, send })).skipped).toBe('aucun appareil abonné');
    expect(send).not.toHaveBeenCalled();
  });

  it('n’accepte un abonnement que vers le relais d’un navigateur', async () => {
    const keys = { p256dh: 'BPk', auth: 'xyz' };
    expect(readSubscription({ endpoint: 'https://web.push.apple.com/QOx', keys })).toEqual({ endpoint: 'https://web.push.apple.com/QOx', p256dh: 'BPk', auth: 'xyz' });
    expect(readSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys })).not.toBeNull();
    // Une adresse d'abonnement est une adresse où le Mac écrira : pas n'importe laquelle.
    expect(readSubscription({ endpoint: 'https://exemple.fr/hook', keys })).toBeNull();
    expect(readSubscription({ endpoint: 'http://web.push.apple.com/x', keys })).toBeNull();
    expect(readSubscription({ endpoint: 'https://web.push.apple.com/x' })).toBeNull();
    await rememberOrigin('javascript:alert(1)');
    expect(store.secrets.get('push-subject')).toBe('https://cairn.example');
  });
});
