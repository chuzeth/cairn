import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIERRE, type PlannedSession, type TrainingPlan } from '@cairn/core';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Le point du jour ajuste la séance de qualité, chaque jour où c'est justifié.
 *
 * Le défaut : seule la disponibilité rouge, sous 45, touchait le plan — la
 * séance suivante ramenée à 45 %, footing compris. À l'orange, rien ne bougeait.
 * Les protocoles guidés par l'état du jour ajustent l'intensité des séances
 * dures, et laissent les footings : vert, rien ; orange, la séance garde sa
 * forme au bas de ses cibles et sa dernière répétition devient facultative ;
 * rouge, elle se court facile à durée égale, et la qualité se décale.
 *
 * La semaine est celle du plan réel au 02/10 : l'allure spécifique de vendredi,
 * le décrassage décidé avec le coach, la rando-course du dimanche et son bloc à
 * l'effort de course, le repos, la PMA du mardi.
 */

const store = vi.hoisted(() => ({
  sessions: [] as (PlannedSession & { weekStart?: string; phase?: string })[],
  revisions: [] as TrainingPlan['revisionLog'],
}));

vi.mock('@cairn/db', () => ({
  getLatestModel: async () => PIERRE_MODEL,
  getActivePlan: async () => ({
    plan: { id: 'plan' },
    weeks: [{ weekStart: '2026-09-28', phase: 'specific', sessions: store.sessions.map((s) => ({ ...s })) }],
  }),
  appendPlanRevision: async (_id: string, revision: TrainingPlan['revisionLog'][number]) => {
    store.revisions.push(revision);
  },
  insertSession: async (_plan: string, s: PlannedSession, week: { weekStart: string; phase: string }) => {
    store.sessions.push({ ...s, ...week });
  },
  listPlannedSessions: async (_a: string, from: string, to: string) =>
    store.sessions.filter((s) => s.date >= from && s.date <= to).map((s) => ({ ...s })),
  updateSession: async (id: string, patch: Partial<PlannedSession>) => {
    const s = store.sessions.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  },
}));

const lib = await import('@cairn/coach');
const { applyAdjustments, checkInEffect, evaluateAdjustments, isQualitySession } = lib;

const Z2 = { zone: 'Z2' as const, hrRange: [141, 155] as [number, number], speedRangeMs: [2.43622, 2.971] as [number, number], paceRange: ['5:37', '6:50'] as [string, string] };
const Z1 = { zone: 'Z1' as const, hrRange: [0, 141] as [number, number], speedRangeMs: [0, 2.43622] as [number, number], paceRange: ['6:50', '—'] as [string, string] };

const session = (over: Partial<PlannedSession> & Pick<PlannedSession, 'id' | 'date' | 'type'>): PlannedSession => ({
  athleteId: 'pierre', title: 'Footing — 20 min', intent: '', blocks: [], plannedLoad: 17, plannedMechanicalLoad: 3,
  plannedDurationS: 1200, priority: 'support', status: 'planned', ...over,
});

const footing = (id: string, date: string) =>
  session({ id, date, type: 'endurance', blocks: [{ label: 'Footing en endurance aérobie', ...Z2, durationS: 1200 }] });

/** L'allure spécifique du 02/10 : 3 × 6 min à l'effort de course, telle qu'enregistrée. */
const ALLURE = (): PlannedSession =>
  session({
    id: 'ses_rp', date: '2026-10-02', type: 'race_pace', title: 'Allure spécifique — 54 min', priority: 'optional',
    plannedLoad: 65, plannedMechanicalLoad: 4, plannedDurationS: 3240, plannedDistanceM: 9699,
    blocks: [
      { label: 'Échauffement', ...Z2, durationS: 1200 },
      {
        label: 'Allure course', zone: 'Z3', durationS: 360, hrRange: [152, 162], speedRangeMs: [2.971, 3.781],
        paceRange: ['4:24', '5:37'], repeat: 3,
        recovery: { durationS: 120, zone: 'Z2', active: true, hrRange: [141, 155], speedRangeMs: [2.43622, 2.971], paceRange: ['5:37', '6:50'] },
      },
      { label: 'Retour au calme', ...Z1, durationS: 600 },
    ],
    decision: { at: '2026-10-01T09:10:49.482Z', by: 'coach', summary: 'Allure spécifique réduite à 3 × 6 min.' },
  });

