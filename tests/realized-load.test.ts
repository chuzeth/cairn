import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity, PlannedSession } from '@cairn/core';

/**
 * Depuis le coude cassé du 03/10, la force et l'escalier se saisissent à la
 * main sur Strava : ni flux ni analyse. Le réalisé valait 0 chaque jour — le
 * 20/10, 1 h 15 d'escalier et 575 m D+ ne pesaient rien —, et les ratios
 * projetés voyaient dix pics du 22 au 29/10 qui n'étaient que ce trou.
 */

const db = vi.hoisted(() => ({
  sessions: [] as PlannedSession[],
  measured: [] as { date: string; metabolic: number; mechanical: number }[],
  analysed: new Set<string>(),
  activities: new Map<string, Activity>(),
}));

vi.mock('@cairn/db', () => ({
  listPlannedSessions: async (_a: string, from: string, to: string) =>
    db.sessions.filter((s) => s.date >= from && s.date <= to),
  getDailyLoads: async () => db.measured,
  listAnalysedActivityIds: async (ids: string[]) => new Set(ids.filter((id) => db.analysed.has(id))),
  getActivity: async (id: string) => db.activities.get(id) ?? null,
  listAbsences: async () => [],
}));

const { loadRatioView, realizedDailyLoads, realizedLoads, projectPlanRatios } = await import('@cairn/coach');

const session = (p: Partial<PlannedSession> & Pick<PlannedSession, 'id' | 'date' | 'status'>): PlannedSession => ({
  athleteId: 'pierre', type: 'strength', title: 'Force A', intent: '', priority: 'support',
  blocks: [{ label: 'Force', zone: 'Z1', durationS: 3600 }],
  plannedLoad: 40, plannedMechanicalLoad: 6, plannedDurationS: 3600,
  ...p,
});

const manual = (id: string, date: string, movingTimeS: number): Activity => ({
  id, athleteId: 'pierre', name: 'Renfo', sportType: 'WeightTraining',
  startDate: `${date}T16:00:00Z`, startDateLocal: `${date}T16:00:00`,
  distanceM: 0, movingTimeS, elapsedTimeS: movingTimeS, totalElevationGainM: 0, averageSpeedMs: 0,
} as Activity);

const on = (loads: { date: string; metabolic: number; mechanical: number }[], date: string) =>
  loads.filter((l) => l.date === date).reduce(
    (a, l) => ({ metabolic: a.metabolic + l.metabolic, mechanical: a.mechanical + l.mechanical }),
    { metabolic: 0, mechanical: 0 },
  );

beforeEach(() => {
  db.sessions = [];
  db.measured = [];
  db.analysed = new Set();
  db.activities = new Map();
});

describe('Une séance faite sans mesure compte dans le réalisé', () => {
  it('« réalisée » et tenue par une saisie manuelle : sa charge prévue', async () => {
    db.sessions = [session({ id: 'force', date: '2026-10-19', status: 'completed', completedActivityId: 'm1' })];
    db.activities.set('m1', manual('m1', '2026-10-19', 3600));
    expect(on(await realizedDailyLoads('pierre', '2026-10-01', '2026-10-21'), '2026-10-19'))
      .toEqual({ metabolic: 40, mechanical: 6 });
  });

  it('« remplacée » sans activité rattachée : sa charge prévue', async () => {
    db.sessions = [session({ id: 'escalier', date: '2026-10-20', status: 'replaced', plannedLoad: 86, plannedMechanicalLoad: 16 })];
    expect(on(await realizedDailyLoads('pierre', '2026-10-01', '2026-10-21'), '2026-10-20'))
      .toEqual({ metabolic: 86, mechanical: 16 });
  });

  it('au prorata de la durée saisie, sans dépasser la charge prévue', async () => {
    db.sessions = [
      session({ id: 'moitie', date: '2026-10-16', status: 'completed', completedActivityId: 'm1' }),
      session({ id: 'plus', date: '2026-10-17', status: 'completed', completedActivityId: 'm2' }),
    ];
    db.activities.set('m1', manual('m1', '2026-10-16', 1800));
    db.activities.set('m2', manual('m2', '2026-10-17', 5400));
    const loads = await realizedDailyLoads('pierre', '2026-10-01', '2026-10-21');
    expect(on(loads, '2026-10-16')).toEqual({ metabolic: 20, mechanical: 3 });
    expect(on(loads, '2026-10-17')).toEqual({ metabolic: 40, mechanical: 6 });
  });

  it('« partielle » sans durée : la moitié de la charge prévue', async () => {
    db.sessions = [session({ id: 'p', date: '2026-10-13', status: 'partial' })];
    expect(on(await realizedDailyLoads('pierre', '2026-10-01', '2026-10-21'), '2026-10-13'))
      .toEqual({ metabolic: 20, mechanical: 3 });
  });

  it('ni une séance manquée, retirée ou encore attendue', async () => {
    db.sessions = [
      session({ id: 'a', date: '2026-10-06', status: 'missed' }),
      session({ id: 'b', date: '2026-10-07', status: 'withdrawn' }),
      session({ id: 'c', date: '2026-10-08', status: 'planned' }),
    ];
    expect(await realizedDailyLoads('pierre', '2026-10-01', '2026-10-21')).toEqual([]);
  });
});

