import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity, PlannedSession, SessionBlock } from '@cairn/core';
import { canWriteActivities } from '@cairn/strava';

/**
 * La séance prescrite dans la description de la sortie Strava (17/11) : une
 * ligne par bloc, sa durée, sa cible, sa récupération — et rien d'autre.
 */

const store = vi.hoisted(() => ({
  scope: 'read,activity:read_all,profile:read_all,activity:write' as string | null,
  sessions: [] as PlannedSession[],
  activities: [] as Activity[],
  geo: new Map<string, unknown>(),
}));

vi.mock('@cairn/db', () => ({
  getStravaTokens: async () => (store.scope == null ? null : { scope: store.scope }),
  listPlannedSessions: async (_a: string, from: string, to: string) =>
    store.sessions.filter((s) => s.date >= from && s.date <= to),
  getActivity: async (id: string) => store.activities.find((a) => a.id === id) ?? null,
  getGeo: async (key: string) => (store.geo.has(key) ? { value: store.geo.get(key), fetchedAt: '' } : null),
  putGeo: async (key: string, value: unknown) => { store.geo.set(key, value); },
}));

const { sessionLog, describedWith, logSessionsToStrava, prime } = await import('@cairn/coach');

/** La séance du 17/11 telle qu'écrite, adoucie par la vigilance. */
const COTES: SessionBlock[] = [
  { label: 'Échauffement', zone: 'Z2', durationS: 1200, hrRange: [0, 155] },
  { label: 'Côte', zone: 'Z5', durationS: 90, hrRange: [175, 183], repeat: 6, effort: 'Fort',
    recovery: { durationS: 120, zone: 'Z1', active: true, betweenReps: true, elevationLossM: 25 } },
  { label: 'Trot', zone: 'Z1', durationS: 240, hrRange: [0, 141] },
  { label: 'Seuil', zone: 'Z3', durationS: 360, hrRange: [164, 168], paceRange: ['4:35', '4:40'], repeat: 2, lastOptional: true,
    recovery: { durationS: 120, zone: 'Z1', active: true, betweenReps: true } },
  { label: 'Retour au calme', zone: 'Z1', durationS: 600, hrRange: [0, 141] },
  { label: 'Souplesse', kind: 'mobility', zone: 'Z1', durationS: 600 },
  { label: 'Respiration', kind: 'respiratory', zone: 'Z1', durationS: 600 },
];

const session = (over: Partial<PlannedSession> = {}): PlannedSession => ({
  id: 's17', athleteId: 'pierre', date: '2026-11-17', type: 'hill_repeats', priority: 'key', status: 'completed',
  title: 'Côtes et seuil 1 h 07 + souplesse et respiration 20 min · 150 m D+', intent: '', plannedLoad: 86,
  plannedMechanicalLoad: 10, plannedDurationS: 5220, blocks: COTES, completedActivityId: 'a17', ...over,
});

const activity = (over: Partial<Activity> = {}): Activity => ({
  id: 'a17', stravaId: 21024046003, athleteId: 'pierre', name: 'Course', sportType: 'Run',
  startDate: '2026-11-17T15:51:54Z', startDateLocal: '2026-11-17T16:51:54Z', distanceM: 11500, movingTimeS: 3694,
  elapsedTimeS: 3900, totalElevationGainM: 161, totalElevationLossM: 160, averageSpeedMs: 3.1,
  // La base retombe sur la note privée quand la description est vide.
  description: 'note privée : genou un peu raide', ...over,
});

const client = () => ({
  getActivity: vi.fn(async () => ({ description: null }) as never),
  updateDescription: vi.fn(async () => undefined),
});

beforeEach(() => {
  store.scope = 'read,activity:read_all,profile:read_all,activity:write';
  store.sessions = [session()];
  store.activities = [activity()];
  store.geo = new Map();
});

describe('La séance, en quelques lignes', () => {
  it('une ligne par bloc : durée, cible, récupération ; la souplesse au bout', () => {
    expect(sessionLog(session())).toBe([
      'Côtes et seuil',
      'Échauffement 20′ < 155 bpm',
      '6 × 90″ côte 175–183 bpm · récup 2′ en redescendant',
      'Trot 4′ < 141 bpm',
      '2 × 6′ seuil 164–168 bpm · récup 2′ (dernière facultative)',
      'Retour au calme 10′ < 141 bpm',
      '+ souplesse et respiration 20′',
    ].join('\n'));
  });

  it('une séance d’un bloc tient en une ligne ; remplacée, elle se dit « Prévu »', () => {
    const long = session({
      status: 'replaced', title: 'Sortie longue vallonnée 1 h 05 + souplesse et respiration 20 min',
      blocks: [{ label: 'Sortie longue vallonnée', zone: 'Z2', durationS: 3900, hrRange: [0, 155] }],
    });
    expect(sessionLog(long)).toBe('Prévu : Sortie longue vallonnée 1 h 05 < 155 bpm');
  });

  it('écrit les durées comme une montre : 90″, 20′, 2′30, 1 h 25', () => {
    expect([prime(90), prime(1200), prime(150), prime(5100)]).toEqual(['90″', '20′', '2′30', '1 h 25']);
  });

  it('garde ce que l’athlète a écrit au-dessus, et ne s’écrit pas deux fois', () => {
    expect(describedWith('Jambes lourdes au début.', 'Footing 40′ < 155 bpm')).toBe('Jambes lourdes au début.\n\nFooting 40′ < 155 bpm');
    expect(describedWith('Footing 40′ < 155 bpm', 'Footing 40′ < 155 bpm')).toBeNull();
  });
});

describe('Dans la description Strava', () => {
  it('ne demande rien à Strava sans le droit d’écrire', async () => {
    store.scope = 'read,activity:read_all,profile:read_all';
    expect(canWriteActivities(store.scope)).toBe(false);
    const c = client();
    expect(await logSessionsToStrava('pierre', c, '2026-11-17')).toBe(0);
    expect(c.updateDescription).not.toHaveBeenCalled();
  });

  it('écrit la séance une fois, sans jamais publier la note privée', async () => {
    const c = client();
    expect(await logSessionsToStrava('pierre', c, '2026-11-17')).toBe(1);
    expect(c.updateDescription).toHaveBeenCalledWith(21024046003, sessionLog(session()));
    expect(JSON.stringify(c.updateDescription.mock.calls)).not.toMatch(/note privée/);
    expect(await logSessionsToStrava('pierre', c, '2026-11-18')).toBe(0);
    expect(c.updateDescription).toHaveBeenCalledTimes(1);
  });

  it('ne réécrit pas l’historique : une sortie de plus de trois jours garde sa description', async () => {
    store.sessions = [session({ date: '2026-11-09' })];
    store.activities = [activity({ startDateLocal: '2026-11-09T17:00:00Z' })];
    const c = client();
    expect(await logSessionsToStrava('pierre', c, '2026-11-17')).toBe(0);
    expect(c.getActivity).not.toHaveBeenCalled();
  });
});
