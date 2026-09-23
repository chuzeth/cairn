import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PIERRE,
  type Activity, type ActivityAnalysis, type ActivityStreams, type DailyCheckIn, type PlannedSession,
  type SessionBlock, type TrainingPlan,
} from '@cairn/core';
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
  sessions: [] as (PlannedSession & { weekStart?: string; phase?: string })[],
  activities: [] as Activity[],
  streams: new Map<string, ActivityStreams>(),
  analyses: new Map<string, ActivityAnalysis>(),
  updates: 0,
  revisions: [] as TrainingPlan['revisionLog'],
}));

vi.mock('@cairn/db', () => ({
  getLatestModel: async () => PIERRE_MODEL,
  getActivePlan: async () => ({
    plan: { id: 'plan' },
    weeks: [{ weekStart: '2026-09-21', phase: 'build', sessions: store.sessions.map((s) => ({ ...s })) }],
  }),
  appendPlanRevision: async (_id: string, revision: TrainingPlan['revisionLog'][number]) => {
    store.revisions.push(revision);
  },
  insertSession: async (_plan: string, s: PlannedSession, week: { weekStart: string; phase: string }) => {
    store.sessions.push({ ...s, ...week });
  },
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

const { applyAdjustments, evaluateAdjustments, rematchRecent, recovery } = await import('@cairn/coach');

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
  store.revisions = [];
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

// ── Les voisines d'une séance clef réalisée un autre jour ────────────────────

/**
 * La semaine réelle, relevée sur la base le 22/09 à midi : le test prévu le
 * 22/09 couru la veille, et le « Repos complet » du 23/09 — posé comme
 * lendemain du test à son ancienne date — resté en place. Le 22/09 est vide.
 */
const TEST_2109: PlannedSession = {
  ...TEST, status: 'completed', date: '2026-09-21', plannedDate: '2026-09-22', completedActivityId: 'strava-2109',
};
const REST_2309: PlannedSession = { ...REST, id: 'ses_2309', date: '2026-09-23' };
const DESCENTE: PlannedSession = endurance({
  id: 'ses_2409', date: '2026-09-24', type: 'downhill', title: 'Descente technique 6 × 3 min', plannedLoad: 57,
});
const RANDO: PlannedSession = endurance({
  id: 'ses_2709', date: '2026-09-27', type: 'long_trail', priority: 'key', title: 'Rando-course — 3 h · 680 m D+',
  plannedLoad: 138, plannedDurationS: 10800,
  decision: { at: '2026-09-18T17:47:59.066Z', by: 'coach', summary: 'Rando-course ramenée à 680 m D+.' },
});
const week = (): PlannedSession[] => [{ ...REST }, { ...TEST_2109 }, { ...REST_2309 }, DESCENTE, RANDO];

/** Le point du jour du 22/09 : fatigue « moyen », courbatures « nettes ». */
const CHECK_IN: DailyCheckIn = { date: '2026-09-22', athleteId: 'pierre', fatigue: 3, soreness: 3, sleepHours: 8.5 };

const stateOn = (
  date: string,
  over: { verdict?: 'green' | 'amber' | 'red'; checkIn?: Partial<DailyCheckIn>; plan?: PlannedSession[] } = {},
) =>
  ({
    today: {
      date, ctl: 36, atl: 38, tsb: -2, mechanicalTsb: 2, acwr: 1.08, mechanicalAcwr: 0.76, rampRate: 1.3,
      monotony: 0.9, tsbLabel: '', acwrLabel: '', acwrRisk: 'low',
    },
    readiness: { date, score: over.verdict === 'red' ? 32 : 56, verdict: over.verdict ?? 'amber', components: {}, recommendation: '' },
    todayCheckIn: { ...CHECK_IN, date, ...over.checkIn },
    absences: [], model: PIERRE_MODEL, profile: PIERRE, eccentricCircuitsDone: 0,
    plan: over.plan ? { plan: { id: 'plan' }, weeks: [{ weekStart: '2026-09-21', sessions: over.plan }] } : null,
  }) as never;

describe('Une séance clef réalisée un autre jour emporte ses voisines', () => {
  it('donne au lendemain réel le décrassage, et y déplace le repos posé pour l’ancienne date', () => {
    const adj = evaluateAdjustments(stateOn('2026-09-22'), week());
    expect(adj).toEqual([
      expect.objectContaining({
        sessionId: 'ses_2309', date: '2026-09-23', newDate: '2026-09-22', action: 'recover', recovery: 'recovery',
        rule: 'day_after_key',
      }),
    ]);
    expect(adj[0]!.reason).toMatch(
      /^Test maximal prévu le 22\/09, couru le 21\/09 : son lendemain est un décrassage, qui soulage les courbatures/,
    );
    expect(adj[0]!.reason).toContain("Le repos posé le 23/09 pour protéger l'ancienne date passe au 22/09.");
    // Le repos du 21/09 est passé : c'est le jour du test, rien ne s'y réécrit.
    expect(adj.some((a) => a.sessionId === REST.id)).toBe(false);
  });

  it('ne laisse le repos l’emporter que le jour même, sur ce que le corps en dit', () => {
    const kind = (state: never) => evaluateAdjustments(state, week())[0]?.recovery;
    expect(kind(stateOn('2026-09-22', { checkIn: { fatigue: 5 } }))).toBe('rest');
    expect(kind(stateOn('2026-09-22', { checkIn: { soreness: 5 } }))).toBe('rest');
    expect(kind(stateOn('2026-09-22', { verdict: 'red' }))).toBe('rest');
    expect(evaluateAdjustments(stateOn('2026-09-22', { checkIn: { fatigue: 5 } }), week())[0]!.reason).toContain(
      'et le point du jour dit « vidé » : son lendemain est un repos complet',
    );
    // « Lourd » et des courbatures « fortes » ne sont ni « vidé » ni « sévères ».
    expect(kind(stateOn('2026-09-22', { checkIn: { fatigue: 4, soreness: 4 } }))).toBe('recovery');
    // La veille au soir, le point du jour du 21/09 ne dit rien du 22/09.
    const eve = evaluateAdjustments(stateOn('2026-09-21', { checkIn: { fatigue: 5 } }), week());
    expect(eve.find((a) => a.rule === 'day_after_key')?.recovery).toBe('recovery');
  });

  it('trouve la séance clef dans le plan quand le point du jour ne passe que ce qui vient', () => {
    const upcoming = week().filter((s) => s.date >= '2026-09-22');
    expect(evaluateAdjustments(stateOn('2026-09-22'), upcoming)).toEqual([]);
    expect(evaluateAdjustments(stateOn('2026-09-22', { plan: week() }), upcoming)).toEqual([
      expect.objectContaining({ sessionId: 'ses_2309', newDate: '2026-09-22', recovery: 'recovery' }),
    ]);
  });

  it('libère le repos du 23/09 quand le lendemain est déjà passé', () => {
    const adj = evaluateAdjustments(stateOn('2026-09-23'), week());
    expect(adj).toEqual([
      expect.objectContaining({ sessionId: 'ses_2309', action: 'free', rule: 'protection_freed' }),
    ]);
    expect(adj[0]!.reason).toBe(
      'Libéré : la séance « Test maximal 20 min », prévue le 22/09, a été réalisée le 21/09 — ce repos ne protège plus rien.',
    );
  });

  it('ne réécrit ni une séance décidée, ni une séance exigeante, et garde un jour qui protège encore', () => {
    // Le coach a décidé du 22/09 : il reste à lui, et le 23/09 est libéré quand même.
    const decided = endurance({
      id: 'ses_2209', date: '2026-09-22', type: 'recovery', title: 'Décrassage',
      decision: { at: '2026-09-21T19:00:00.000Z', by: 'coach', summary: 'Décrassage le 22/09.' },
    });
    expect(evaluateAdjustments(stateOn('2026-09-22'), [...week(), decided]).map((a) => [a.sessionId, a.action]))
      .toEqual([['ses_2309', 'free']]);
    // Un second test le 24/09 : le 23/09 en est la veille, il protège encore.
    const second = { ...TEST, id: 'ses_test_2409', date: '2026-09-24' };
    const kept = evaluateAdjustments(stateOn('2026-09-22'), [...week().filter((s) => s.id !== DESCENTE.id), second]);
    expect(kept.filter((a) => a.sessionId === 'ses_2309' && a.action === 'free')).toEqual([]);
  });

  it('écrit le lendemain quand il est vide et qu’aucune protection ne peut y passer', () => {
    // Prévu le samedi 26/09, couru le vendredi : le dimanche porte la rando-course, rien à déplacer.
    const test = { ...TEST_2109, date: '2026-09-25', plannedDate: '2026-09-26' };
    const adj = evaluateAdjustments(stateOn('2026-09-26'), [test, RANDO]);
    expect(adj).toEqual([
      expect.objectContaining({
        sessionId: 'ses_test-lendemain', date: '2026-09-26', action: 'recover', recovery: 'recovery', insert: true,
      }),
    ]);
  });

  it('au lendemain d’un test couru à sa date, remplace le repos par le décrassage', () => {
    const atItsDate = { ...TEST, status: 'completed' as const };
    const adj = evaluateAdjustments(stateOn('2026-09-23'), [atItsDate, { ...REST_2309 }]);
    expect(adj).toEqual([
      expect.objectContaining({ sessionId: 'ses_2309', date: '2026-09-23', action: 'recover', recovery: 'recovery' }),
    ]);
    expect(adj[0]!.newDate).toBeUndefined();
    // « Vidé » ce matin-là : le repos est déjà là.
    expect(evaluateAdjustments(stateOn('2026-09-23', { checkIn: { fatigue: 5 } }), [atItsDate, { ...REST_2309 }]))
      .toEqual([]);
  });
});

describe('La semaine du 21/09, de la relève au plan', () => {
  beforeEach(() => {
    // Le test prévu le 22/09, le repos de sa veille et celui de son lendemain,
    // la descente du 24/09 ; la sortie du 21/09 attend d'être rattachée.
    store.sessions = [{ ...REST }, { ...TEST }, { ...REST_2309 }, { ...DESCENTE }].map((s) => ({
      ...s, weekStart: '2026-09-21', phase: 'build',
    }));
  });

  const onDay = (date: string) => store.sessions.filter((s) => s.date === date && s.status !== 'cancelled');

  it('rattache le test à la veille, puis donne au 22/09 son décrassage et laisse le 23/09 libre', async () => {
    await rematchRecent('pierre', PIERRE_MODEL, '2026-09-22');
    const adjustments = evaluateAdjustments(stateOn('2026-09-22'), store.sessions.map((s) => ({ ...s })));
    expect(await applyAdjustments('pierre', adjustments)).toBe(1);

    const [lendemain] = onDay('2026-09-22');
    expect(lendemain).toMatchObject({
      id: 'ses_2309', type: 'recovery', status: 'planned', title: 'Décrassage — 45 min', priority: 'optional',
      plannedDurationS: 2700, weekStart: '2026-09-21', decision: { by: 'rules' },
    });
    expect(lendemain!.plannedLoad).toBeGreaterThan(0);
    expect(lendemain!.rationale).toMatch(
      /^Ajustée par les règles de charge le \d\d\/\d\d — Test maximal prévu le 22\/09, couru le 21\/09 : son lendemain est un décrassage/,
    );
    expect(lendemain!.history?.at(-1)).toMatchObject({ by: 'rules' });
    expect(onDay('2026-09-23')).toEqual([]);
    expect(store.revisions.at(-1)?.changes).toEqual([
      expect.objectContaining({ date: '2026-09-23', before: 'Repos complet', after: 'déplacée au 2026-09-22 : décrassage' }),
    ]);

    // Une seconde relève ne change plus rien.
    expect(evaluateAdjustments(stateOn('2026-09-22'), store.sessions.map((s) => ({ ...s })))).toEqual([]);
    // « Vidé » au point du jour suivant : le décrassage devient le repos.
    const drained = evaluateAdjustments(stateOn('2026-09-22', { checkIn: { fatigue: 5 } }), store.sessions.map((s) => ({ ...s })));
    await applyAdjustments('pierre', drained, 'readiness');
    expect(onDay('2026-09-22')).toEqual([
      expect.objectContaining({ id: 'ses_2309', type: 'rest', title: 'Repos complet', plannedLoad: 0, plannedDurationS: 0 }),
    ]);
  });

  it('écrit la séance du lendemain quand le jour est vide', async () => {
    store.sessions = [
      { ...TEST_2109, date: '2026-09-25', plannedDate: '2026-09-26', weekStart: '2026-09-21', phase: 'build' },
      { ...RANDO, weekStart: '2026-09-21', phase: 'build' },
    ];
    await applyAdjustments('pierre', evaluateAdjustments(stateOn('2026-09-26'), store.sessions.map((s) => ({ ...s }))));
    expect(onDay('2026-09-26')).toEqual([
      expect.objectContaining({
        id: 'ses_test-lendemain', type: 'recovery', status: 'planned', weekStart: '2026-09-21', phase: 'build',
        decision: expect.objectContaining({ by: 'rules' }),
      }),
    ]);
    expect(store.revisions.at(-1)?.changes[0]).toMatchObject({ before: '—', after: 'ajoutée : décrassage' });
  });
});

// ── Le jugement des sept derniers jours, refait ──────────────────────────────

/**
 * Le décrassage du 22/09, couru comme prescrit — 48 min 15 à 9,2 km/h, 133 bpm
 * de moyenne, 14 % du temps au-dessus de 141 — et déclaré remplacé sur une
 * charge prévue de 8 points.
 */
function recoveryRun(hr: [number, number][] = [[125, 600], [133, 1500], [139, 390], [145, 300], [150, 105]]): ActivityStreams {
  const heartrate = hr.flatMap(([bpm, s]) => new Array<number>(s).fill(bpm));
  const n = heartrate.length;
  const velocity = new Array<number>(n).fill(2.547);
  return {
    time: velocity.map((_, i) => i), distance: velocity.map((v, i) => v * (i + 1)),
    altitude: new Array<number>(n).fill(200), velocity, grade: new Array<number>(n).fill(0), heartrate,
    moving: new Array<boolean>(n).fill(true),
  };
}

const DECRASSAGE_2209 = (): PlannedSession => ({
  id: 'ses_2209', athleteId: 'pierre', date: '2026-09-22', type: 'recovery', priority: 'optional',
  title: 'Décrassage — 45 min', intent: '', blocks: recovery(PIERRE_MODEL, 45).blocks,
  plannedLoad: 8, plannedMechanicalLoad: 1, plannedDurationS: 2700, status: 'replaced',
  completedActivityId: 'strava-2209',
  rationale:
    "Ce n'est pas la séance prescrite : 48'16\" pour 45'00\" et 41 points de charge pour 8 prévus. " +
    'Charge réalisée 410 % au-dessus du prévu. À surveiller sur la fraîcheur des jours suivants.',
});

describe('La passe des sept derniers jours rejuge ce qu’elle tient', () => {
  beforeEach(() => {
    store.sessions = [DECRASSAGE_2209()];
    store.activities = [activity('strava-2209', '2026-09-22')];
    store.streams = new Map([['strava-2209', recoveryRun()]]);
  });

  it('rend « faite » le décrassage du 22/09, une fois, et le dit', async () => {
    expect(await rematchRecent('pierre', PIERRE_MODEL, '2026-09-23')).toEqual([
      { activityId: 'strava-2209', sessionId: 'ses_2209' },
    ]);
    const s = store.sessions[0]!;
    expect(s).toMatchObject({ status: 'completed', completedActivityId: 'strava-2209', date: '2026-09-22' });
    // Ce qu'on lui avait fait dire était faux : le motif est remplacé, et le
    // rejugement laisse sa trace.
    expect(s.rationale).toMatch(/^Séance exécutée comme prescrite : 48'15" courues pour 45'00"/);
    expect(s.history?.at(-1)).toMatchObject({ by: 'rules' });
    expect(s.history?.at(-1)?.text).toMatch(/^Rejugée : « réalisée », et non plus « remplacée »\. Séance exécutée/);
    expect(store.analyses.get('strava-2209')?.compliance).toMatchObject({ outcome: 'fulfilled', verdict: 'on_target' });

    // Une seconde passe ne réécrit rien.
    const updates = store.updates;
    expect(await rematchRecent('pierre', PIERRE_MODEL, '2026-09-23')).toEqual([]);
    expect(store.updates).toBe(updates);
  });

  it('n’écrit rien quand le jugement tient', async () => {
    // Couru à 150 bpm, ce n'était pas le décrassage : remplacé il était, remplacé il reste.
    store.streams = new Map([['strava-2209', recoveryRun([[140, 900], [150, 2000]])]]);
    expect(await rematchRecent('pierre', PIERRE_MODEL, '2026-09-23')).toEqual([]);
    expect(store.updates).toBe(0);
    expect(store.analyses.has('strava-2209')).toBe(false);
    expect(store.sessions[0]!.rationale).toMatch(/^Ce n'est pas la séance prescrite/);
  });
});
