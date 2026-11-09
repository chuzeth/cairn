import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIERRE, type Activity, type AthleteAnswer, type PlannedSession, type TrainingPlan } from '@cairn/core';
import { buildZones } from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * La reprise de la course, du 13 au 29/11 (`reprise.ts`, règle
 * `reprise_progression` d'`adapt.ts`).
 *
 * Le 09/11, Pierre veut un programme qui ne soit pas figé, qui se réajuste sur
 * ce qui arrive sans qu'il ait à le raconter, et qui lui demande ce que les
 * données ne disent pas. Une course de la reprise monte d'une marche si la
 * précédente s'est bien passée, reste si un signal l'inquiète, redescend sur une
 * douleur, s'arrête sur une douleur forte ; sans l'accord du médecin, elle se
 * fait dans l'escalier ; et le dossard de la SaintéSprint se décide six jours avant, sur
 * la sortie longue.
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
const { allowedLevel, applyAdjustments, evaluateAdjustments, judgeRun, pendingQuestions, raceGate, repriseDay, runSignals, validAnswer } = lib;

const START = '2026-11-13';
const day = (i: number) => new Date(Date.parse(`${START}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
const CEILING = 155;

/** La reprise telle que `layCompensation` la pose : une séance par jour, sa marche avec elle. */
function laid(): PlannedSession[] {
  return Array.from({ length: 17 }, (_, i) => {
    const t = repriseDay(PIERRE_MODEL, i);
    return {
      id: `r${i}`, athleteId: 'pierre', date: day(i), type: t.type, title: t.title, intent: t.intent, blocks: t.blocks,
      plannedLoad: t.plannedLoad, plannedMechanicalLoad: t.plannedMechanicalLoad, plannedDurationS: t.durationS,
      priority: t.priority, status: 'planned', ...(t.program ? { program: t.program } : {}),
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

/** Le 13/11 fait : sa course rattachée à une activité de `minutes`. */
function doneFirst(minutes = 34): Activity {
  const s = store.sessions.find((x) => x.id === 'r0')!;
  Object.assign(s, { status: 'completed', completedActivityId: 'a0' });
  return run({ id: 'a0', startDateLocal: `${day(0)}T18:00:00`, movingTimeS: minutes * 60 });
}

const level = (id: string) => store.sessions.find((s) => s.id === id)!.program!.level;

beforeEach(() => {
  store.sessions = laid();
  store.revisions = [];
});

describe('La reprise, du 13 au 29/11', () => {
  it('monte la course une marche à la fois, la force et l’escalier entre deux, sans vélo, la SaintéSprint le 28', () => {
    const runs = store.sessions.filter((s) => s.program && s.program.kind !== 'race');
    expect(runs.map((s) => [s.date, s.program!.level])).toEqual([
      ['2026-11-13', 1], ['2026-11-15', 2], ['2026-11-17', 3], ['2026-11-19', 4], ['2026-11-21', 5],
      ['2026-11-23', 3], ['2026-11-24', 4], ['2026-11-26', 2],
    ]);
    // Jamais deux marches d'un coup : chaque course ne demande au plus qu'une marche de plus que la précédente.
    runs.forEach((s, i) => i > 0 && expect(s.program!.level - runs[i - 1]!.program!.level).toBeLessThanOrEqual(1));
    const race = store.sessions.find((s) => s.type === 'race')!;
    expect([race.date, race.title.startsWith('SaintéSprint')]).toEqual(['2026-11-28', true]);
    // Rien de dur les trois jours avant la course, la veille au repos.
    expect(store.sessions.filter((s) => s.date >= '2026-11-25' && s.date < '2026-11-28').map((s) => s.type)).toEqual(['cross_training', 'endurance', 'rest']);
    // Pierre n'a pas de vélo (09/11) : aucune séance n'en demande.
    expect(store.sessions.filter((s) => /vélo/i.test(JSON.stringify(s.blocks) + s.title))).toEqual([]);
    // Deux courses rapprochées ne sont pas toutes deux « clefs » : la règle des 48 h ne déplacerait rien.
    expect(store.sessions.find((s) => s.date === '2026-11-23')!.priority).toBe('support');
  });

  it('juge une course : la douleur d’abord, puis la durée, l’effort, le cœur', () => {
    const base = { sessionId: 'x', date: day(0), level: 2, kind: 'easy' as const, done: true };
    expect(judgeRun({ ...base, painDuring: 6 }, CEILING).step).toBe('stop');
    expect(judgeRun({ ...base, painMorning: 3 }, CEILING).step).toBe('down');
    expect(judgeRun({ ...base, painDuring: 2 }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, completion: 0.7 }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, rpe: 8 }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, avgHr: 162 }, CEILING).step).toBe('hold');
    expect(judgeRun({ ...base, painDuring: 0, completion: 1 }, CEILING)).toEqual({ step: 'up', reason: 'sans douleur' });
    // Sans réponse, la reprise continue — et le dit.
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
    const signals = runSignals(store.sessions, activities, answers, day(1));
    expect(signals[0]).toMatchObject({ level: 1, done: true, painDuring: 3 });
    const adjustments = evaluateAdjustments(stateOn(day(1), answers, activities), store.sessions.map((s) => ({ ...s })));
    const progression = adjustments.filter((a) => a.rule === 'reprise_progression');
    // Seule la course suivante est réécrite : celle d'après se jugera sur ce que celle-ci aura donné.
    expect(progression.map((a) => a.sessionId)).toEqual(['r2']);
    await applyAdjustments('pierre', adjustments, 'readiness');
    // Une marche plus bas que 1, c'est encore la course-marche : la marche 2 attend.
    expect(level('r2')).toBe(1);
    expect(store.sessions.find((s) => s.id === 'r2')!.title).toMatch(/Course-marche/);
    expect(store.sessions.find((s) => s.id === 'r2')!.rationale).toMatch(/douleur de 3 sur 10/);
    // Réévaluée sur le même état, la règle ne réécrit plus rien.
    expect(evaluateAdjustments(stateOn(day(1), answers, activities), store.sessions.map((s) => ({ ...s }))).filter((a) => a.rule === 'reprise_progression')).toEqual([]);
  });

  it('remplace la course par la marche à plat sur une douleur forte, sans escalier qui la redescende', async () => {
    const activities = [doneFirst()];
    const answers = [answer('run_pain', 'r0', { score: 5, site: 'tibia' })];
    await applyAdjustments('pierre', evaluateAdjustments(stateOn(day(1), answers, activities), store.sessions.map((s) => ({ ...s }))), 'readiness');
    const next = store.sessions.find((s) => s.id === 'r2')!;
    expect([next.title, next.program!.level]).toEqual([expect.stringMatching(/^Marche à plat/), 0]);
    expect(next.blocks.some((b) => b.exercise === 'escalier-immeuble')).toBe(false);
  });

  it('rend sa marche à la course quand la douleur est retombée et que la marche d’avant est passée', async () => {
    const activities = [doneFirst()];
    const answers = [answer('run_pain', 'r0', { score: 0 }), answer('morning_pain', day(1), { score: 0 })];
    const adj = evaluateAdjustments(stateOn(day(1), answers, activities), store.sessions.map((s) => ({ ...s }))).filter((a) => a.rule === 'reprise_progression');
    expect(adj).toEqual([]);
    expect(level('r2')).toBe(2);
  });

  it('fait la course dans l’escalier tant que le médecin n’a pas dit oui', async () => {
    const answers = [answer('clearance', 'reprise', { choice: 'not_yet' }, '2026-11-12T19:00:00Z')];
    await applyAdjustments('pierre', evaluateAdjustments(stateOn(day(0), answers), store.sessions.map((s) => ({ ...s }))), 'readiness');
    const first = store.sessions.find((s) => s.id === 'r0')!;
    expect([first.type, first.title, first.program!.level, first.program!.kind]).toEqual(['cross_training', expect.stringMatching(/^Escalier facile/), 0, 'cross']);
    // Remplacée par l'escalier, la course reste celle que l'accord rendra : la question se repose le lendemain.
    const early = [answer('clearance', 'reprise', { choice: 'not_yet' }, '2026-11-09T19:00:00Z')];
    const asked = (today: string, said = early) => pendingQuestions({ today, sessions: store.sessions, activities: [], answers: said }).map((q) => q.question);
    // Le 10/11, la prochaine course encore à courir est le 15 : sans la course remplacée, la question se tairait.
    expect([asked('2026-11-10'), asked('2026-11-09')]).toEqual([['clearance'], []]);
    // Le oui arrivé, la course revient à sa marche.
    const yes = [answer('clearance', 'reprise', { choice: 'yes' }, '2026-11-13T08:00:00Z'), ...answers];
    await applyAdjustments('pierre', evaluateAdjustments(stateOn(day(0), yes), store.sessions.map((s) => ({ ...s }))), 'readiness');
    expect([store.sessions.find((s) => s.id === 'r0')!.program!.level, store.sessions.find((s) => s.id === 'r0')!.title]).toEqual([1, expect.stringMatching(/Course-marche/)]);
  });

  it('décide le dossard six jours avant : la SaintéSprint sur une sortie longue sans douleur, la Saintétic sinon', async () => {
    const gateDay = day(9); // 22/11
    // Rien n'a été couru : au critère, le dossard passe à la Saintétic.
    await applyAdjustments('pierre', evaluateAdjustments(stateOn(gateDay), store.sessions.map((s) => ({ ...s }))), 'readiness');
    const race = store.sessions.find((s) => s.type === 'race')!;
    expect(race.title).toMatch(/Saintétic/);
    expect(race.rationale).toMatch(/sortie longue de 1 h 15 n'a pas été faite/);
    // La sortie longue faite sans douleur : le critère est rempli.
    const long = { sessionId: 'r8', date: day(8), level: 5, kind: 'long' as const, done: true, painDuring: 0, painMorning: 1 };
    expect(raceGate([long], [], CEILING).met).toBe(true);
    expect(raceGate([{ ...long, painMorning: 3 }], [], CEILING).met).toBe(false);
  });
});

describe('Ce que Cairn demande', () => {
  it('l’accord du médecin à trois jours de la première course, puis la douleur et le réveil après chaque course', () => {
    expect(pendingQuestions({ today: '2026-11-09', sessions: store.sessions, activities: [], answers: [] })).toEqual([]);
    expect(pendingQuestions({ today: '2026-11-10', sessions: store.sessions, activities: [], answers: [] }).map((q) => q.question)).toEqual(['clearance']);
    const activities = [doneFirst()];
    const cleared = [answer('clearance', 'reprise', { choice: 'yes' })];
    // Le soir de la course : la douleur ; une course sans montre : l'effort.
    expect(pendingQuestions({ today: day(0), sessions: store.sessions, activities, answers: cleared }).map((q) => q.question)).toEqual(['run_pain', 'run_rpe']);
    // Le lendemain matin, en plus : le réveil.
    const asked = pendingQuestions({ today: day(1), sessions: store.sessions, activities, answers: [...cleared, answer('run_pain', 'r0', { score: 0 })] });
    // Le 14/11 est un samedi : la semaine qui vient porte le tempo du 19, Cairn demande ses jours chargés, en dernier.
    expect(asked.map((q) => q.question)).toEqual(['morning_pain', 'run_rpe', 'week_load']);
    expect(asked[0]!.why).toMatch(/lendemain/);
  });

  it('n’accepte que les réponses que la question attend', () => {
    expect(validAnswer('clearance', { choice: 'yes' })).toBeNull();
    expect(validAnswer('clearance', { choice: 'peut-être' })).not.toBeNull();
    expect(validAnswer('run_pain', { score: 11 })).not.toBeNull();
    expect(validAnswer('run_pain', { score: 3, site: 'achille' })).toBeNull();
    expect(validAnswer('run_rpe', { score: 0 })).not.toBeNull();
  });
});
