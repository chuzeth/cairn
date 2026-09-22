import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PIERRE, relativeDatesIn,
  type DeclaredAbsence, type PlannedSession, type RaceGoal, type TrainingPlan, type TrainingWeek,
} from '@cairn/core';
import { DECIDED_ON_2026_09_21, PIERRE_MODEL } from './fixtures/pierre.js';

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
  absences: [] as DeclaredAbsence[],
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
  listAbsences: async () => store.absences,
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

const { executeTool, elevationGainOf, isOneSentence, totalDuration } = await import('@cairn/coach');

/** Tout ce qu'une séance enregistrée donne à lire. */
const textsOf = (s: PlannedSession): string[] => [
  s.title, s.intent, s.rationale ?? '', s.decision?.summary ?? '',
  ...s.blocks.map((b) => b.notes ?? ''),
  ...(s.history ?? []).flatMap((h) => [h.text, ...(h.notes ?? [])]),
];

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

type Origin = 'athlete' | 'coach' | 'rules' | 'developer';
/** L'appel tel que le bouton et le coach le font : sans `apply`, c'est un aperçu. */
const rebuild = (extra: Record<string, unknown> = {}, origin?: Origin) =>
  executeTool('pierre', 'rebuild_plan', { race_id: RACE.id, reason: 'Changement de cible.', ...extra }, origin);
/** La reconstruction enregistrée, qui ne se fait que demandée. */
const write = (extra: Record<string, unknown> = {}, origin?: Origin) => rebuild({ apply: true, ...extra }, origin);

