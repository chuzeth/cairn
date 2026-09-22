import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity, ActivityAnalysis, ActivityStreams, PlannedSession, SessionBlock } from '@cairn/core';
import {
  matchPlannedSession, outcomeOf, sessionOutcome, type RealizedEffort,
} from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Une séance faite la veille ou le lendemain de sa date.
 *
 * Le défaut : le test maximal prévu le 22/09 a été couru le 21/09. Le modèle
 * s'en est servi — preuve d'effort maximal de 0,33 à 0,78 —, mais le plan ne
 * l'a pas reconnu : le rattachement ne regardait que les séances du jour. Le
 * 22/09, l'écran demandait encore le test, et le 23/09 les règles l'auraient
 * marqué « manqué ».
 */

const block = (over: Partial<SessionBlock> & Pick<SessionBlock, 'label' | 'zone'>): SessionBlock => over;

/** Le test du 22/09, tel qu'enregistré. */
const TEST: PlannedSession = {
  id: 'ses_test', athleteId: 'pierre', date: '2026-09-22', type: 'threshold', priority: 'key', status: 'planned',
  title: 'Test maximal 20 min — 1 h', intent: '', plannedLoad: 59, plannedMechanicalLoad: 0, plannedDurationS: 3600,
  blocks: [
    block({ label: 'Échauffement progressif', zone: 'Z2', durationS: 1200, speedRangeMs: [2.457, 2.996] }),
    block({ label: 'Gammes et accélérations', zone: 'Z2', durationS: 300, speedRangeMs: [2.457, 2.996] }),
    block({
      label: 'Contre-la-montre 20 min', zone: 'Z5', durationS: 1200, hrRange: [171, 185], speedRangeMs: [3.84, 3.99],
    }),
    block({ label: 'Retour au calme', zone: 'Z1', durationS: 900 }),
  ],
};

const REST: PlannedSession = {
  ...TEST, id: 'ses_repos', date: '2026-09-21', type: 'rest', priority: 'support', title: 'Repos complet',
  plannedLoad: 0, plannedDurationS: 0, blocks: [],
};

const endurance = (over: Partial<PlannedSession> & Pick<PlannedSession, 'id' | 'date'>): PlannedSession => ({
  ...TEST, type: 'endurance', priority: 'support', title: 'Endurance fondamentale 1 h', plannedLoad: 50,
  plannedDurationS: 3600, blocks: [block({ label: 'Endurance', zone: 'Z2', durationS: 3600 })], ...over,
});

/** La sortie du 21/09 : 61 min, 94 points, les 20 meilleures minutes à 174 bpm. */
const RUN_2109: RealizedEffort = {
  activityId: 'strava-20268790107', sportType: 'Run', date: '2026-09-21', durationS: 3672, load: 93.8,
  blockSpeedMs: 4.14, bestEffortHr: { '1200': 174.4 },
};