describe('Comptée une seule fois', () => {
  it('une activité analysée fait foi : la charge prévue ne s\'y ajoute pas', async () => {
    db.sessions = [session({ id: 'f', date: '2026-10-01', status: 'completed', type: 'endurance', completedActivityId: 'run' })];
    db.analysed.add('run');
    db.measured = [{ date: '2026-10-01', metabolic: 55.8, mechanical: 4.4 }];
    expect(on(await realizedDailyLoads('pierre', '2026-10-01', '2026-10-21'), '2026-10-01'))
      .toEqual({ metabolic: 55.8, mechanical: 4.4 });
  });

  it('sans activité rattachée, un jour où une mesure existe : c\'est elle qui l\'a réalisée', async () => {
    db.sessions = [session({ id: 'f', date: '2026-09-30', status: 'completed', type: 'endurance' })];
    db.measured = [{ date: '2026-09-30', metabolic: 60.3, mechanical: 11.2 }];
    expect(on(await realizedDailyLoads('pierre', '2026-09-01', '2026-10-21'), '2026-09-30'))
      .toEqual({ metabolic: 60.3, mechanical: 11.2 });
  });

  it('l\'excentrique d\'une séance estimée est déjà dans sa charge mécanique prévue', async () => {
    const circuit = {
      label: 'Circuit', durationS: 1200,
      circuit: { rounds: 3, exercises: [{ movement: 'split_squat', reps: 8 }, { movement: 'step_down', reps: 10 }] },
    } as PlannedSession['blocks'][number];
    // Ses 8 points mécaniques prévus sont ceux du circuit (`mechanicalFor`).
    db.sessions = [session({ id: 'ecc', date: '2026-10-12', status: 'completed', blocks: [circuit], plannedMechanicalLoad: 8 })];
    expect(on(await realizedDailyLoads('pierre', '2026-10-01', '2026-10-21'), '2026-10-12'))
      .toEqual({ metabolic: 40, mechanical: 8 });
  });
});

describe('L\'estimation dit sa provenance', () => {
  it('chaque séance estimée, sa part et d\'où elle vient', async () => {
    db.sessions = [
      session({ id: 'moitie', date: '2026-10-16', status: 'completed', completedActivityId: 'm1' }),
      session({ id: 'escalier', date: '2026-10-20', status: 'replaced' }),
    ];
    db.activities.set('m1', manual('m1', '2026-10-16', 1800));
    const { estimated } = await realizedLoads('pierre', '2026-10-01', '2026-10-21');
    expect(estimated).toMatchObject([
      { sessionId: 'moitie', date: '2026-10-16', share: 0.5, basis: 'duration', provenance: 'default' },
      { sessionId: 'escalier', date: '2026-10-20', share: 1, basis: 'planned', provenance: 'default' },
    ]);
  });

  it('les ratios projetés nomment les séances estimées qui pèsent sur leur charge chronique', async () => {
    db.sessions = [
      session({ id: 'faite', date: '2026-10-20', status: 'replaced' }),
      session({ id: 'demain', date: '2026-10-22', status: 'planned' }),
      session({ id: 'course', date: '2026-11-09', status: 'planned', type: 'race' }),
    ];
    const projection = await projectPlanRatios('pierre', '2026-10-21');
    expect(projection?.provenance).toBe('default');
    expect(projection?.estimated.map((e) => e.sessionId)).toEqual(['faite']);
  });
});

describe('L\'alerte de ratio se dit avec sa filière, son seuil et sa provenance', () => {
  it('ratio, seuil, et les séances estimées qui fondent la référence', () => {
    const view = loadRatioView({
      before: [{ date: '2026-10-24', channel: 'metabolic', value: 1.53, limit: 1.5 }],
      provenance: 'default',
      estimated: [{ date: '2026-10-09', basis: 'duration' }, { date: '2026-10-20', basis: 'planned' }],
    });
    expect(view.alerts[0]!.text).toBe(
      'Charge métabolique à 1,53 fois tes quatre dernières semaines, pour un seuil de 1,5 : au-delà, le risque de blessure augmente nettement.',
    );
    expect(view.source).toBe(
      'Tes quatre dernières semaines comptent 2 séances faites sans mesure (du 09/10 au 20/10), sur leur charge prévue, au prorata de la durée saisie : une valeur par défaut, pas une mesure.',
    );
  });

  it('une référence toute mesurée ne dit pas de provenance', () => {
    const view = loadRatioView({
      before: [{ date: '2026-10-24', channel: 'mechanical', value: 1.72, limit: 1.6 }],
      provenance: 'field',
      estimated: [],
    });
    expect(view.alerts[0]!.text).toMatch(/^Charge mécanique à 1,72 fois .* seuil de 1,6 : au-delà, les tissus lâchent/);
    expect(view.source).toBeNull();
  });
});