/** La rando-course du 04/10 et son bloc de 30 min à l'effort de course. */
const RANDO = (): PlannedSession =>
  session({
    id: 'ses_rando', date: '2026-10-04', type: 'long_trail', title: 'Rando-course — 3 h · 900 m D+', priority: 'key',
    plannedLoad: 192, plannedMechanicalLoad: 47, plannedDurationS: 10800, plannedElevationGainM: 900, plannedDistanceM: 26369,
    blocks: [
      { label: 'Sur sentier, facile', ...Z2, durationS: 6000, elevationGainM: 500, terrain: 'trail' },
      {
        label: "Bloc à l'effort de course", zone: 'Z3', durationS: 1800, hrRange: [150, 160], speedRangeMs: [2.971, 3.781],
        paceRange: ['4:24', '5:37'], elevationGainM: 250, terrain: 'trail',
      },
      { label: 'Retour, facile', ...Z2, durationS: 2100, elevationGainM: 150, terrain: 'trail' },
      { label: 'Retour au calme', ...Z1, durationS: 900 },
    ],
    decision: { at: '2026-10-01T09:10:49.147Z', by: 'coach', summary: 'Sortie longue au dimanche.' },
  });

const week = (): PlannedSession[] => [
  ALLURE(),
  session({
    id: 'ses_0310', date: '2026-10-03', type: 'recovery', title: 'Décrassage — 40 min', priority: 'optional',
    blocks: [{ label: 'Footing très souple', ...Z1, durationS: 2400 }], plannedDurationS: 2400,
    decision: { at: '2026-10-01T09:10:49.471Z', by: 'coach', summary: 'Décrassage la veille.' },
  }),
  RANDO(),
  session({ id: 'ses_0510', date: '2026-10-05', type: 'rest', title: 'Repos complet', plannedLoad: 0, plannedDurationS: 0 }),
  session({
    id: 'ses_0610', date: '2026-10-06', type: 'vo2max', title: 'PMA 1 × 8 × 30"-30" — 45 min', priority: 'key',
    plannedLoad: 43, plannedDurationS: 2700,
    blocks: [{ label: 'Série 30"-30"', zone: 'Z5', durationS: 30, repeat: 8, speedRangeMs: [5.1, 5.4], recovery: { durationS: 30, zone: 'Z1', active: true } }],
  }),
  session({ id: 'ses_0710', date: '2026-10-07', type: 'recovery', title: 'Décrassage 45 min', priority: 'optional', plannedDurationS: 2700 }),
  footing('ses_0810', '2026-10-08'),
  footing('ses_0910', '2026-10-09'),
];

/** Les phases du vrai plan : la semaine du 28/09 est spécifique, l'affûtage commence le 05/10. */
const REAL_PHASES: Record<string, string> = { '2026-09-28': 'specific', '2026-10-05': 'taper', '2026-10-12': 'taper' };
const BUILD_PHASES: Record<string, string> = { '2026-09-28': 'build', '2026-10-05': 'build', '2026-10-12': 'build' };
let phases = BUILD_PHASES;

const planOf = () => ({
  plan: { id: 'plan' },
  weeks: Object.entries(phases).map(([weekStart, phase]) => ({
    weekStart, phase, sessions: store.sessions.filter((s) => lib.mondayOf(s.date) === weekStart).map((s) => ({ ...s })),
  })),
});

const stateOn = (date: string, verdict: 'green' | 'amber' | 'red', score: number) =>
  ({
    today: {
      date, ctl: 37, atl: 38, tsb: -1, mechanicalTsb: 2, acwr: 1.1, mechanicalAcwr: 0.9, rampRate: 1.3,
      monotony: 0.9, tsbLabel: '', acwrLabel: '', acwrRisk: 'low',
    },
    readiness: { date, score, verdict, components: {}, recommendation: '' },
    absences: [], model: PIERRE_MODEL, profile: PIERRE, eccentricCircuitsDone: 6,
    plan: planOf(),
  }) as never;

const BEFORE = { score: 72, verdict: 'green' as const };
const stateOf = (s: PlannedSession) => ({
  type: s.type, status: s.status, date: s.date, durationS: s.plannedDurationS, load: s.plannedLoad,
  title: s.title, blocks: s.blocks,
});

/**
 * Le chemin du point du jour : les règles sur l'état du jour, appliquées, puis
 * la phrase dite à partir de ce que la base porte ensuite — la même lecture que
 * le serveur.
 */