describe('Rattachement à la veille ou au lendemain', () => {
  it('reconnaît le test du 22/09 dans la sortie du 21/09, dont le jour ne prescrivait qu’un repos', () => {
    expect(matchPlannedSession([REST, TEST], RUN_2109, PIERRE_MODEL)?.id).toBe('ses_test');
    expect(outcomeOf(TEST, RUN_2109, PIERRE_MODEL)).toBe('fulfilled');
  });

  it('ne prend pas pour un test une sortie de même durée sans effort maximal', () => {
    // 20 min à 160 bpm : sous la FC du seuil 2, rien n'a été prouvé.
    const footing = { ...RUN_2109, load: 60, bestEffortHr: { '1200': 160 } };
    expect(outcomeOf(TEST, footing, PIERRE_MODEL)).toBe('replaced');
    expect(matchPlannedSession([REST, TEST], footing, PIERRE_MODEL)).toBeNull();
    // Le jour même, elle reste rattachée — mais comme ce qu'elle est : autre chose que le test.
    expect(matchPlannedSession([TEST], { ...footing, date: '2026-09-22' }, PIERRE_MODEL)?.id).toBe('ses_test');
    expect(outcomeOf(TEST, { ...footing, date: '2026-09-22' }, PIERRE_MODEL)).toBe('replaced');
  });

  it('juge un test sur son effort, pas sur sa charge : un échauffement couru vite ne le défait pas', () => {
    const test = { proven: true };
    expect(sessionOutcome({ loadPct: 59, durationPct: 2, intensityPct: 30 }, test)).toBe('fulfilled');
    expect(sessionOutcome({ loadPct: 59, durationPct: 2, intensityPct: null })).toBe('replaced');
    // La durée reste une consigne : un test sur un échauffement écourté n'est pas le test prescrit.
    expect(sessionOutcome({ loadPct: 0, durationPct: -45, intensityPct: null }, test)).toBe('replaced');
  });

  it('laisse la séance du jour quand elle correspond mieux', () => {
    const seuil = endurance({ id: 'ses_seuil', date: '2026-09-21', type: 'threshold', plannedLoad: 90 });
    expect(matchPlannedSession([seuil, TEST], RUN_2109, PIERRE_MODEL)?.id).toBe('ses_seuil');
  });

  it('reprend une séance de la veille, manquée ou non, mais pas d’avant-hier', () => {
    const sortie: RealizedEffort = { ...RUN_2109, bestEffortHr: {}, load: 52, durationS: 3500 };
    const veille = endurance({ id: 'ses_veille', date: '2026-09-20', status: 'missed' });
    expect(matchPlannedSession([veille], sortie, PIERRE_MODEL)?.id).toBe('ses_veille');
    expect(matchPlannedSession([endurance({ id: 'ses_loin', date: '2026-09-19' })], sortie, PIERRE_MODEL)).toBeNull();
  });

  it('ne rattache jamais « remplacée » une séance d’un autre jour', () => {
    // 100 min pour une heure prescrite : le jour même, ce serait une séance
    // remplacée ; un jour d'écart, ce n'est pas elle.
    const longue: RealizedEffort = { ...RUN_2109, bestEffortHr: {}, durationS: 6000, load: 95 };
    expect(matchPlannedSession([endurance({ id: 'ses_lendemain', date: '2026-09-22' })], longue, PIERRE_MODEL)).toBeNull();
  });

  it('ne défait jamais un rattachement existant', () => {
    const tenue = endurance({
      id: 'ses_tenue', date: '2026-09-21', status: 'replaced', completedActivityId: RUN_2109.activityId,
      plannedLoad: 20, plannedDurationS: 1800,
    });
    expect(matchPlannedSession([tenue, TEST], RUN_2109, PIERRE_MODEL)?.id).toBe('ses_tenue');
  });
});

// ── La passe des sept derniers jours ─────────────────────────────────────────

const store = vi.hoisted(() => ({
  sessions: [] as (PlannedSession & { weekStart?: string })[],
  activities: [] as Activity[],
  streams: new Map<string, ActivityStreams>(),
  analyses: new Map<string, ActivityAnalysis>(),
  updates: 0,
}));

vi.mock('@cairn/db', () => ({
  getActivity: async (id: string) => store.activities.find((a) => a.id === id) ?? null,
  getStreams: async (id: string) => {
    const streams = store.streams.get(id);
    return streams ? { streams, gpsQuality: 'good', hrCoverage: 1 } : null;
  },
  listActivities: async (_a: string, { from, to }: { from: string; to: string }) =>
    store.activities.filter((a) => a.startDateLocal >= from && a.startDateLocal <= `${to}T23:59:59`),
  listPlannedSessions: async (_a: string, from: string, to: string) =>
    store.sessions.filter((s) => s.date >= from && s.date <= to).map((s) => ({ ...s })),
  saveAnalysis: async (_a: string, _d: string, analysis: ActivityAnalysis) => {
    store.analyses.set(analysis.activityId, analysis);
  },
  updateSession: async (id: string, patch: Partial<PlannedSession>) => {
    store.updates++;
    const s = store.sessions.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  },
}));

