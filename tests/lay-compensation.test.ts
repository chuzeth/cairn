import { describe, expect, it, vi } from 'vitest';
import type { PlannedSession } from '@cairn/core';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Le bloc de force posé dans le plan (`layCompensation`).
 *
 * Le 13/10, la règle des 48 h a repoussé chaque séance d'un jour : la
 * récupération du dimanche 18/10 est passée au lundi 19/10. Le 14/10, le bloc
 * remis à ses dates a réécrit cette séance-là en force A du lundi — sans la
 * changer de semaine : le 19/10 comptait dans celle du 12/10, qui additionnait
 * deux lundis, et le 26/10 et le 02/11 de même.
 */

const db = vi.hoisted(() => ({
  model: null as unknown,
  sessions: [] as PlannedSession[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  inserts: [] as { session: PlannedSession; opts: Record<string, unknown> }[],
}));

vi.mock('@cairn/db', () => ({
  getActivePlan: async () => ({ plan: { id: 'plan' } }),
  getLatestModel: async () => db.model,
  listPlannedSessions: async () => db.sessions,
  listStrengthTests: async () => [],
  updateSession: async (id: string, patch: Record<string, unknown>) => {
    db.updates.push({ id, patch });
  },
  insertSession: async (_plan: string, session: PlannedSession, opts: Record<string, unknown>) => {
    db.inserts.push({ session, opts });
  },
  appendPlanRevision: async () => undefined,
}));

const { layCompensation } = await import('@cairn/coach');

db.model = PIERRE_MODEL;

describe('Le bloc posé dans le plan', () => {
  it('range une séance réécrite dans la semaine de sa date, pas dans celle d’où elle venait', async () => {
    db.sessions = [{
      id: 'recup', athleteId: 'pierre', date: '2026-10-19', plannedDate: '2026-10-18', type: 'cross_training',
      title: 'Récupération 39 min', intent: '', priority: 'key', status: 'moved', blocks: [],
      plannedLoad: 42, plannedMechanicalLoad: 3, plannedDurationS: 2340,
    } as PlannedSession];
    db.updates = [];
    db.inserts = [];
    await layCompensation('pierre', {
      from: '2026-10-19', days: 2, offset: 10, program: 'block', reason: 'Test.', at: '2026-10-19T08:00:00.000Z',
    });
    expect(db.updates.map((u) => [u.id, u.patch.weekStart, String(u.patch.title).split(' :')[0]])).toEqual([
      ['recup', '2026-10-19', 'Force A'],
    ]);
    // Le mardi, sans séance, en reçoit une neuve : déjà rangée dans sa semaine.
    expect(db.inserts.map((i) => [i.session.date, i.opts.weekStart])).toEqual([['2026-10-20', '2026-10-19']]);
  });
});
