import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIERRE, type PlannedSession, type SessionBlock } from '@cairn/core';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Ce que Pierre a validé le 29/09, tel que le coach doit pouvoir l'écrire :
 * jeudi 01/10, la pyramide devient 45 min de footing facile ; samedi 03/10, la
 * rando-course de 3 h et 900 m D+ reçoit trois blocs de 20 min à l'effort de
 * course. Et rien ne s'écrit sans `apply: true`.
 */

const db = vi.hoisted(() => ({
  sessions: [] as unknown[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  absences: [] as unknown[],
  model: null as unknown,
  athlete: null as unknown,
}));

vi.mock('@cairn/db', () => ({
  listPlannedSessions: async () => db.sessions,
  updateSession: async (id: string, patch: Record<string, unknown>) => {
    db.updates.push({ id, patch });
  },
  getActivePlan: async () => null,
  appendPlanRevision: async () => undefined,
  getLatestModel: async () => db.model,
  getAthlete: async () => db.athlete,
  getDailyLoads: async () => [],
  listAbsences: async () => [],
  listActivities: async () => [],
  createAbsence: async (a: Record<string, unknown>) => {
    const absence = { id: 'abs', declaredAt: '', ...a };
    db.absences.push(absence);
    return absence;
  },
}));

const { executeTool, onTerrain } = await import('@cairn/coach');

db.model = PIERRE_MODEL;
db.athlete = PIERRE;

const pyramide = (): PlannedSession => ({
  id: 'pyramide', athleteId: 'pierre', date: '2026-10-01', type: 'threshold',
  title: 'Pyramide 4-8-12-8-4 min — 1 h 16', intent: 'Tenir le seuil en variant la durée.',
  priority: 'key', status: 'planned',
  blocks: [
    { label: 'Échauffement', zone: 'Z2', durationS: 1200 },
    { label: 'Pyramide', zone: 'Z4', durationS: 2160 },
    { label: 'Retour au calme', zone: 'Z1', durationS: 1200 },
  ],
  plannedLoad: 90, plannedMechanicalLoad: 20, plannedDurationS: 4560, plannedElevationGainM: 0,
});

const rando = (): PlannedSession => ({
  id: 'rando', athleteId: 'pierre', date: '2026-10-03', type: 'long_trail',
  title: 'Rando-course — 3 h · 900 m D+', intent: '', priority: 'key', status: 'planned',
  blocks: [
    { label: 'Sur sentier', zone: 'Z2', durationS: 9600, elevationGainM: 900, elevationLossM: 900, terrain: 'trail' },
    { label: 'Retour au calme', zone: 'Z1', durationS: 1200 },
  ],
  plannedLoad: 160, plannedMechanicalLoad: 70, plannedDurationS: 10800, plannedElevationGainM: 900,
});

/** 3 h, 900 m D+, trois blocs de 20 min à FC 150-160, le reste facile. */
const randoAvecEffort = [
  { label: 'Sur sentier', zone: 'Z2', durationS: 6600, elevationGainM: 900, elevationLossM: 900 },
  { label: 'Effort de course', zone: 'Z3', durationS: 1200, repeat: 3, hrRange: [150, 160] },
  { label: 'Retour au calme', zone: 'Z1', durationS: 600 },
];

const footing45 = [{ label: 'Footing facile', zone: 'Z2', durationS: 2700 }];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T07:00:00Z'));
  db.sessions = [pyramide(), rando()];
  db.updates = [];
  db.absences = [];
  return () => vi.useRealTimers();
});

describe('modify_session montre avant d\'écrire', () => {
  it('rend un aperçu par défaut : la séance avant et après, sa charge, rien d\'écrit', async () => {
    const { summary, content } = await executeTool('pierre', 'modify_session', {
      session_id: 'pyramide', type: 'endurance', blocks: footing45, rationale: 'Pierre préfère récupérer.',
    });
    expect(db.updates).toHaveLength(0);
    expect(summary).toMatch(/^Aperçu, rien n'est enregistré/);
    const c = content as { enregistre: boolean; avant: Record<string, unknown>; apres: Record<string, unknown> };
    expect(c.enregistre).toBe(false);
    expect(c.avant).toMatchObject({ type: 'threshold', charge: 90, duree_s: 4560 });
    expect(c.apres).toMatchObject({ type: 'endurance', duree_s: 2700 });
    expect(c.apres.charge as number).toBeLessThan(90);
    expect(content).toHaveProperty('ratios_de_charge');
  });

  it('n\'écrit qu\'avec `apply: true`, et l\'écriture est celle de l\'aperçu', async () => {
    const args = { session_id: 'pyramide', type: 'endurance', blocks: footing45, rationale: 'Pierre préfère récupérer.' };
    const preview = (await executeTool('pierre', 'modify_session', args)).content as { apres: { titre: string } };
    await executeTool('pierre', 'modify_session', { ...args, apply: true });
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]!.patch.title).toBe(preview.apres.titre);
  });

  it('refuse une clé inconnue en la nommant, sans rien écrire', async () => {
    await expect(
      executeTool('pierre', 'modify_session', { session_id: 'rando', scale_load: 0.8, rationale: 'x', preview: false }),
    ).rejects.toThrow(/« preview »/);
    await expect(
      executeTool('pierre', 'modify_session', { session_id: 'rando', scale_load: 0.8, rationale: 'x', apply: 'yes' }),
    ).rejects.toThrow(/apply attend un booléen/);
    expect(db.updates).toHaveLength(0);
  });
});

