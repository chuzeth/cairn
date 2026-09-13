import { describe, expect, it, vi } from 'vitest';
import {
  PIERRE, directivesFor, type PhysiologyModel, type PlannedSession, type RaceGoal, type SessionBlock,
} from '@cairn/core';
import { interpolateCurve } from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Un test par chemin qui transforme une séance écrite : la calibration du
 * planificateur, l'allègement des règles de charge, le facteur du coach.
 *
 * Tous posent la même question, avec les seules courbes de l'athlète : un
 * segment exige-t-il une vitesse verticale qu'il n'a jamais tenue sur cette
 * durée ? Le contrôle est écrit ici, à la main, et non emprunté au code qu'il
 * juge.
 */

const db = vi.hoisted(() => ({
  sessions: [] as unknown[],
  updates: [] as { id: string; patch: Record<string, unknown> }[],
  model: null as unknown,
}));

vi.mock('@cairn/db', () => ({
  listPlannedSessions: async () => db.sessions,
  updateSession: async (id: string, patch: Record<string, unknown>) => {
    db.updates.push({ id, patch });
  },
  getActivePlan: async () => null,
  appendPlanRevision: async () => undefined,
  getLatestModel: async () => db.model,
  getAthlete: async () => null,
}));

const { applyAdjustments, buildTrainingPlan, executeTool } = await import('@cairn/coach');

db.model = PIERRE_MODEL;

/** Segments d'effort qui ne font que monter ou que descendre, plus vite que la courbe ne l'atteste. */
function impossible(blocks: readonly SessionBlock[], model: PhysiologyModel): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const t = b.durationS ?? 0;
    const up = b.elevationGainM ?? 0;
    const down = b.elevationLossM ?? 0;
    if (t <= 0) continue;
    const check = (meters: number, curve: Record<string, number>, sens: string) => {
      const exige = (meters / t) * 3600;
      const borne = interpolateCurve(curve, t) as number;
      if (exige > borne + 1) out.push(`${b.label} : ${sens} ${Math.round(exige)} m/h > ${Math.round(borne)} m/h`);
    };
    if (up > 0 && down === 0) check(up, model.vamCurve, 'montée');
    if (down > 0 && up === 0) check(down, model.descentVamCurve ?? {}, 'descente');
  }
  return out;
}

/** Une rando-course exécutable : 700 m montés en 1 h, descendus en 30 min. */
const rando = (): PlannedSession => ({
  id: 'rando', athleteId: 'pierre', date: '2026-10-03', type: 'long_trail',
  title: 'Rando-course 3.0 h · 700 m D+', intent: '', priority: 'key', status: 'planned',
  blocks: [
    { label: 'Approche en endurance', zone: 'Z2', durationS: 1500 },
    { label: 'Montées', zone: 'Z2', durationS: 3600, elevationGainM: 700, vamTargetMh: 700 },
    { label: 'Descentes', zone: 'Z2', durationS: 1800, elevationLossM: 700 },
    { label: 'Retour roulant', zone: 'Z2', durationS: 2700 },
    { label: 'Retour au calme', zone: 'Z1', durationS: 1200 },
  ],
  plannedLoad: 136, plannedMechanicalLoad: 60, plannedDurationS: 10800, plannedElevationGainM: 700,
});

describe('Aucune transformation ne rend une séance impossible', () => {
  it('la fixture est exécutable avant toute transformation', () => {
    expect(impossible(rando().blocks, PIERRE_MODEL)).toEqual([]);
  });

  it('calibration du planificateur', () => {
    const race: RaceGoal = {
      id: 'grisemottes', athleteId: 'pierre', name: 'Trail des Grisemottes', date: '2026-10-18', priority: 'A',
      course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 3, expectedTempC: 12 },
    };
    const { weeks } = buildTrainingPlan({
      athleteId: 'pierre', model: PIERRE_MODEL, constraints: PIERRE.constraints, race,
      currentCtl: 33.3, currentAtl: 18.3, estimatedRaceDurationS: 13162, racePaceMs: 32000 / 13162,
      startDate: '2026-09-14', directives: directivesFor(PIERRE), ambition: PIERRE.ambition,
    });
    const randos = weeks.flatMap((w) => w.sessions).filter((s) => s.type === 'long_trail');
    expect(randos.length).toBeGreaterThan(0);
    for (const s of randos) {
      expect(impossible(s.blocks, PIERRE_MODEL), `${s.date} ${s.title}`).toEqual([]);
      // La descente est écrite là où elle a lieu : sans elle, rien ne la contrôle.
      const d = s.blocks.reduce((a, b) => a + (b.elevationLossM ?? 0), 0);
      expect(d, s.date).toBe(s.plannedElevationGainM);
    }
  });

  it('allègement décidé par les règles de charge', async () => {
    db.sessions = [rando()];
    db.updates = [];
    await applyAdjustments('pierre', [{
      sessionId: 'rando', date: '2026-10-03', action: 'scale', factor: 0.6,
      rule: 'mechanical_fatigue', reason: 'TSB mécanique à −30.',
    }]);
    const patch = db.updates.find((u) => u.id === 'rando')!.patch;
    expect(impossible(patch.blocks as SessionBlock[], PIERRE_MODEL)).toEqual([]);
    expect(patch.plannedDurationS).toBe(6480);
  });

  it('facteur demandé par le coach', async () => {
    db.sessions = [rando()];
    db.updates = [];
    await executeTool('pierre', 'modify_session', {
      session_id: 'rando', scale_load: 0.6, rationale: 'Semaine chargée : on raccourcit.',
    });
    const patch = db.updates.find((u) => u.id === 'rando')!.patch;
    expect(impossible(patch.blocks as SessionBlock[], PIERRE_MODEL)).toEqual([]);
    expect(patch.plannedDurationS).toBe(6480);
  });
});
