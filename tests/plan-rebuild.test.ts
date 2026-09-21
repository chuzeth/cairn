import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PIERRE,
  type DeclaredAbsence, type PlannedSession, type RaceGoal, type TrainingPlan, type TrainingWeek,
} from '@cairn/core';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Une reconstruction ne détruit pas ce qui a été décidé.
 *
 * Le défaut se produisait en un clic depuis la page Objectifs : le plan neuf
 * s'écrivait par-dessus tout, et emportait le test maximal placé par le coach,
 * la rando-course ramenée sous le seuil mécanique, la progression allongée. Le
 * journal du plan gardait la trace de ces décisions ; les séances, non.
 *
 * Les tests passent par `executeTool`, et non par le planificateur : c'est le
 * chemin qu'emprunte le bouton, et c'est là que la perte avait lieu.
 */

const TODAY = '2026-09-18';

const RACE: RaceGoal = {
  id: 'grisemottes',
  athleteId: 'pierre',
  name: 'Trail des Grisemottes',
  date: '2026-10-18',
  priority: 'A',
  course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 3, expectedTempC: 12 },
};

const ABSENCE: DeclaredAbsence = {
  id: 'abs_1',
  athleteId: 'pierre',
  startDate: '2026-09-30',
  endDate: '2026-09-30',
  kind: 'unavailable',
  reason: 'Déplacement professionnel.',
  source: 'athlete',
  declaredAt: '2026-09-17T09:00:00.000Z',
};

const store = vi.hoisted(() => ({
  plan: null as { plan: TrainingPlan; weeks: TrainingWeek[] } | null,
  saved: null as { plan: TrainingPlan; weeks: TrainingWeek[] } | null,
  saves: 0,
}));

const sessionsOf = () => (store.plan?.weeks ?? []).flatMap((w) => w.sessions);

vi.mock('@cairn/db', () => ({
  getAthlete: async () => PIERRE,
  getLatestModel: async () => PIERRE_MODEL,
  getRaceGoal: async (id: string) => (id === RACE.id ? RACE : null),
  listRaceGoals: async () => [RACE],
  getActivePlan: async () => store.plan,
  listPlannedSessions: async (_a: string, from: string, to: string) =>
    sessionsOf().filter((s) => s.date >= from && s.date <= to),
  listAbsences: async () => [ABSENCE],
  listActivities: async () => [],
  listCheckIns: async () => [],
  getDailyLoads: async () => [],
  getAnalyses: async () => new Map(),
  updateSession: async () => undefined,
  appendPlanRevision: async () => undefined,
  savePlan: async (plan: TrainingPlan, weeks: TrainingWeek[]) => {
    store.saved = { plan, weeks };
    store.saves++;
  },
}));

const { executeTool } = await import('@cairn/coach');

/** Une séance du plan en place, réduite à ce que la reconstruction peut perdre. */
function session(over: Partial<PlannedSession> & { id: string; date: string; title: string }): PlannedSession {
  return {
    athleteId: 'pierre',
    type: 'endurance',
    intent: '',
    blocks: [{ label: 'Course', zone: 'Z2', durationS: 3600 }],
    plannedLoad: 50,
    plannedMechanicalLoad: 20,
    plannedDurationS: 3600,
    plannedElevationGainM: 100,
    priority: 'support',
    status: 'planned',
    ...over,
  };
}

/**
 * Le plan tel qu'il était le 18/09 : quatre jours vécus, une séance remplacée
 * le jour même, un retrait posé par une absence déclarée, et trois séances à
 * venir que le coach avait ajustées à la main.
 */