const saved = () => (store.saved?.weeks ?? []).flatMap((w) => w.sessions);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T07:00:00.000Z`));
  store.plan = plan(PREVIOUS.map((w) => ({ ...w, sessions: w.sessions.map((s) => ({ ...s })) })));
  store.saved = null;
  store.saves = 0;
  store.absences = [ABSENCE];
});

afterAll(() => vi.useRealTimers());

describe('Une reconstruction ne détruit pas ce qui a été décidé', () => {
  it('reprend les séances passées, réalisées, retirées et modifiées à la main', async () => {
    await write();

    const written = saved();
    const before = PREVIOUS.flatMap((w) => w.sessions);
    for (const expected of DECIDED) {
      const kept = written.find((s) => s.id === expected.id);
      expect(kept, `séance ${expected.id} du ${expected.date} perdue par la reconstruction`).toBeDefined();
      expect(kept!.date).toBe(expected.date);
      const was = before.find((s) => s.id === expected.id)!;
      // Une décision encore à venir se reprend dans son contenu, et se présente
      // comme toute séance ; le reste est le registre de ce qui a été prescrit.
      if (was.status === 'planned' && was.decision) {
        for (const k of ['type', 'plannedLoad', 'plannedMechanicalLoad', 'plannedDurationS', 'plannedElevationGainM'] as const) {
          expect(kept![k], `${expected.id} ${k}`).toEqual(was[k]);
        }
      } else {
        expect(kept!.title).toBe(expected.title);
      }
    }
  });

  it('reprend la séance décidée à l\'identique, contenu et charge compris', async () => {
    await write();

    const rando = saved().find((s) => s.id === 'p4')!;
    const before = PREVIOUS[1]!.sessions.find((s) => s.id === 'p4')!;
    expect(rando.plannedElevationGainM).toBe(760);
    expect(rando.plannedLoad).toBe(before.plannedLoad);
    expect(rando.plannedMechanicalLoad).toBe(before.plannedMechanicalLoad);
    expect(rando.decision?.summary).toContain('seuil de ratio mécanique');
  });

  it('garde le statut et le lien qui fondent la décision', async () => {
    await write();

    const written = saved();
    expect(written.find((s) => s.id === 'p2')?.status).toBe('replaced');
    expect(written.find((s) => s.id === 'p2')?.completedActivityId).toBe('act_9');
    expect(written.find((s) => s.id === 'p5')?.status).toBe('withdrawn');
    expect(written.find((s) => s.id === 'p5')?.absenceId).toBe(ABSENCE.id);
  });

  it('ne laisse pas deux séances le même jour', async () => {
    await write();

    const dates = saved().map((s) => s.date);
    expect(dates.length).toBe(new Set(dates).size);
  });

  it('réécrit bien tout le reste — la préservation ne gèle pas le plan', async () => {
    await write();

    const untouched = saved().filter((s) => !DECIDED.some((d) => d.id === s.id));
    expect(untouched.length).toBeGreaterThan(20);
    expect(untouched.some((s) => s.type === 'race')).toBe(true);
  });
});

describe('Ce que la reconstruction va changer se voit avant qu\'elle ne s\'exécute', () => {
  it('l\'aperçu n\'enregistre rien', async () => {
    const { content } = await rebuild();

    expect(store.saves).toBe(0);
    expect((content as { enregistre: boolean }).enregistre).toBe(false);
  });

  it('l\'aperçu annonce exactement ce que la reconstruction conservera', async () => {
    const { content } = await rebuild();
    const announced = (content as { seances_conservees: { date: string }[] }).seances_conservees;

    await write();
    const kept = saved().filter((s) => DECIDED.some((d) => d.id === s.id));

    expect(announced.map((k) => k.date).sort()).toEqual(kept.map((s) => s.date).sort());
    expect(announced).toHaveLength(DECIDED.length);
  });

  it('l\'aperçu dit ce qui sera remplacé, et ce qui y change', async () => {
    const { content, summary } = await rebuild();
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
    const { content } = await rebuild();
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
    await write({}, 'athlete');
    expect(lastRevision().origin).toBe('athlete');
    expect(lastRevision().summary).toContain("par l'athlète");

    store.saved = null;
    await write({}, 'developer');
    expect(lastRevision().origin).toBe('developer');
    expect(lastRevision().summary).toContain('appel direct');
  });

  it('vient du coach quand rien ne dit le contraire', async () => {
    await write();
    expect(lastRevision().origin).toBe('coach');
  });

  it('inscrit le mouvement, jour par jour, dans le journal', async () => {
    await write();
    const changes = lastRevision().changes;

    expect(changes.length).toBeGreaterThan(0);
    for (const d of DECIDED) expect(changes.some((c) => c.date === d.date)).toBe(false);
    expect(changes.every((c) => c.reason.length > 0)).toBe(true);
  });

  it('reporte le journal du plan précédent', async () => {
    await write();
    expect(store.saved!.plan.revisionLog[0]?.summary).toBe('Plan initial.');
  });
});

describe('Un premier plan n\'a rien à conserver', () => {
  it('se construit sur une page blanche', async () => {
    store.plan = null;
    const { content } = await rebuild();

    expect((content as { seances_conservees: unknown[] }).seances_conservees).toHaveLength(0);
    expect((content as { seances_remplacees: unknown[] }).seances_remplacees).toHaveLength(0);
    expect((content as { seances_ajoutees: unknown[] }).seances_ajoutees.length).toBeGreaterThan(20);
  });
});

describe('Une reconstruction ne s\'enregistre que demandée', () => {
  it('rend un aperçu quand rien ne dit d\'enregistrer', async () => {
    const { content, summary } = await rebuild();

    expect(store.saves).toBe(0);
    expect((content as { enregistre: boolean }).enregistre).toBe(false);
    expect(summary).toContain("rien n'est enregistré");
  });

  it('refuse une clé que le schéma ne déclare pas, la nomme, et n\'écrit rien', async () => {
    // L'appel qui a réécrit le plan six fois : un aperçu demandé sous un autre nom.
    await expect(rebuild({ mode: 'preview' })).rejects.toThrow(/« mode »/);
    // L'ancien drapeau aussi : accepté, il laisserait croire qu'il protège encore.
    await expect(write({ preview: true })).rejects.toThrow(/« preview »/);
    expect(store.saves).toBe(0);
  });

  it('n\'enregistre que sur `apply: true`', async () => {
    await expect(rebuild({ apply: 'true' })).rejects.toThrow(/booléen/);
    await rebuild({ apply: false });
    expect(store.saves).toBe(0);

    const { content } = await write();
    expect(store.saves).toBe(1);
    expect((content as { enregistre: boolean }).enregistre).toBe(true);
  });

  it('montre dans l\'aperçu le plan qu\'il enregistrerait', async () => {
    const weeksOf = (r: { content: unknown }) => (r.content as { apercu: string[] }).apercu;
    const preview = await rebuild();
    const applied = await write();

    expect(weeksOf(preview).length).toBeGreaterThan(0);
    expect(weeksOf(preview)).toEqual(weeksOf(applied));
  });
});

/**
 * La configuration réelle du 21/09 : le test maximal du mardi, et les deux
 * rando-courses que le coach avait ramenées sous le seuil mécanique. Le
 * planificateur écrivait ses semaines sans les voir — 11,9 h et 10,4 h pour un
 * plafond de 9, une seconde rando-course la veille de chacune, un footing
 * prolongé la veille du test.
 */
describe('Une séance conservée est un point fixe de la semaine', () => {
  const REBUILT_ON = '2026-09-21';
  const QUALITY_OR_LONG = [
    'tempo', 'threshold', 'vo2max', 'hill_repeats', 'downhill', 'fartlek', 'race_pace', 'long_run', 'long_trail',
  ];
  const week = (weekStart: string, sessions: PlannedSession[]): TrainingWeek => ({
    weekStart, index: 0, phase: 'build', targetLoad: 300, plannedDurationS: 0, targetElevationGainM: 900,
    intensityDistribution: { low: 0.75, moderate: 0.1, high: 0.15 }, isDeload: false, focus: '', sessions,
  });

  beforeEach(() => {
    vi.setSystemTime(new Date(`${REBUILT_ON}T07:00:00.000Z`));
    store.absences = [];
    const [test, rando27, rando03] = DECIDED_ON_2026_09_21.map((s) => structuredClone(s));
    store.plan = plan([week('2026-09-21', [test!, rando27!]), week('2026-09-28', [rando03!])]);
  });

  const written = async () => {
    await write();
    return store.saved!.weeks.filter((w) => w.weekStart >= REBUILT_ON);
  };
  const byDate = (weeks: TrainingWeek[]) => new Map(weeks.flatMap((w) => w.sessions).map((s) => [s.date, s]));
  const shift = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  it('tient le plafond sur la semaine entière, conservées comprises', async () => {
    for (const w of await written()) {
      const s = w.sessions.filter((x) => x.type !== 'race').reduce((a, x) => a + x.plannedDurationS, 0);
      expect(s, w.weekStart).toBeLessThanOrEqual(PIERRE.constraints.maxWeeklyHours * 3600);
    }
  });

  it('n\'écrit pas de seconde rando-course à côté de celle qu\'elle conserve', async () => {
    for (const w of await written()) {
      expect(w.sessions.filter((s) => s.type === 'long_trail').length, w.weekStart).toBeLessThanOrEqual(1);
    }
    const days = byDate(store.saved!.weeks);
    expect(days.get('2026-09-27')?.id).toBe('ses_il7lrctf1gz');
    expect(days.get('2026-10-03')?.id).toBe('ses_gm3qpe5f1h4');
  });

  it('laisse la veille du test maximal au repos ou en récupération', async () => {
    const eve = byDate(await written()).get('2026-09-21');
    expect(['rest', 'recovery']).toContain(eve?.type ?? 'rest');
  });

  it('ne pose ni qualité ni sortie longue la veille ou le lendemain d\'une conservée', async () => {
    const days = byDate(await written());
    for (const kept of DECIDED_ON_2026_09_21) {
      for (const date of [shift(kept.date, -1), shift(kept.date, 1)]) {
        const s = days.get(date);
        if (!s || s.decision) continue;
        expect(QUALITY_OR_LONG, `${date} ${s.title}`).not.toContain(s.type);
      }
    }
  });

  it('reprend le contenu des conservées, et les présente comme toute séance', async () => {
    const days = byDate(await written());
    for (const kept of DECIDED_ON_2026_09_21) {
      const s = days.get(kept.date)!;
      expect(s.id).toBe(kept.id);
      // Une décision, c'est son contenu : date, type, durée, dénivelé, charge.
      for (const k of [
        'type', 'priority', 'status', 'plannedDurationS', 'plannedElevationGainM', 'plannedLoad',
        'plannedMechanicalLoad', 'plannedDistanceM',
      ] as const) {
        expect(s[k], `${kept.date} ${k}`).toEqual(kept[k]);
      }
      expect(s.decision).toMatchObject({ at: kept.decision!.at, by: kept.decision!.by });
      // Les blocs présentés portent la séance décidée, ni plus ni moins.
      expect(totalDuration(s.blocks), kept.date).toBe(kept.plannedDurationS);
      expect(elevationGainOf(s.blocks), kept.date).toBe(kept.plannedElevationGainM);
      // Le « pourquoi » tient en une phrase ; le motif de la décision est dans
      // l'historique, daté du jour où il a été écrit.
      expect(isOneSentence(s.rationale ?? ''), `${kept.date} ${s.rationale}`).toBe(true);
      expect(s.history?.[0], kept.date).toMatchObject({ at: kept.decision!.at, by: 'coach', text: kept.decision!.summary });
    }

    // La rando-course se prescrit comme elle se court : une durée, un dénivelé,
    // une règle de marche — plus de partage entre montée et descente.
    const rando = days.get('2026-09-27')!;
    expect(rando.title).toBe('Rando-course — 3 h · 680 m D+');
    expect(rando.blocks.map((b) => [b.zone, b.durationS])).toEqual([['Z2', 160 * 60], ['Z1', 20 * 60]]);
    expect(rando.blocks[0]).toMatchObject({ elevationGainM: 680, elevationLossM: 680 });
    expect(rando.blocks[0]!.label).toMatch(/marche dès \d+ % de pente/);

    // Le test garde ses blocs et ses cibles, et prend les mots d'un test.
    const test = days.get('2026-09-22')!;
    const decided = DECIDED_ON_2026_09_21[0]!;
    const content = (s: PlannedSession) => s.blocks.map((b) => [b.durationS, b.zone, b.hrRange, b.speedRangeMs]);
    expect(content(test)).toEqual(content(decided));
    expect(test.title).toBe('Test maximal 20 min — 1 h');
  });

  it('verse le raisonnement du coach à l\'historique, sans une date relative', async () => {
    const [test] = store.plan!.weeks[0]!.sessions;
    test!.rationale = "Ta séance de ce soir a sorti 13,6 km/h de meilleure moyenne sur 20 min, plus haut qu'hier.";
    test!.blocks[2] = { ...test!.blocks[2]!, notes: 'Chiffre à battre : ta meilleure moyenne sur 20 min de ce soir.' };
    const days = byDate(await written());

    const s = days.get('2026-09-22')!;
    expect(s.rationale).not.toContain('13,6');
    expect(s.history?.[0]?.text).toBe(
      'Ta séance du 18/09 au soir a sorti 13,6 km/h de meilleure moyenne sur 20 min, plus haut que le 17/09.',
    );
    expect(s.history?.[0]?.notes).toContain(
      'Contre-la-montre 20 min : Chiffre à battre : ta meilleure moyenne sur 20 min du 18/09 au soir.',
    );
    for (const x of store.saved!.weeks.flatMap((w) => w.sessions)) {
      for (const t of textsOf(x)) expect(relativeDatesIn(t), `${x.date} « ${t.slice(0, 60)} »`).toEqual([]);
    }
  });

  it('ne verse pas deux fois le même raisonnement quand on reconstruit encore', async () => {
    await written();
    const first = byDate(store.saved!.weeks);
    store.plan = { plan: store.saved!.plan, weeks: structuredClone(store.saved!.weeks) };
    await written();
    const second = byDate(store.saved!.weeks);
    for (const kept of DECIDED_ON_2026_09_21) {
      const a = first.get(kept.date)!;
      const b = second.get(kept.date)!;
      expect(b.history, kept.date).toEqual(a.history);
      expect(b.rationale, kept.date).toBe(a.rationale);
      expect(b.blocks, kept.date).toEqual(a.blocks);
    }
  });
});
