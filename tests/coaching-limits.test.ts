import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIERRE, type Activity, type AthleteAnswer, type PlannedSession, type TrainingPlan } from '@cairn/core';
import { buildZones, classifySpike, longestBefore, runDurationOf, spikesAlong } from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Ce que l'épisode du 02/11/2026 de « Dans la tête d'un coureur » (« IA, applis,
 * montres : a-t-on encore besoin d'un coach ? ») et la littérature reprochent à
 * un coach artificiel, et ce que Cairn en fait, règle par règle :
 *
 *  · le cœur seul juge mal — chaleur, nuit courte, stress le font monter de
 *    cinq à dix battements : Cairn demande pourquoi, et une cause qui passe ne
 *    retient pas la reprise ;
 *  · une douleur se lit à son comportement : celle qui monte en courant, qui
 *    reste au repos, ou qui revient à l'os, arrête la course jusqu'au médecin ;
 *  · le pic d'une séance contre la plus longue des trente jours (BJSM 2025) est
 *    le signal de charge le mieux étayé : il est classé et plafonné ;
 *  · l'entraîneur anticipe la semaine : un jour annoncé chargé rend la séance
 *    dure progressive ;
 *  · un modèle de langage perd le fil d'une longue préparation : le brief la
 *    relit en base à chaque appel, et dit ce qu'il ne sait pas.
 */

const store = vi.hoisted(() => ({
  sessions: [] as PlannedSession[],
  revisions: [] as TrainingPlan['revisionLog'],
}));

vi.mock('@cairn/db', () => ({
  getLatestModel: async () => PIERRE_MODEL,
  getActivePlan: async () => ({ plan: { id: 'plan' }, weeks: [] }),
  appendPlanRevision: async (_id: string, revision: TrainingPlan['revisionLog'][number]) => {
    store.revisions.push(revision);
  },
  insertSession: async (_plan: string, s: PlannedSession) => {
    store.sessions.push({ ...s });
  },
  listPlannedSessions: async (_a: string, from: string, to: string) =>
    store.sessions.filter((s) => s.date >= from && s.date <= to).map((s) => ({ ...s })),
  updateSession: async (id: string, patch: Partial<PlannedSession>) => {
    const s = store.sessions.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  },
}));

const lib = await import('@cairn/coach');
const {
  allowedLevel, applyAdjustments, buildCoachingBrief, evaluateAdjustments, judgeRun, pendingQuestions, raceCriteria,
  repriseDay, runSignals, validAnswer,
} = lib;

const START = '2026-11-13';
const day = (i: number) => new Date(Date.parse(`${START}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const CEILING = 155;

function laid(): PlannedSession[] {
  return Array.from({ length: 17 }, (_, i) => {
    const t = repriseDay(PIERRE_MODEL, i);
    return {
      id: `r${i}`, athleteId: 'pierre', date: day(i), type: t.type, title: t.title, intent: t.intent, blocks: t.blocks,
      plannedLoad: t.plannedLoad, plannedMechanicalLoad: t.plannedMechanicalLoad, plannedDurationS: t.durationS,
      priority: t.priority, status: 'planned', ...(t.program ? { program: t.program } : {}),
      ...(t.plannedDistanceM ? { plannedDistanceM: t.plannedDistanceM } : {}),
      decision: { at: '2026-11-09T10:00:00Z', by: 'coach', summary: 'Reprise.' },
    } as PlannedSession;
  });
}

const answer = (question: AthleteAnswer['question'], subject: string, value: AthleteAnswer['value'], at = '2026-11-13T20:00:00Z'): AthleteAnswer =>
  ({ athleteId: 'pierre', question, subject, value, answeredAt: at });

const run = (over: Partial<Activity> & Pick<Activity, 'id' | 'startDateLocal' | 'movingTimeS'>): Activity =>
  ({ athleteId: 'pierre', name: 'Course', sportType: 'Run', startDate: over.startDateLocal, distanceM: 4000, elapsedTimeS: over.movingTimeS, totalElevationGainM: 0, averageSpeedMs: 2.8, ...over }) as Activity;

const stateOn = (date: string, answers: AthleteAnswer[] = [], activities: Activity[] = []) =>
  ({
    today: { date, ctl: 38, atl: 30, tsb: 8, mechanicalTsb: 3, acwr: 1, mechanicalAcwr: 1, rampRate: 1, monotony: 1, tsbLabel: '', acwrLabel: '', acwrRisk: 'low' },
    readiness: { date, score: 70, verdict: 'green', components: {}, recommendation: '' },
    absences: [], model: PIERRE_MODEL, profile: PIERRE, eccentricCircuitsDone: 20, zones: buildZones(PIERRE_MODEL),
    plan: { plan: { id: 'plan', revisionLog: [] }, weeks: [] }, answers, recentActivities: activities, upcomingRaces: [],
  }) as never;

/** Une course de la reprise faite, rattachée à son activité. */
function done(id: string, over: Partial<Activity> = {}): Activity {
  const s = store.sessions.find((x) => x.id === id)!;
  Object.assign(s, { status: 'completed', completedActivityId: `a-${id}` });
  return run({ id: `a-${id}`, startDateLocal: `${s.date}T18:00:00`, movingTimeS: runDurationOf(s), ...over });
}

const level = (id: string) => store.sessions.find((s) => s.id === id)!.program!.level;

beforeEach(() => {
  store.sessions = laid();
  store.revisions = [];
});

describe('Le pic d’une séance (Frandsen, BJSM 2025)', () => {
  it('classe contre la plus longue sortie des trente jours d’avant, bornes de l’étude', () => {
    const ref = { date: '2026-11-01', distanceM: 10_000 };
    expect(classifySpike(11_000, ref).cls).toBe('none');
    expect(classifySpike(11_001, ref).cls).toBe('small');
    expect(classifySpike(13_001, ref).cls).toBe('moderate');
    expect(classifySpike(20_001, ref).cls).toBe('large');
    expect(classifySpike(9_000, undefined).cls).toBe('no_reference');
  });

  it('ne regarde que les trente jours strictement avant la séance', () => {
    const runs = [{ date: '2026-10-01', distanceM: 30_000 }, { date: '2026-10-20', distanceM: 12_000 }, { date: '2026-11-10', distanceM: 40_000 }];
    expect(longestBefore(runs, '2026-11-10')).toEqual({ date: '2026-10-20', distanceM: 12_000 });
  });

  it('compte une sortie prévue comme faite pour juger la suivante', () => {
    const along = spikesAlong([{ date: '2026-11-01', distanceM: 10_000 }], [
      { id: 'long', date: '2026-11-07', distanceM: 12_000 },
      { id: 'race', date: '2026-11-14', distanceM: 25_000 },
    ]);
    expect(along.map((v) => [v.id, v.cls, v.referenceM])).toEqual([['long', 'small', 10_000], ['race', 'large', 12_000]]);
  });

  it('ramène à +10 % une sortie qui dépasse la plus longue des trente jours, jamais une course ni la reprise', () => {
    const today = '2026-12-07';
    const acts = ['2026-11-20', '2026-11-25', '2026-11-30', '2026-12-04'].map((d, i) =>
      run({ id: `x${i}`, startDateLocal: `${d}T08:00:00`, movingTimeS: 3600, distanceM: i === 3 ? 15_000 : 10_000 }));
    const long: PlannedSession = {
      id: 'long', athleteId: 'pierre', date: '2026-12-12', type: 'long_run', title: 'Sortie longue 2 h', intent: '',
      priority: 'key', status: 'planned', blocks: [{ label: 'Sortie longue', zone: 'Z2', durationS: 7200 }],
      plannedLoad: 120, plannedMechanicalLoad: 40, plannedDurationS: 7200, plannedDistanceM: 20_000,
    };
    const race: PlannedSession = { ...long, id: 'race', date: '2026-12-13', type: 'race', title: 'Course', plannedDistanceM: 30_000 };
    const adj = evaluateAdjustments(stateOn(today, [], acts), [long, race]).filter((a) => a.rule === 'single_session_spike');
    expect(adj.map((a) => a.sessionId)).toEqual(['long']);
    // 15 km × 1,10 = 16,5 km sur 20 : un facteur de 0,82.
    expect(adj[0]!.factor).toBe(0.82);
    expect(adj[0]!.reason).toMatch(/\+33 % sur ta plus longue sortie des 30 jours d'avant \(15,0 km le 04\/12\)/);
    // Sans trois sorties dans les trente jours, la plus longue ne dit rien : la règle se tait.
    expect(evaluateAdjustments(stateOn(today, [], acts.slice(2)), [long]).filter((a) => a.rule === 'single_session_spike')).toEqual([]);
  });
});

describe('Le cœur ne juge pas seul : Cairn demande pourquoi', () => {
  const base = { sessionId: 'x', date: day(0), level: 2, kind: 'easy' as const, done: true, completion: 1, painDuring: 0, avgHr: 163 };

  it('laisse monter une course au cœur haut quand la cause passe — chaleur, nuit courte, journée chargée', () => {
    expect(judgeRun(base, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, cause: 'heat' }, CEILING)).toMatchObject({ step: 'up', reason: expect.stringMatching(/chaleur/) });
    expect(judgeRun({ ...base, cause: 'stress' }, CEILING).step).toBe('up');
    // Une fatigue qui dure, un rhume : on reste.
    expect(judgeRun({ ...base, cause: 'fatigue' }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, cause: 'illness' }, CEILING).step).toBe('hold');
  });

  it('écourtée, une course reste sur sa marche, quelle qu’en soit la raison', () => {
    expect(judgeRun({ ...base, avgHr: 140, completion: 0.6, cause: 'time' }, CEILING)).toMatchObject({ step: 'hold', reason: expect.stringMatching(/manque de temps/) });
  });

  it('retient deux courses de suite plus dures que prévu, même expliquées', () => {
    const runs = [
      { ...base, sessionId: 'a', date: day(0), level: 1, cause: 'heat' as const },
      { ...base, sessionId: 'b', date: day(2), level: 2, cause: 'sleep' as const },
    ];
    expect(allowedLevel(runs, [], CEILING)).toMatchObject({ step: 'hold', level: 2, reason: expect.stringMatching(/deux courses de suite/) });
  });

  it('demande la cause d’une course au cœur haut, et se tait quand la douleur l’a déjà dite', () => {
    const acts = [done('r0', { averageHr: 165 })];
    const cleared = [answer('clearance', 'reprise', { choice: 'yes' }), answer('run_pain', 'r0', { score: 0 })];
    const asked = pendingQuestions({ today: day(0), sessions: store.sessions, activities: acts, answers: cleared, easyCeiling: CEILING });
    const q = asked.find((x) => x.question === 'deviation_cause')!;
    expect(q.prompt).toMatch(/165 bpm de moyenne, au-dessus de ton endurance \(155\)/);
    expect(q.choices.map((c) => c.value.cause)).toContain('heat');
    const sore = [cleared[0]!, answer('run_pain', 'r0', { score: 3, site: 'mollet' })];
    expect(pendingQuestions({ today: day(0), sessions: store.sessions, activities: acts, answers: sore, easyCeiling: CEILING })
      .map((x) => x.question)).not.toContain('deviation_cause');
  });

  it('relit la cause donnée et fait monter la course suivante', async () => {
    const acts = [done('r0', { averageHr: 165 })];
    const answers = [
      answer('clearance', 'reprise', { choice: 'yes' }), answer('run_pain', 'r0', { score: 0 }),
      answer('morning_pain', day(1), { score: 0 }), answer('deviation_cause', 'r0', { cause: 'heat' }),
    ];
    await applyAdjustments('pierre', evaluateAdjustments(stateOn(day(1), answers, acts), store.sessions.map((s) => ({ ...s }))), 'readiness');
    expect(level('r2')).toBe(2);
    // Sans cause, la même course la retenait à la marche 1.
    store.sessions = laid();
    const silent = [done('r0', { averageHr: 165 })];
    await applyAdjustments('pierre', evaluateAdjustments(stateOn(day(1), answers.slice(0, 3), silent), store.sessions.map((s) => ({ ...s }))), 'readiness');
    expect(level('r2')).toBe(1);
  });
});

describe('Une douleur se lit à son comportement', () => {
  it('arrête la course jusqu’au médecin quand elle monte en courant — la marche à plat, même avec l’accord d’avant', async () => {
    const acts = [done('r0')];
    const answers = [
      answer('clearance', 'reprise', { choice: 'yes' }, '2026-11-12T10:00:00Z'),
      answer('run_pain', 'r0', { score: 3, site: 'tibia' }), answer('pain_pattern', 'r0', { pattern: 'worsens' }),
    ];
    const signals = runSignals(store.sessions, acts, answers, day(1));
    expect(allowedLevel(signals, answers, CEILING)).toMatchObject({ step: 'stop', level: 0, medical: true });
    await applyAdjustments('pierre', evaluateAdjustments(stateOn(day(1), answers, acts), store.sessions.map((s) => ({ ...s }))), 'readiness');
    const next = store.sessions.find((s) => s.id === 'r2')!;
    expect(next.title).toMatch(/Marche à plat/);
    // Et c'est le médecin qu'on lui demande, en premier.
    const asked = pendingQuestions({ today: day(1), sessions: store.sessions, activities: acts, answers, easyCeiling: CEILING });
    expect(asked[0]).toMatchObject({ question: 'clearance', subject: 'after:r0' });
    // Son oui rouvre la course, une marche sous celle qui a inquiété.
    const ok = [...answers, answer('clearance', 'after:r0', { choice: 'yes' }, '2026-11-15T10:00:00Z')];
    expect(allowedLevel(runSignals(store.sessions, acts, ok, day(2)), ok, CEILING)).toMatchObject({ step: 'down', level: 1 });
  });

  it('une douleur qui s’estompe en courant suit la règle ordinaire : à 3, une marche plus bas', () => {
    const acts = [done('r0'), done('r2')];
    const answers = [
      answer('run_pain', 'r0', { score: 0 }), answer('run_pain', 'r2', { score: 3, site: 'achille' }),
      answer('pain_pattern', 'r2', { pattern: 'eases' }),
    ];
    expect(allowedLevel(runSignals(store.sessions, acts, answers, day(3)), answers, CEILING)).toMatchObject({ step: 'down', level: 1 });
  });

  it('deux douleurs de 3 au tibia en quinze jours : le motif d’une fracture de fatigue, arrêt médical', () => {
    const acts = [done('r0'), done('r2')];
    const answers = [
      answer('run_pain', 'r0', { score: 3, site: 'tibia' }), answer('morning_pain', day(1), { score: 1 }),
      answer('run_pain', 'r2', { score: 3, site: 'tibia' }),
    ];
    const verdict = allowedLevel(runSignals(store.sessions, acts, answers, day(3)), answers, CEILING);
    expect(verdict).toMatchObject({ step: 'stop', medical: true });
    expect(verdict.reason).toMatch(/deuxième fois/);
  });

  it('demande comment elle s’est comportée dès 2 sur 10', () => {
    const acts = [done('r0')];
    const answers = [answer('clearance', 'reprise', { choice: 'yes' }), answer('run_pain', 'r0', { score: 2, site: 'genou' })];
    const asked = pendingQuestions({ today: day(0), sessions: store.sessions, activities: acts, answers, easyCeiling: CEILING });
    expect(asked.find((q) => q.question === 'pain_pattern')!.choices.map((c) => c.value.pattern)).toEqual(['eases', 'steady', 'worsens', 'at_rest']);
  });
});

describe('La semaine qui vient : les jours chargés', () => {
  it('se demande le week-end avant une semaine qui porte une séance dure, jours à cocher', () => {
    const q = pendingQuestions({ today: '2026-11-14', sessions: store.sessions, activities: [], answers: [answer('clearance', 'reprise', { choice: 'yes' })] })
      .find((x) => x.question === 'week_load')!;
    expect(q.subject).toBe('2026-11-16');
    expect(q.days!.map((d) => d.day)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    // Le tempo du jeudi, seul : la sortie longue facile du samedi se court à son allure, quel que soit le jour.
    expect(q.why).toMatch(/: jeu\. 19\/11\.$/);
    // La semaine de la course n'en porte qu'une à rendre progressive : l'allure de course du mardi.
    const race = pendingQuestions({ today: '2026-11-22', sessions: store.sessions, activities: [], answers: [answer('clearance', 'reprise', { choice: 'yes' })] })
      .find((x) => x.question === 'week_load')!;
    expect(race.why).toMatch(/: mar\. 24\/11\.$/);
  });

  it('rend progressive la séance dure d’un jour chargé, et laisse les footings', () => {
    const answers = [answer('week_load', '2026-11-16', { days: ['2026-11-17', '2026-11-19'] })];
    const adj = evaluateAdjustments(stateOn('2026-11-16', answers), store.sessions.map((s) => ({ ...s })))
      .filter((a) => a.rule === 'charged_day');
    expect(adj.map((a) => a.date)).toEqual(['2026-11-19']);
    expect(adj[0]!.action).toBe('soften');
    expect(adj[0]!.reason).toMatch(/progressive/);
  });

  it('valide les réponses nouvelles, et refuse le reste', () => {
    expect(validAnswer('week_load', { days: [] })).toBeNull();
    expect(validAnswer('week_load', { days: ['19/11'] })).toMatch(/AAAA-MM-JJ/);
    expect(validAnswer('deviation_cause', { cause: 'heat' })).toBeNull();
    expect(validAnswer('deviation_cause', { cause: 'lune' })).toMatch(/cause/);
    expect(validAnswer('pain_pattern', { pattern: 'at_rest' })).toBeNull();
  });
});

describe('Les preuves avant la réassurance, et le fil relu en base', () => {
  it('dit où en est chaque critère du dossard, et ce que coûte la course en pic', () => {
    const acts = [done('r0', { distanceM: 4000 })];
    const answers = [answer('clearance', 'reprise', { choice: 'yes' }, '2026-11-12T10:00:00Z')];
    const c = raceCriteria(stateOn(day(1), answers, acts), store.sessions)!;
    expect(c.gateDate).toBe('2026-11-22');
    expect(Object.fromEntries(c.criteria.map((x) => [x.key, x.status]))).toEqual({
      clearance: 'met', ladder: 'open', long: 'open', pain: 'met', spike: 'info',
    });
    // La douleur non dite n'est jamais réputée absente.
    expect(c.criteria.find((x) => x.key === 'ladder')!.evidence).toMatch(/pas été dite pour le 13\/11/);
    // La SaintéSprint contre la sortie longue du 21/11 : un pic, dit avec son facteur et le repli.
    const spike = c.criteria.find((x) => x.key === 'spike')!.evidence;
    // La sortie longue de 1 h 15, à ses allures, est la référence ; la Saintétic, 13 km, n'en serait pas un.
    expect(spike).toMatch(/^24,8 km : \+\d+ % sur ta plus longue sortie des 30 jours d'avant \(\d+,\d km le 21\/11\)/);
    expect(spike).toMatch(/multiplié par 1,52/);
    expect(spike).toMatch(/La Saintétic \(13 km\) n'en serait pas un : −\d+ %/);
  });

  it('écrit le fil du jour : critères, questions en attente, ce que Cairn ne sait pas', () => {
    const acts = [done('r0', { distanceM: 4000 })];
    const brief = buildCoachingBrief(stateOn(day(0), [], acts), store.sessions, { lastCheckInDate: '2026-10-02' });
    expect(brief).toMatch(/^# Le fil — 2026-11-13/);
    expect(brief).toMatch(/\[ouvert\] L'accord du médecin/);
    expect(brief).toMatch(/## En attente de Pierre\n- Ton médecin t'autorise-t-il à recourir \?/);
    expect(brief).toMatch(/aucun point du jour depuis le 02\/10/);
    expect(brief).toMatch(/fait foi sur tout ce qui a été dit plus haut/);
  });
});