const PREVIOUS: TrainingWeek[] = [
  {
    weekStart: '2026-09-14', index: 0, phase: 'base', targetLoad: 250, plannedDurationS: 5 * 3600,
    targetElevationGainM: 600, intensityDistribution: { low: 0.8, moderate: 0.1, high: 0.1 },
    isDeload: false, focus: 'Reprise', sessions: [
      session({ id: 'p1', date: '2026-09-15', title: 'Côtes — 8 × 90 s à 10 %', status: 'completed', plannedLoad: 37 }),
      session({
        id: 'p2', date: '2026-09-18', title: 'Endurance fondamentale 41 min · 75 m D+',
        status: 'replaced', completedActivityId: 'act_9', plannedLoad: 35,
      }),
    ],
  },
  {
    weekStart: '2026-09-21', index: 1, phase: 'build', targetLoad: 320, plannedDurationS: 6 * 3600,
    targetElevationGainM: 900, intensityDistribution: { low: 0.75, moderate: 0.1, high: 0.15 },
    isDeload: false, focus: 'Construction', sessions: [
      session({
        id: 'p3', date: '2026-09-22', title: 'Test maximal — 10 min contre la montre', type: 'threshold',
        priority: 'key', plannedLoad: 71,
        decision: {
          at: '2026-09-17T18:12:00.000Z', by: 'coach',
          summary: 'Test maximal placé pour recalibrer la vitesse critique avant la phase spécifique.',
        },
      }),
      session({
        id: 'p4', date: '2026-09-27', title: 'Rando-course 3 h · 760 m D+', type: 'long_trail',
        priority: 'key', plannedLoad: 118, plannedElevationGainM: 760, plannedMechanicalLoad: 62,
        decision: {
          at: '2026-09-17T18:20:00.000Z', by: 'coach',
          summary: 'Dénivelé ramené de 1 014 à 760 m pour tenir sous le seuil de ratio mécanique.',
        },
      }),
      // Sans décision : celle-là, la reconstruction a le droit de la réécrire.
      session({ id: 'p7', date: '2026-09-23', title: 'Décrassage 40 min', type: 'recovery', plannedLoad: 7 }),
    ],
  },
  {
    weekStart: '2026-09-28', index: 2, phase: 'build', targetLoad: 340, plannedDurationS: 6.5 * 3600,
    targetElevationGainM: 950, intensityDistribution: { low: 0.75, moderate: 0.1, high: 0.15 },
    isDeload: false, focus: 'Construction', sessions: [
      session({
        id: 'p5', date: '2026-09-30', title: 'Décrassage 40 min', type: 'recovery',
        status: 'withdrawn', absenceId: ABSENCE.id, plannedLoad: 7,
      }),
      session({
        id: 'p6', date: '2026-10-03', title: 'Rando-course 3 h 30 · 1 014 m D+', type: 'long_trail',
        priority: 'key', plannedLoad: 163, plannedDurationS: 12600, plannedElevationGainM: 1014,
        decision: {
          at: '2026-09-17T18:26:00.000Z', by: 'coach',
          summary: 'Allongée à 3 h 30 : dernière progression avant l\'affûtage.',
        },
      }),
      session({ id: 'p8', date: '2026-10-01', title: 'PMA — 2 × 8 × 1\'-1\'', type: 'vo2max', plannedLoad: 90 }),
    ],
  },
];

/** Ce que la reconstruction ne doit pas perdre, et à quoi on le reconnaît. */
const DECIDED = [
  { id: 'p1', date: '2026-09-15', title: 'Côtes — 8 × 90 s à 10 %' },
  { id: 'p2', date: '2026-09-18', title: 'Endurance fondamentale 41 min · 75 m D+' },
  { id: 'p3', date: '2026-09-22', title: 'Test maximal — 10 min contre la montre' },
  { id: 'p4', date: '2026-09-27', title: 'Rando-course 3 h · 760 m D+' },
  { id: 'p5', date: '2026-09-30', title: 'Décrassage 40 min' },
  { id: 'p6', date: '2026-10-03', title: 'Rando-course 3 h 30 · 1 014 m D+' },
];

const plan = (weeks: TrainingWeek[]): { plan: TrainingPlan; weeks: TrainingWeek[] } => ({
  plan: {
    id: 'plan_ancien', athleteId: 'pierre', createdAt: '2026-09-14T06:00:00.000Z',
    updatedAt: '2026-09-17T18:26:00.000Z', goalRaceId: RACE.id, weeks, targetRaceDayTsb: 8,
    revisionLog: [{ at: '2026-09-14T06:00:00.000Z', trigger: 'initial', summary: 'Plan initial.', changes: [] }],
  },
  weeks,
});

const rebuild = (extra: Record<string, unknown> = {}, origin?: 'athlete' | 'coach' | 'rules' | 'developer') =>
  executeTool('pierre', 'rebuild_plan', { race_id: RACE.id, reason: 'Changement de cible.', ...extra }, origin);

