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
  athlete: null as unknown,
  dailyLoads: [] as unknown[],
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
  getDailyLoads: async () => db.dailyLoads,
  listAbsences: async () => [],
}));

const { applyAdjustments, buildTrainingPlan, executeTool } = await import('@cairn/coach');

db.model = PIERRE_MODEL;
db.athlete = PIERRE;

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
    // La contradiction entre cible métabolique et courbe se lit dans la séance enregistrée.
    expect(randos.some((s) => /divergent/.test(s.rationale ?? ''))).toBe(true);
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

describe('Ce que le coach lit d\'une séance qu\'il écrit', () => {
  type Ratio = { date: string; filiere: string; ratio: number; seuil: number };

  it('lit les directives sur le contenu actuel, pas sur la phrase écrite à la construction', async () => {
    const origin = directivesFor(PIERRE).find((d) => d.id === 'rando_course_duree')!.origin;
    db.sessions = [{
      ...rando(),
      title: 'Rando-course 3.5 h · 1146 m D+',
      blocks: [
        { label: 'Approche en endurance', zone: 'Z2', durationS: 1500 },
        { label: 'Montées', zone: 'Z2', durationS: 6186, elevationGainM: 1146, vamTargetMh: 667 },
        { label: 'Descentes', zone: 'Z2', durationS: 3714, elevationLossM: 1146 },
        { label: 'Retour au calme', zone: 'Z1', durationS: 1200 },
      ],
      plannedDurationS: 12600, plannedElevationGainM: 1146,
      // Les traces telles que la base les garde depuis la construction du plan,
      // avant que modify_session ne réécrive le contenu.
      directives: [
        { directiveId: 'rando_course_duree', effect: 'Plage prescrite 3 h 00 – 5 h 00 : 3 h 00 retenues.', origin },
        {
          directiveId: 'ambition', origin: PIERRE.ambition!.origin[0],
          effect: "Sortie longue privilégiée par l'ambition trail long : 3 h 00 et 1384 m D+ d'un seul tenant, de quoi mesurer la durabilité au lieu de la supposer.",
        },
      ],
    }];
    const { content } = await executeTool('pierre', 'get_plan', { from: '2026-09-28', weeks: 1 });
    const [seance] = (content as { seances: { directives_appliquees: { effet: string }[] }[] }).seances;
    expect(seance!.directives_appliquees.map((d) => d.effet)).toEqual([
      'Plage prescrite 3 h 00 – 5 h 00 : 3 h 30 retenues.',
      "Sortie longue privilégiée par l'ambition trail long : 3 h 30 et 1146 m D+ d'un seul tenant, de quoi mesurer la perte horaire au lieu de la supposer.",
    ]);
  });

  it('montre, au moment où une séance s\'écrit, le ratio excentrique qu\'elle produit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T07:00:00Z'));
    try {
      // Six semaines à 3 points de charge mécanique par jour, jusqu'à la veille ;
      // la rando-course du 03/10 en pèse 60.
      db.dailyLoads = Array.from({ length: 42 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 7, 9 + i)).toISOString().slice(0, 10), metabolic: 40, mechanical: 3,
      }));
      db.sessions = [rando()];
      db.updates = [];
      const { summary, content } = await executeTool('pierre', 'modify_session', {
        session_id: 'rando', scale_load: 0.6, rationale: 'Semaine chargée : on raccourcit.',
      });
      const ratios = (content as {
        ratios_de_charge: { du: string; au: string; depassements: Ratio[]; depassements_avant_modification: Ratio[] };
      }).ratios_de_charge;
      expect(ratios).toMatchObject({ du: '2026-09-20', au: '2026-10-03' });
      const on0310 = (list: Ratio[]) => list.find((d) => d.date === '2026-10-03' && d.filiere === 'mécanique');
      expect(on0310(ratios.depassements_avant_modification)!.ratio).toBeGreaterThan(1.6);
      // La projection porte la séance telle qu'elle vient d'être écrite.
      expect(on0310(ratios.depassements)!.ratio).toBeLessThan(on0310(ratios.depassements_avant_modification)!.ratio);
      expect(on0310(ratios.depassements)!.seuil).toBe(1.6);
      expect(summary).toContain('au-delà d\'un seuil de ratio de charge');
    } finally {
      vi.useRealTimers();
      db.dailyLoads = [];
    }
  });
});