async function checkIn(date: string, verdict: 'green' | 'amber' | 'red', score: number, id = 'ses_rp') {
  const watched = store.sessions.find((s) => s.id === id)!;
  const before = stateOf(watched);
  const adjustments = evaluateAdjustments(stateOn(date, verdict, score), store.sessions.map((s) => ({ ...s })));
  await applyAdjustments('pierre', adjustments, 'readiness');
  const after = store.sessions.find((s) => s.id === watched.id)!;
  const replacement = store.sessions.find(
    (s) => s.id !== watched.id && s.date === before.date && s.type !== 'rest' && s.status !== 'cancelled',
  );
  const effect = checkInEffect({
    before: BEFORE, after: { score, verdict }, today: date,
    session: {
      before, after: stateOf(after), replacement: replacement ? stateOf(replacement) : null,
      heldBy: adjustments.find((a) => a.sessionId === watched.id)?.heldBy ?? null,
    },
  });
  return { adjustments, effect, after };
}

beforeEach(() => {
  phases = BUILD_PHASES;
  store.sessions = week();
  store.revisions = [];
});

describe('La disponibilité ajuste la séance de qualité du jour ou du lendemain', () => {
  it('reconnaît une séance de qualité, et une sortie longue à son bloc d’intensité', () => {
    const [allure, decrassage, rando] = week();
    expect(isQualitySession(allure!, PIERRE_MODEL)).toBe(true);
    expect(isQualitySession(rando!, PIERRE_MODEL)).toBe(true);
    expect(isQualitySession(decrassage!, PIERRE_MODEL)).toBe(false);
    const facile = { ...rando!, blocks: rando!.blocks.filter((b) => b.zone !== 'Z3') };
    expect(isQualitySession(facile, PIERRE_MODEL)).toBe(false);
  });

  it('au vert, rien ne change, et le point du jour le dit', async () => {
    const { adjustments, effect, after } = await checkIn('2026-10-02', 'green', 78);
    expect(adjustments).toEqual([]);
    expect(after).toEqual(ALLURE());
    expect(effect).toBe('Ta disponibilité passe de 72 à 78 ; ta séance du jour ne change pas.');
  });

  it('à l’orange, la séance garde sa forme, au bas de ses cibles, sa dernière répétition facultative', async () => {
    const { adjustments, effect, after } = await checkIn('2026-10-02', 'amber', 55);
    expect(adjustments).toEqual([
      expect.objectContaining({ sessionId: 'ses_rp', action: 'soften', rule: 'readiness_amber' }),
    ]);
    const work = after.blocks.find((b) => b.repeat === 3)!;
    expect(work.hrRange).toEqual([152, 157]);
    expect(work.speedRangeMs![0]).toBe(2.971);
    expect(work.speedRangeMs![1]).toBeCloseTo((2.971 + 3.781) / 2, 3);
    expect(work.paceRange![1]).toBe('5:37');
    expect(work.lastOptional).toBe(true);
    // La forme tient : même type, même jour, mêmes répétitions, même durée.
    expect(after).toMatchObject({ type: 'race_pace', date: '2026-10-02', status: 'planned', plannedDurationS: 3240 });
    expect(work.durationS).toBe(360);
    // Les footings ne bougent pas, la récupération non plus.
    expect(after.blocks[0]).toEqual(ALLURE().blocks[0]);
    expect(work.recovery).toEqual(ALLURE().blocks[1]!.recovery);
    expect(after.lightenings).toEqual([expect.objectContaining({ rule: 'readiness_amber' })]);
    expect(effect).toBe(
      'Ta disponibilité passe de 72 à 55, en vigilance : ta séance du jour garde sa forme, ' +
        'cibles au bas de leur fourchette et dernière répétition facultative.',
    );

    // Un second point du jour à l'orange ne l'allège pas encore.
    expect(evaluateAdjustments(stateOn('2026-10-02', 'amber', 52), store.sessions.map((s) => ({ ...s })))).toEqual([]);
  });

  it('au rouge, la séance se court facile à durée égale, et la qualité passe au premier jour libre', async () => {
    const { adjustments, effect, after } = await checkIn('2026-10-02', 'red', 38);
    // Le 03/10 est un décrassage décidé, le 04/10 la rando-course, le 05/10 un
    // repos, le 06/10 la PMA, le 07/10 son lendemain : le 08/10 est le premier
    // jour sans séance exigeante ni la veille ni le lendemain.
    expect(adjustments).toEqual([
      expect.objectContaining({
        sessionId: 'ses_rp', action: 'defer', rule: 'readiness_red', newDate: '2026-10-08', displaces: 'ses_0810',
      }),
    ]);
    expect(after).toMatchObject({ date: '2026-10-08', status: 'moved', type: 'race_pace', plannedDurationS: 3240 });
    expect(after.lightenings).toEqual([expect.objectContaining({ rule: 'readiness_red' })]);
    expect(store.sessions.find((s) => s.id === 'ses_0810')!.status).toBe('cancelled');
    const easy = store.sessions.filter((s) => s.date === '2026-10-02' && s.status === 'planned');
    expect(easy).toHaveLength(1);
    expect(easy[0]).toMatchObject({ type: 'endurance', plannedDurationS: 3240 });
    expect(easy[0]!.blocks.every((b) => b.zone === 'Z1' || b.zone === 'Z2')).toBe(true);
    expect(effect).toBe(
      'Ta disponibilité passe de 72 à 38, au rouge : ta séance du jour devient un footing facile de 54 min, ' +
        'et « Allure spécifique » passe au 08/10.',
    );

    // Un second point du jour au rouge ne la décale pas encore, et le footing
    // posé à sa place n'est jamais touché.
    expect(evaluateAdjustments(stateOn('2026-10-02', 'red', 30), store.sessions.map((s) => ({ ...s })))).toEqual([]);
  });

  it('au rouge, ne retire pas un footing qui porte la souplesse du dossier', async () => {
    const i = store.sessions.findIndex((s) => s.id === 'ses_0810');
    store.sessions[i] = {
      ...store.sessions[i]!,
      blocks: [...store.sessions[i]!.blocks, { label: 'Souplesse chaîne postérieure', zone: 'Z1', durationS: 600, kind: 'mobility' }],
    };
    const { adjustments } = await checkIn('2026-10-02', 'red', 38);
    expect(adjustments).toEqual([
      expect.objectContaining({ action: 'defer', newDate: '2026-10-09', displaces: 'ses_0910' }),
    ]);
    expect(store.sessions.find((s) => s.id === 'ses_0810')!.status).toBe('planned');
  });

  it('au rouge sans jour libre, la séance se court facile et le dit', async () => {
    store.sessions = store.sessions.filter((s) => s.date <= '2026-10-07');
    store.sessions.push(
      ...['2026-10-08', '2026-10-09'].map((d, i) => session({ id: `dur_${i}`, date: d, type: 'tempo', title: 'Tempo' })),
    );
    const { adjustments, effect, after } = await checkIn('2026-10-02', 'red', 38);
    expect(adjustments).toEqual([expect.objectContaining({ sessionId: 'ses_rp', action: 'ease', rule: 'readiness_red' })]);
    expect(adjustments[0]!.reason).toMatch(/n'est pas reprogrammée/);
    expect(after).toMatchObject({ date: '2026-10-02', type: 'endurance', plannedDurationS: 3240, status: 'planned' });
    expect(effect).toBe(
      'Ta disponibilité passe de 72 à 38, au rouge : ta séance du jour devient un footing facile de 54 min, sans report.',
    );
  });

  it('ne reporte jamais dans l’affûtage : sur le vrai plan, un rouge le 02/10 se court facile sur place', async () => {
    // Le 03/10 et le 04/10 ne sont pas libres ; dès le 05/10, l'affûtage garde
    // ses propres séances d'intensité. Le 09/10 était le jour retenu.
    phases = REAL_PHASES;
    const { adjustments, effect, after } = await checkIn('2026-10-02', 'red', 38);
    expect(adjustments).toEqual([expect.objectContaining({ sessionId: 'ses_rp', action: 'ease', rule: 'readiness_red' })]);
    expect(adjustments[0]!.reason).toMatch(/l'affûtage garde ses propres séances d'intensité/);
    expect(after).toMatchObject({ date: '2026-10-02', type: 'endurance', plannedDurationS: 3240 });
    expect(store.sessions.filter((s) => s.date >= '2026-10-05').every((s) => s.type !== 'race_pace')).toBe(true);
    expect(store.sessions.find((s) => s.id === 'ses_0910')!.status).toBe('planned');
    expect(effect).toBe(
      'Ta disponibilité passe de 72 à 38, au rouge : ta séance du jour devient un footing facile de 54 min, ' +
        "sans report : l'affûtage n'accueille pas d'autre séance d'intensité.",
    );
  });

  it('ne reporte jamais dans la semaine de course, quelle que soit sa phase', async () => {
    store.sessions.push(session({ id: 'course', date: '2026-10-10', type: 'race', title: '🏁 Course', priority: 'key' }));
    const { adjustments } = await checkIn('2026-10-02', 'red', 38);
    expect(adjustments).toEqual([expect.objectContaining({ sessionId: 'ses_rp', action: 'ease' })]);
  });

  it('décale un test maximal dès l’orange : couru fatigué, il mesurerait la fatigue', async () => {
    const t = lib.timeTrial(PIERRE_MODEL, 20);
    store.sessions[0] = session({
      id: 'ses_rp', date: '2026-10-02', type: t.type, title: t.title, priority: 'key', blocks: t.blocks,
      plannedLoad: t.plannedLoad, plannedMechanicalLoad: t.plannedMechanicalLoad, plannedDurationS: t.durationS,
    });
    const { adjustments, effect, after } = await checkIn('2026-10-02', 'amber', 55);
    expect(adjustments).toEqual([
      expect.objectContaining({ sessionId: 'ses_rp', action: 'defer', rule: 'readiness_amber', newDate: '2026-10-08' }),
    ]);
    expect(adjustments[0]!.reason).toMatch(/mesure la fatigue, pas la capacité/);
    expect(after).toMatchObject({ date: '2026-10-08', status: 'moved' });
    expect(effect).toMatch(/^Ta disponibilité passe de 72 à 55, en vigilance : ta séance du jour devient un footing facile de 1 h, et « Test maximal[^»]*» passe au 08\/10\.$/);
    // Le même niveau ne le décale pas deux fois.
    expect(evaluateAdjustments(stateOn('2026-10-02', 'amber', 50), store.sessions.map((s) => ({ ...s })))).toEqual([]);
  });

  it('n’applique un niveau qu’une fois, mais laisse passer le suivant', async () => {
    await checkIn('2026-10-02', 'amber', 55);
    const { adjustments } = await checkIn('2026-10-02', 'red', 40);
    expect(adjustments.map((a) => a.rule)).toEqual(['readiness_red']);
  });

  it('ne touche jamais une séance facile', () => {
    // Une heure de footing pèse plus de 40 points : l'ancienne règle du rouge
    // la ramenait à 45 %.
    const heure = (id: string, date: string) => ({
      ...footing(id, date), plannedLoad: 62, plannedDurationS: 3600,
      blocks: [{ label: 'Footing en endurance aérobie', ...Z2, durationS: 3600 }],
    });
    const easyOnly = [heure('f1', '2026-10-08'), heure('f2', '2026-10-09')];
    for (const [verdict, score] of [['amber', 55], ['red', 30]] as const) {
      expect(evaluateAdjustments(stateOn('2026-10-08', verdict, score), easyOnly)).toEqual([]);
    }
  });

  it('écourte d’un cinquième le bloc d’intensité d’une sortie longue à l’orange, à durée égale', async () => {
    store.sessions = store.sessions.filter((s) => s.date >= '2026-10-03');
    const { adjustments, effect, after } = await checkIn('2026-10-03', 'amber', 55, 'ses_rando');
    expect(adjustments).toEqual([expect.objectContaining({ sessionId: 'ses_rando', action: 'soften', rule: 'readiness_amber' })]);
    const bloc = after.blocks.find((b) => b.zone === 'Z3')!;
    expect(bloc.durationS).toBe(1500);
    expect(bloc.hrRange).toEqual([150, 155]);
    // Les minutes retirées se courent facile, dans le retour qui suit.
    expect(after.blocks.find((b) => b.label === 'Retour, facile')!.durationS).toBe(2400);
    expect(after.plannedDurationS).toBe(10800);
    expect(effect).toBe(
      'Ta disponibilité passe de 72 à 55, en vigilance : ta séance de demain garde sa forme, ' +
        "cibles au bas de leur fourchette et bloc d'intensité ramené de 30 à 25 min.",
    );
  });

  it('court facile le bloc d’intensité d’une sortie longue au rouge, sans la décaler', async () => {
    store.sessions = store.sessions.filter((s) => s.date >= '2026-10-03');
    const { adjustments, effect, after } = await checkIn('2026-10-03', 'red', 38, 'ses_rando');
    expect(adjustments).toEqual([expect.objectContaining({ sessionId: 'ses_rando', action: 'ease', rule: 'readiness_red' })]);
    expect(after).toMatchObject({ date: '2026-10-04', type: 'long_trail', plannedDurationS: 10800 });
    expect(after.blocks.every((b) => b.zone === 'Z1' || b.zone === 'Z2')).toBe(true);
    expect(after.plannedElevationGainM).toBe(900);
    expect(effect).toBe(
      "Ta disponibilité passe de 72 à 38, au rouge : ta séance de demain se court facile, son bloc d'intensité compris, à durée égale.",
    );
  });

  it('dit, avant l’envoi, ce que chaque niveau change', () => {
    expect(lib.CHECK_IN_PURPOSE).toContain('sous 68');
    expect(lib.CHECK_IN_PURPOSE).toContain('sous 45');
    expect(lib.CHECK_IN_PURPOSE).toMatch(/footings? ne bouge/);
    expect(lib.isOneSentence(lib.CHECK_IN_PURPOSE)).toBe(true);
  });
});