describe('Une pyramide devenue footing est un footing', () => {
  it('change le type, et le titre et l\'intention suivent', async () => {
    await executeTool('pierre', 'modify_session', {
      session_id: 'pyramide', type: 'endurance', blocks: footing45, rationale: 'Pierre préfère récupérer.', apply: true,
    });
    const patch = db.updates[0]!.patch as Partial<PlannedSession>;
    expect(patch.type).toBe('endurance');
    expect(patch.title).toBe('Footing — 45 min');
    expect(patch.intent).toMatch(/moteur aérobie/);
    expect(patch.plannedDurationS).toBe(2700);
  });

  it('refuse un changement de type sans contenu', async () => {
    await expect(
      executeTool('pierre', 'modify_session', { session_id: 'pyramide', type: 'endurance', rationale: 'x', apply: true }),
    ).rejects.toThrow(/blocks/);
    expect(db.updates).toHaveLength(0);
  });

  it('refuse un type qu\'un changement ne peut pas atteindre', async () => {
    await expect(
      executeTool('pierre', 'modify_session', {
        session_id: 'pyramide', type: 'race', blocks: footing45, rationale: 'x', apply: true,
      }),
    ).rejects.toThrow(/type attendu parmi/);
  });
});

describe('Une rando-course qui porte de l\'intensité garde ses blocs', () => {
  const efforts = (blocks: readonly SessionBlock[]) => blocks.filter((b) => b.zone === 'Z3');

  it('modify_session enregistre les trois blocs à l\'effort de course', async () => {
    await executeTool('pierre', 'modify_session', {
      session_id: 'rando', blocks: randoAvecEffort, rationale: 'Trois blocs à l\'effort de course.', apply: true,
    });
    const patch = db.updates[0]!.patch as Partial<PlannedSession>;
    expect(patch.plannedDurationS).toBe(10800);
    expect(patch.plannedElevationGainM).toBe(900);
    const z3 = efforts(patch.blocks!);
    expect(z3).toHaveLength(1);
    expect(z3[0]).toMatchObject({ repeat: 3, durationS: 1200, hrRange: [150, 160] });
  });

  it('la pose sur le terrain les garde aussi, décidée ou non', async () => {
    const blocks = randoAvecEffort as SessionBlock[];
    const s: PlannedSession = { ...rando(), blocks };
    const ctx = { model: PIERRE_MODEL, today: '2026-09-29', descentsDone: 1 };
    const [laid] = onTerrain([s], ctx);
    expect(efforts(laid!.blocks)).toHaveLength(1);
    const decided = { ...s, decision: { at: '2026-09-29T07:00:00Z', by: 'coach' as const, summary: 'Validé.' } };
    const [laidDecided] = onTerrain([decided], ctx);
    expect(efforts(laidDecided!.blocks)).toHaveLength(1);
  });

  it('une rando-course facile prend toujours la forme standard', async () => {
    const [laid] = onTerrain([rando()], { model: PIERRE_MODEL, today: '2026-09-29', descentsDone: 1 });
    expect(laid!.blocks.map((b) => b.zone)).toEqual(['Z2', 'Z1']);
    expect(laid!.title).toMatch(/^Rando-course/);
  });
});

describe('declare_absence montre avant d\'écrire', () => {
  const absence = { start_date: '2026-10-01', end_date: '2026-10-03', kind: 'chosen', reason: 'Je coupe.' };

  it('rend un aperçu par défaut', async () => {
    const { content } = await executeTool('pierre', 'declare_absence', absence);
    expect(content).toMatchObject({ enregistre: false });
    expect(db.absences).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('refuse l\'ancienne clé `preview` en la nommant', async () => {
    await expect(executeTool('pierre', 'declare_absence', { ...absence, preview: true })).rejects.toThrow(/« preview »/);
    expect(db.absences).toHaveLength(0);
  });

  it('enregistre avec `apply: true`', async () => {
    await executeTool('pierre', 'declare_absence', { ...absence, apply: true });
    expect(db.absences).toHaveLength(1);
  });
});