const saved = () => (store.saved?.weeks ?? []).flatMap((w) => w.sessions);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T07:00:00.000Z`));
  store.plan = plan(PREVIOUS.map((w) => ({ ...w, sessions: w.sessions.map((s) => ({ ...s })) })));
  store.saved = null;
  store.saves = 0;
});

afterAll(() => vi.useRealTimers());

describe('Une reconstruction ne détruit pas ce qui a été décidé', () => {
  it('reprend les séances passées, réalisées, retirées et modifiées à la main', async () => {
    await rebuild();

    const written = saved();
    for (const expected of DECIDED) {
      const kept = written.find((s) => s.id === expected.id);
      expect(kept, `séance ${expected.id} du ${expected.date} perdue par la reconstruction`).toBeDefined();
      expect(kept!.date).toBe(expected.date);
      expect(kept!.title).toBe(expected.title);
    }
  });

  it('reprend la séance décidée à l\'identique, contenu et charge compris', async () => {
    await rebuild();

    const rando = saved().find((s) => s.id === 'p4')!;
    const before = PREVIOUS[1]!.sessions.find((s) => s.id === 'p4')!;
    expect(rando.plannedElevationGainM).toBe(760);
    expect(rando.plannedLoad).toBe(before.plannedLoad);
    expect(rando.plannedMechanicalLoad).toBe(before.plannedMechanicalLoad);
    expect(rando.decision?.summary).toContain('seuil de ratio mécanique');
  });

  it('garde le statut et le lien qui fondent la décision', async () => {
    await rebuild();

    const written = saved();
    expect(written.find((s) => s.id === 'p2')?.status).toBe('replaced');
    expect(written.find((s) => s.id === 'p2')?.completedActivityId).toBe('act_9');
    expect(written.find((s) => s.id === 'p5')?.status).toBe('withdrawn');
    expect(written.find((s) => s.id === 'p5')?.absenceId).toBe(ABSENCE.id);
  });

  it('ne laisse pas deux séances le même jour', async () => {
    await rebuild();

    const dates = saved().map((s) => s.date);
    expect(dates.length).toBe(new Set(dates).size);
  });

  it('réécrit bien tout le reste — la préservation ne gèle pas le plan', async () => {
    await rebuild();

    const untouched = saved().filter((s) => !DECIDED.some((d) => d.id === s.id));
    expect(untouched.length).toBeGreaterThan(20);
    expect(untouched.some((s) => s.type === 'race')).toBe(true);
  });
});

describe('Ce que la reconstruction va changer se voit avant qu\'elle ne s\'exécute', () => {
  it('l\'aperçu n\'enregistre rien', async () => {
    const { content } = await rebuild({ preview: true });

    expect(store.saves).toBe(0);
    expect((content as { enregistre: boolean }).enregistre).toBe(false);
  });

  it('l\'aperçu annonce exactement ce que la reconstruction conservera', async () => {
    const { content } = await rebuild({ preview: true });
    const announced = (content as { seances_conservees: { date: string }[] }).seances_conservees;

    await rebuild();
    const kept = saved().filter((s) => DECIDED.some((d) => d.id === s.id));

    expect(announced.map((k) => k.date).sort()).toEqual(kept.map((s) => s.date).sort());
    expect(announced).toHaveLength(DECIDED.length);
  });

  it('l\'aperçu dit ce qui sera remplacé, et ce qui y change', async () => {
    const { content, summary } = await rebuild({ preview: true });
    const swapped = (content as {
      seances_remplacees: { date: string; avant: string; apres: string; ce_qui_change: string[] }[];
    }).seances_remplacees;

    expect(swapped.length).toBeGreaterThan(0);
    for (const c of swapped) {
      expect(c.avant).toBeTruthy();
      expect(c.apres).toBeTruthy();
      // Deux séances peuvent porter le même titre sans peser la même chose :
      // une ligne « avant → après » identique ne dirait rien de ce qui bouge.
      expect(c.ce_qui_change.length).toBeGreaterThan(0);
      expect(DECIDED.some((d) => d.date === c.date)).toBe(false);
    }
    expect(summary).toContain('Aperçu');
  });

  it('chaque séance conservée dit ce qu\'elle porte', async () => {
    const { content } = await rebuild({ preview: true });
    const kept = (content as { seances_conservees: { date: string; ce_qu_elle_porte: string }[] })
      .seances_conservees;

    const statement = (date: string) => kept.find((k) => k.date === date)!.ce_qu_elle_porte;
    expect(statement('2026-09-15')).toBe('réalisée');
    expect(statement('2026-09-18')).toContain('autre chose');
    expect(statement('2026-09-30')).toContain('absence déclarée');
    expect(statement('2026-09-27')).toContain('seuil de ratio mécanique');
  });
});

describe('Le journal dit d\'où vient la reconstruction', () => {
  const lastRevision = () => store.saved!.plan.revisionLog[store.saved!.plan.revisionLog.length - 1]!;

  it('distingue l\'athlète d\'un appel direct à l\'API', async () => {
    await rebuild({}, 'athlete');
    expect(lastRevision().origin).toBe('athlete');
    expect(lastRevision().summary).toContain("par l'athlète");

    store.saved = null;
    await rebuild({}, 'developer');
    expect(lastRevision().origin).toBe('developer');
    expect(lastRevision().summary).toContain('appel direct');
  });

  it('vient du coach quand rien ne dit le contraire', async () => {
    await rebuild();
    expect(lastRevision().origin).toBe('coach');
  });

  it('inscrit le mouvement, jour par jour, dans le journal', async () => {
    await rebuild();
    const changes = lastRevision().changes;

    expect(changes.length).toBeGreaterThan(0);
    for (const d of DECIDED) expect(changes.some((c) => c.date === d.date)).toBe(false);
    expect(changes.every((c) => c.reason.length > 0)).toBe(true);
  });

  it('reporte le journal du plan précédent', async () => {
    await rebuild();
    expect(store.saved!.plan.revisionLog[0]?.summary).toBe('Plan initial.');
  });
});

describe('Un premier plan n\'a rien à conserver', () => {
  it('se construit sur une page blanche', async () => {
    store.plan = null;
    const { content } = await rebuild({ preview: true });

    expect((content as { seances_conservees: unknown[] }).seances_conservees).toHaveLength(0);
    expect((content as { seances_remplacees: unknown[] }).seances_remplacees).toHaveLength(0);
    expect((content as { seances_ajoutees: unknown[] }).seances_ajoutees.length).toBeGreaterThan(20);
  });
});
