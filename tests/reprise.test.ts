import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIERRE, type Activity, type AthleteAnswer, type PlannedSession, type TrainingPlan } from '@cairn/core';
import { buildZones, runDurationOf, spikesAlong } from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * La reprise de la course, du 09 au 29/11 (`reprise.ts`, règle
 * `reprise_progression` d'`adapt.ts`).
 *
 * Le 09/11, Pierre court 50 min sans attendre le médecin du 12, et veut un
 * programme de course seulement, pour une SaintéSprint visée au haut de la
 * fourchette (2:11:30). Il ne doit pas être figé : une course de la reprise
 * monte d'une marche si la précédente s'est bien passée, reste si un signal
 * l'inquiète, redescend sur une douleur — facile alors, sans intensité —,
 * s'arrête sur une douleur forte ; un non du médecin la fait dans l'escalier ;
 * et le dossard se décide six jours avant, sur la dernière sortie longue.
 */

const store = vi.hoisted(() => ({
  sessions: [] as (PlannedSession & { weekStart?: string; phase?: string })[],
  revisions: [] as TrainingPlan['revisionLog'],
}));

vi.mock('@cairn/db', () => ({
  getLatestModel: async () => PIERRE_MODEL,
  getActivePlan: async () => ({ plan: { id: 'plan' }, weeks: [{ weekStart: '2026-11-09', phase: 'transition', sessions: [] }] }),
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
const { allowedLevel, applyAdjustments, evaluateAdjustments, judgeRun, pendingQuestions, raceGate, repriseDay, runSignals, validAnswer, SAINTESPRINT_TARGET_S } = lib;

const START = '2026-11-09';
const day = (i: number) => new Date(Date.parse(`${START}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const CEILING = 155;

/** La reprise telle que `layCompensation` la pose : une séance par jour, sa marche avec elle. */
function laid(): PlannedSession[] {
  return Array.from({ length: 21 }, (_, i) => {
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
    plan: { plan: { id: 'plan' }, weeks: [] }, answers, recentActivities: activities,
  }) as never;

/** Une course de la reprise faite : rattachée à une activité qui en court toute la durée. */
function done(id: string, over: Partial<Activity> = {}): Activity {
  const s = store.sessions.find((x) => x.id === id)!;
  Object.assign(s, { status: 'completed', completedActivityId: `a-${id}` });
  return run({ id: `a-${id}`, startDateLocal: `${s.date}T18:00:00`, movingTimeS: runDurationOf(s), distanceM: s.plannedDistanceM ?? 8000, ...over });
}
const doneFirst = () => done('r0');

const level = (id: string) => store.sessions.find((s) => s.id === id)!.program!.level;

beforeEach(() => {
  store.sessions = laid();
  store.revisions = [];
});

const at = (id: string) => store.sessions.find((s) => s.id === id)!;
const rules = async (today: string, answers: AthleteAnswer[] = [], activities: Activity[] = []) =>
  applyAdjustments('pierre', evaluateAdjustments(stateOn(today, answers, activities), store.sessions.map((s) => ({ ...s }))), 'readiness');

describe('La reprise, du 09 au 29/11', () => {
  it('ne porte que de la course, une marche à la fois, la SaintéSprint le 28 au haut de la fourchette', () => {
    // Rien d'autre que de la course et du repos : ni force, ni escalier, ni vélo.
    expect(new Set(store.sessions.map((s) => s.type))).toEqual(
      new Set(['endurance', 'rest', 'threshold', 'long_run', 'hill_repeats', 'race_pace', 'race']),
    );
    expect(store.sessions.filter((s) => /vélo|escalier|\bforce\b/i.test(JSON.stringify(s.blocks) + s.title))).toEqual([]);
    const runs = store.sessions.filter((s) => s.program && s.program.kind !== 'race');
    expect(runs.map((s) => [s.date.slice(8), s.program!.level, s.program!.kind])).toEqual([
      ['09', 3, 'easy'], ['11', 3, 'easy'], ['13', 4, 'tempo'], ['15', 5, 'long'], ['17', 4, 'tempo'], ['18', 3, 'easy'],
      ['19', 4, 'race_pace'], ['21', 5, 'long'], ['22', 3, 'easy'], ['24', 4, 'race_pace'], ['25', 3, 'easy'], ['27', 2, 'easy'],
    ]);
    // Chaque course ne demande au plus qu'une marche de plus que la précédente, et porte son jour dans le programme.
    runs.forEach((s, i) => i > 0 && expect(s.program!.level - runs[i - 1]!.program!.level).toBeLessThanOrEqual(1));
    runs.forEach((s) => expect(s.program!.day).toBe(Math.round((Date.parse(s.date) - Date.parse(START)) / 86_400_000)));
    // La course : 2:11:30, la borne rapide prédite le 09/11, et son plan d'allure.
    const race = at('r19');
    expect([race.date, race.title.startsWith('SaintéSprint')]).toEqual(['2026-11-28', true]);
    expect(SAINTESPRINT_TARGET_S).toBe(7890);
    expect(race.blocks[0]!.notes).toMatch(/2 h 11 30.*Chaponost, km 11 : 5:34\/km, au ravitaillement en 1 h 00/s);
    // Les trois jours avant la course : un footing, du repos, 25 min de trot.
    expect(store.sessions.filter((s) => s.date >= '2026-11-25' && s.date < '2026-11-28').map((s) => [s.type, s.plannedDurationS > 0 ? Math.round(runDurationOf(s) / 60) : 0]))
      .toEqual([['endurance', 39], ['rest', 0], ['endurance', 28]]);
  });

  it('pose l’allure de course à 5:10-5:20/km, le seuil à 4:30-4:40, et les footings au cœur sous 155', () => {
    const paces = (id: string) => at(id).blocks.filter((b) => b.paceRange).map((b) => b.paceRange);
    expect(paces('r10')).toEqual([['5:10', '5:20']]);
    expect(paces('r15')).toEqual([['5:10', '5:20']]);
    expect(paces('r4')).toEqual([['4:30', '4:40']]);
    // Le 09/11 dit ce qui a été couru — 151 bpm de moyenne, 168 au plus — : il n'a pas de plafond à tenir.
    expect(at('r0').blocks[0]!.hrRange).toEqual([141, 168]);
    expect(at('r6').type).toBe('long_run');
    for (const id of ['r2', 'r6', 'r9', 'r13', 'r16', 'r18']) {
      expect(at(id).blocks.filter((b) => !b.kind && b.zone === 'Z2').every((b) => b.hrRange?.[1] === CEILING)).toBe(true);
    }
  });

  it('ne pique qu’à la longue du 21/11 et à la course : la plus longue monte par paliers de moins de 10 %', () => {
    const planned = store.sessions.filter((s) => s.program && s.date > START).map((s) => ({ id: s.id, date: s.date, distanceM: s.plannedDistanceM ?? 0 }));
    const spikes = spikesAlong([{ date: START, distanceM: 10_184 }], planned).filter((v) => v.cls !== 'none').map((v) => [v.id, v.cls]);
    expect(spikes).toEqual([['r12', 'moderate'], ['r19', 'moderate']]);
  });

  it('juge une course : la douleur d’abord, puis la durée, l’effort, le cœur', () => {
    const base = { sessionId: 'x', date: day(0), level: 2, kind: 'easy' as const, done: true };
    expect(judgeRun({ ...base, painDuring: 6 }, CEILING).step).toBe('stop');
    expect(judgeRun({ ...base, painMorning: 3 }, CEILING)).toMatchObject({ step: 'down', painful: true });
    expect(judgeRun({ ...base, painDuring: 2 }, CEILING)).toMatchObject({ step: 'hold', painful: true });
    expect(judgeRun({ ...base, completion: 0.7 }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, rpe: 8 }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, avgHr: 162 }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, painDuring: 0, completion: 1 }, CEILING)).toEqual({ step: 'up', reason: 'sans douleur' });
    expect(judgeRun(base, CEILING).reason).toContain('pas été dite');
  });

  it('lève un arrêt pour douleur sur un matin sous 3, une marche plus bas', () => {
    const runs = [{ sessionId: 'r4', date: day(4), level: 3, kind: 'easy' as const, done: true, painDuring: 5 }];
    expect(allowedLevel(runs, [], CEILING)).toMatchObject({ step: 'stop', level: 0 });
    const relief = [answer('morning_pain', day(6), { score: 1 })];
    expect(allowedLevel(runs, relief, CEILING)).toMatchObject({ step: 'down', level: 2 });
  });

  it('écrit la prochaine course à la marche que la précédente permet, et seulement elle', async () => {
    const activities = [doneFirst()];
    const answers = [answer('run_pain', 'r0', { score: 3, site: 'achille' })];
    const adjustments = evaluateAdjustments(stateOn(day(1), answers, activities), store.sessions.map((s) => ({ ...s })));
    expect(adjustments.filter((a) => a.rule === 'reprise_progression').map((a) => a.sessionId)).toEqual(['r2']);
    await applyAdjustments('pierre', adjustments, 'readiness');
    expect([level('r2'), at('r2').title]).toEqual([2, expect.stringMatching(/^Footing de reprise 37 min/)]);
    expect(at('r2').rationale).toMatch(/douleur de 3 sur 10/);
    // Réévaluée sur le même état, la règle ne réécrit plus rien.
    expect(evaluateAdjustments(stateOn(day(1), answers, activities), store.sessions.map((s) => ({ ...s }))).filter((a) => a.rule === 'reprise_progression')).toEqual([]);
  });

  it('remplace la course par la marche à plat sur une douleur forte, sans escalier qui la redescende', async () => {
    await rules(day(1), [answer('run_pain', 'r0', { score: 5, site: 'tibia' })], [doneFirst()]);
    expect([at('r2').title, level('r2')]).toEqual([expect.stringMatching(/^Marche à plat/), 0]);
    expect(at('r2').blocks.some((b) => b.exercise === 'escalier-immeuble')).toBe(false);
  });

  it('court facile la séance de qualité qui suit une douleur, même à sa marche', async () => {
    // La longue du 15/11 laisse une douleur de 3 au tendon : la marche 4 reste permise, l'intensité non.
    const activities = ['r0', 'r2', 'r4', 'r6'].map((id) => done(id));
    const answers = [
      ...['r0', 'r2', 'r4'].map((id) => answer('run_pain', id, { score: 0 })),
      answer('run_pain', 'r6', { score: 3, site: 'achille' }), answer('pain_pattern', 'r6', { pattern: 'eases' }),
    ];
    await rules(day(7), answers, activities);
    expect([level('r8'), at('r8').program!.kind, at('r8').type]).toEqual([4, 'easy', 'endurance']);
    expect(at('r8').rationale).toMatch(/sans intensité/);
  });

  it('rend sa séance à la course qui retrouve sa marche : celle du programme, pas une séance de même marche', async () => {
    const activities = [doneFirst(), done('r2')];
    const answers = [answer('run_pain', 'r0', { score: 0 }), answer('run_pain', 'r2', { score: 0 })];
    // Le seuil du 13/11 avait été ramené à la marche 3.
    Object.assign(at('r4'), { program: { ...at('r4').program!, level: 3, kind: 'easy' }, type: 'endurance', title: 'Footing de reprise 40 min' });
    await rules(day(3), answers, activities);
    expect([level('r4'), at('r4').type, at('r4').title]).toEqual([4, 'threshold', expect.stringMatching(/^Seuil en trois blocs/)]);
  });

  it('laisse courir celui qui reprend de lui-même ; un non du médecin fait la course dans l’escalier', async () => {
    const self = [answer('clearance', 'reprise', { choice: 'self' }, '2026-11-09T19:00:00Z')];
    const runs = [doneFirst()];
    await rules(day(1), self, runs);
    expect(at('r2').type).toBe('endurance');
    // Son avis se redemande trois jours plus tard, et chaque jour jusqu'à ce qu'il soit dit.
    const asked = (today: string, said = self) => pendingQuestions({ today, sessions: store.sessions, activities: [], answers: said }).filter((q) => q.question === 'clearance');
    expect([asked('2026-11-10').length, asked('2026-11-11').length, asked('2026-11-12').length]).toEqual([0, 0, 1]);
    expect(asked('2026-11-12')[0]!.choices.map((c) => c.value.choice)).toEqual(['yes', 'not_yet', 'no']);
    // « Pas encore vu » ne l'arrête pas : la décision reste la sienne.
    const notSeen = [...self, answer('clearance', 'reprise', { choice: 'not_yet' }, '2026-11-12T19:00:00Z')];
    runs.push(done('r2'));
    await rules(day(3), notSeen, runs);
    expect(at('r4').type).toBe('threshold');
    // Un non, si : l'escalier, jusqu'à son accord.
    const no = [...self, answer('clearance', 'reprise', { choice: 'no' }, '2026-11-12T19:00:00Z')];
    await rules(day(3), no, runs);
    expect([at('r4').type, at('r4').title, level('r4')]).toEqual(['cross_training', expect.stringMatching(/^Escalier facile/), 0]);
    expect(at('r4').rationale).toMatch(/a dit non/);
  });

  it('fait la course dans l’escalier quand le médecin n’a pas encore dit oui, sans décision de Pierre', async () => {
    await rules(day(0), [answer('clearance', 'reprise', { choice: 'not_yet' }, '2026-11-08T19:00:00Z')]);
    expect([at('r0').type, level('r0')]).toEqual(['cross_training', 0]);
    await rules(day(0), [answer('clearance', 'reprise', { choice: 'yes' }, '2026-11-09T08:00:00Z')]);
    expect([at('r0').type, level('r0'), at('r0').title]).toEqual(['endurance', 3, expect.stringMatching(/^Footing/)]);
  });

  it('décide le dossard six jours avant, sur la dernière sortie longue : une plus ancienne ne la remplace pas', async () => {
    const gateDay = day(13); // 22/11
    // La longue du 15 faite sans douleur, celle du 21 manquée : la Saintétic.
    const activities = ['r0', 'r2', 'r4', 'r6', 'r8', 'r9', 'r10'].map((id) => done(id));
    const answers = ['r0', 'r2', 'r4', 'r6', 'r8', 'r9', 'r10'].map((id) => answer('run_pain', id, { score: 0 }));
    await rules(gateDay, answers, activities);
    expect(at('r19').title).toMatch(/Saintétic/);
    expect(at('r19').rationale).toMatch(/sortie longue du 2026-11-21 n'a pas été faite/);
    // Faite sans douleur, le critère est rempli ; une douleur de 3 le lendemain, non.
    const long = { sessionId: 'r12', date: day(12), level: 5, kind: 'long' as const, done: true, painDuring: 0, painMorning: 1 };
    const older = { ...long, sessionId: 'r6', date: day(6) };
    expect(raceGate([older, long], [], CEILING).met).toBe(true);
    expect(raceGate([older, { ...long, painMorning: 3 }], [], CEILING).met).toBe(false);
    expect(raceGate([older, { ...long, done: false }], [], CEILING).met).toBe(false);
  });
});

describe('Ce que Cairn demande', () => {
  it('l’accord du médecin avant la première course, puis la douleur et le réveil après chaque course', () => {
    expect(pendingQuestions({ today: '2026-11-05', sessions: store.sessions, activities: [], answers: [] })).toEqual([]);
    expect(pendingQuestions({ today: '2026-11-06', sessions: store.sessions, activities: [], answers: [] }).map((q) => q.question)).toEqual(['clearance']);
    const activities = [doneFirst()];
    const cleared = [answer('clearance', 'reprise', { choice: 'yes' })];
    // Le soir de la course : la douleur ; une course sans montre : l'effort. Un lundi, la semaine et son seuil du 13 : les jours chargés.
    expect(pendingQuestions({ today: day(0), sessions: store.sessions, activities, answers: cleared }).map((q) => q.question)).toEqual(['run_pain', 'run_rpe', 'week_load']);
    // Le lendemain matin, en plus : le réveil.
    const asked = pendingQuestions({ today: day(1), sessions: store.sessions, activities, answers: [...cleared, answer('run_pain', 'r0', { score: 0 })] });
    expect(asked.map((q) => q.question)).toEqual(['morning_pain', 'run_rpe']);
    expect(asked[0]!.why).toMatch(/lendemain/);
  });

  it('n’accepte que les réponses que la question attend', () => {
    expect(validAnswer('clearance', { choice: 'yes' })).toBeNull();
    expect(validAnswer('clearance', { choice: 'self' })).toBeNull();
    expect(validAnswer('clearance', { choice: 'peut-être' })).not.toBeNull();
    expect(validAnswer('run_pain', { score: 11 })).not.toBeNull();
    expect(validAnswer('run_pain', { score: 3, site: 'achille' })).toBeNull();
    expect(validAnswer('run_rpe', { score: 0 })).not.toBeNull();
  });
});