const { rematchRecent } = await import('@cairn/coach');

/** 20 min d'échauffement, 20 min à 14,3 km/h et 175 bpm, 21 min de retour : la forme du 21/09. */
function testRun(): ActivityStreams {
  const phases = [
    { s: 1200, v: 3.2, hr: 150 },
    { s: 1200, v: 3.98, hr: 175 },
    { s: 1260, v: 3.0, hr: 145 },
  ];
  const out: ActivityStreams = {
    time: [], distance: [], altitude: [], velocity: [], grade: [], heartrate: [], moving: [],
  };
  let d = 0;
  for (const p of phases) {
    for (let i = 0; i < p.s; i++) {
      d += p.v;
      out.time.push(out.time.length);
      out.distance.push(d);
      out.altitude.push(200);
      out.velocity.push(p.v);
      out.grade.push(0);
      out.heartrate!.push(p.hr);
      out.moving!.push(true);
    }
  }
  return out;
}

const activity = (id: string, day: string): Activity => ({
  id, athleteId: 'pierre', name: 'Course à pied dans l’après-midi', sportType: 'Run',
  startDate: `${day}T14:25:25Z`, startDateLocal: `${day}T16:25:25Z`, distanceM: 13196, movingTimeS: 3660,
  elapsedTimeS: 3700, totalElevationGainM: 0, totalElevationLossM: 0, averageSpeedMs: 3.6,
} as Activity);

beforeEach(() => {
  store.sessions = [{ ...REST }, { ...TEST }, endurance({ id: 'ses_2409', date: '2026-09-24' })];
  store.activities = [activity('strava-2109', '2026-09-21')];
  store.streams = new Map([['strava-2109', testRun()]]);
  store.analyses = new Map();
  store.updates = 0;
});

describe('La passe de rattachement des sept derniers jours', () => {
  it('réalise le test du 22/09 le 21/09, sans réimport, et le date du jour réel', async () => {
    expect(await rematchRecent('pierre', PIERRE_MODEL, '2026-09-22')).toEqual([
      { activityId: 'strava-2109', sessionId: 'ses_test' },
    ]);
    const test = store.sessions.find((s) => s.id === 'ses_test')!;
    expect(test).toMatchObject({
      status: 'completed', completedActivityId: 'strava-2109',
      date: '2026-09-21', plannedDate: '2026-09-22', weekStart: '2026-09-21',
    });
    expect(test.history?.at(-1)).toMatchObject({ by: 'rules' });
    expect(test.history?.at(-1)?.text).toContain('Prévue le 22/09, réalisée le 21/09');
    expect(store.analyses.get('strava-2109')?.compliance?.detail).toMatch(/^Prévue le 22\/09, réalisée la veille\./);
    // Le 22/09 ne porte plus rien : c'est ce jour-là que les règles lisent comme le lendemain du test.
    expect(store.sessions.filter((s) => s.date === '2026-09-22')).toEqual([]);
  });

  it('ne relit pas ce qu’une séance tient déjà, et n’écrit rien quand rien ne se rattache', async () => {
    await rematchRecent('pierre', PIERRE_MODEL, '2026-09-22');
    const updates = store.updates;
    const analysis = store.analyses.get('strava-2109');
    expect(await rematchRecent('pierre', PIERRE_MODEL, '2026-09-22')).toEqual([]);
    expect(store.updates).toBe(updates);
    expect(store.analyses.get('strava-2109')).toBe(analysis);

    // Une activité qui ne réalise rien ne laisse aucune trace.
    store.activities.push(activity('strava-2309', '2026-09-23'));
    store.streams.set('strava-2309', testRun());
    expect(await rematchRecent('pierre', PIERRE_MODEL, '2026-09-23')).toEqual([]);
    expect(store.analyses.has('strava-2309')).toBe(false);
  });
});
