import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PIERRE, type Activity, type ActivityAnalysis, type ActivityStreams, type PlannedSession } from '@cairn/core';
import { analyzeActivity, msToKmh, normalizeStreams, type RawStreams } from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Une sortie qui ne mesure pas sa vitesse au sol.
 *
 * Le défaut : le 26/09, 54 min sur tapis — `trainer` pour Strava, sans aucune
 * coordonnée — ont été lues « GPS bon », la qualité se jugeant sur la distance,
 * ici celle de l'accéléromètre : 11,9 km pour 8,0 au compteur. Leurs meilleures
 * 20 min, 16,7 km/h pour 146 bpm, sont entrées dans la courbe : vitesse critique
 * 16,7 km/h au lieu de 14,0, et preuve d'effort maximal perdue.
 */

/** Minutes, km/h, bpm. */
type Phase = [number, number, number];

/** Des phases d'allure et de FC constantes, telles qu'une montre les enregistre ; avec leur tracé si `gps`. */
function watch(phases: Phase[], gps: boolean): RawStreams {
  const out: RawStreams = { time: [], distance: [], heartrate: [], ...(gps ? { latlng: [] } : {}) };
  let d = 0;
  for (const [min, kmh, hr] of phases) {
    for (let i = 0; i < min * 60; i++) {
      d += kmh / 3.6;
      out.time!.push(out.time!.length);
      out.distance!.push(d);
      out.heartrate!.push(hr);
      out.latlng?.push([45.76, 4.83 + d / 77_700]);
    }
  }
  return out;
}

/** Le 26/09 tel que la montre l'a compté, par tranches de 5 min. */
const TREADMILL_2609: Phase[] = [
  [5, 15.0, 117], [5, 17.8, 149], [5, 16.5, 160], [5, 17.5, 155], [5, 11.0, 145], [5, 11.4, 150],
  [5, 6.6, 131], [5, 13.6, 151], [5, 12.8, 129], [5, 17.4, 160], [5, 3.4, 114],
];

/** Dehors avant lui : des 3 min à 16,5 km/h, le test de 20 min à 14,0 km/h et 174 bpm, des footings. */
const HISTORY: [string, Phase[]][] = [
  ['2026-09-15', [[45, 10.2, 135]]],
  ['2026-09-18', [[15, 10.5, 140], ...Array.from({ length: 6 }, (): Phase[] => [[3, 16.5, 176], [2, 9, 150]]).flat(), [10, 10, 140]]],
  ['2026-09-21', [[20, 11.5, 150], [20, 14.0, 174], [21, 10.8, 145]]],
  ['2026-09-22', [[45, 10.2, 133]]],
  ['2026-09-25', [[45, 10.2, 135]]],
];

const run = (id: string, day: string, over: Partial<Activity> = {}): Activity => ({
  id, athleteId: 'pierre', name: 'Course à pied', sportType: 'Run',
  startDate: `${day}T15:00:00Z`, startDateLocal: `${day}T17:00:00Z`, distanceM: 10_000, movingTimeS: 3000,
  elapsedTimeS: 3000, totalElevationGainM: 0, totalElevationLossM: 0, averageSpeedMs: 3, ...over,
});

const session = (id: string, over: Partial<PlannedSession>): PlannedSession => ({
  id, athleteId: 'pierre', date: '2026-09-26', type: 'tempo', priority: 'support', status: 'planned',
  title: '', intent: '', plannedLoad: 45, plannedMechanicalLoad: 0, plannedDurationS: 3300, blocks: [], ...over,
});

const store = vi.hoisted(() => ({
  activities: [] as Activity[],
  streams: new Map<string, { streams: ActivityStreams; gpsQuality: string; hrCoverage: number }>(),
  analyses: new Map<string, ActivityAnalysis>(),
  sessions: [] as PlannedSession[],
}));

vi.mock('@cairn/db', () => ({
  getAthlete: async () => PIERRE,
  getActivity: async (id: string) => store.activities.find((a) => a.id === id) ?? null,
  listActivities: async (_a: string, { from }: { from: string }) =>
    store.activities.filter((a) => a.startDateLocal >= from),
  getStreams: async (id: string) => store.streams.get(id) ?? null,
  getAnalyses: async (ids: string[]) =>
    new Map(ids.flatMap((id) => (store.analyses.has(id) ? [[id, store.analyses.get(id)!] as const] : []))),
  listCheckIns: async () => [],
  listPlannedSessions: async (_a: string, from: string, to: string) =>
    store.sessions.filter((s) => s.date >= from && s.date <= to).map((s) => ({ ...s })),
  saveAnalysis: async (_a: string, _d: string, analysis: ActivityAnalysis) => {
    store.analyses.set(analysis.activityId, analysis);
  },
  updateSession: async (id: string, patch: Partial<PlannedSession>) => {
    Object.assign(store.sessions.find((s) => s.id === id) ?? {}, patch);
  },
}));

const { analyzeAndStore, rebuildPhysiologyModel } = await import('@cairn/coach');

/** Ce que fait l'import : le flux normalisé en base, avec son verdict GPS, puis l'analyse. */
async function ingest(activity: Activity, raw: RawStreams): Promise<ActivityAnalysis> {
  const { streams, gpsQuality, hrCoverage } = normalizeStreams(raw);
  store.activities.push(activity);
  store.streams.set(activity.id, { streams, gpsQuality, hrCoverage });
  return (await analyzeAndStore('pierre', activity.id, PIERRE_MODEL))!;
}

const model = () => rebuildPhysiologyModel('pierre', { persist: false, asOf: '2026-09-27' });

/**
 * Le modèle, avant et après `add`. Sa confiance compte les jours de données :
 * une séance de plus la relève, et c'est tout ce qu'elle peut y changer.
 */
async function unchangedBy(add: () => Promise<unknown>) {
  const { confidence: was, ...before } = await model();
  await add();
  const { confidence, ...after } = await model();
  expect(after).toEqual(before);
  expect(confidence).toBeGreaterThanOrEqual(was);
  return before;
}

beforeEach(async () => {
  store.activities = [];
  store.streams = new Map();
  store.analyses = new Map();
  store.sessions = [];
  for (const [day, phases] of HISTORY) await ingest(run(`strava-${day}`, day), watch(phases, true));
});

describe('Une sortie qui ne mesure pas sa vitesse au sol', () => {
  it('se juge sans GPS sur ses coordonnées, quelle que soit sa distance', () => {
    const treadmill = normalizeStreams(watch(TREADMILL_2609, false));
    expect(treadmill.streams.distance.at(-1)! / 1000).toBeCloseTo(11.9, 1);
    expect(treadmill.gpsQuality).toBe('none');
    expect(normalizeStreams(watch(TREADMILL_2609, true)).gpsQuality).toBe('good');
  });

  it.each<[string, Partial<Activity>, Phase[]]>([
    ['le tapis du 26/09, marqué trainer et sans coordonnées', { trainer: true, distanceM: 8000 }, TREADMILL_2609],
    ['un footing sans GPS, 13,5 km/h au poignet pour 133 bpm', {}, [[50, 13.5, 133]]],
  ])('ne change pas le modèle : %s', async (_, over, phases) => {
    await unchangedBy(() => ingest(run('strava-2609', '2026-09-26', over), watch(phases, false)));
  });

  it("n'y entre pas davantage par l'analyse enregistrée le 26/09, courbe comprise", async () => {
    const treadmill = run('strava-2609', '2026-09-26', { trainer: true, distanceM: 8000 });
    const { streams } = normalizeStreams(watch(TREADMILL_2609, false));
    // Telle que le moteur 1.3.0 l'a écrite : « GPS bon », sans qualité GPS enregistrée.
    const { gpsQuality: _, ...stale } = analyzeActivity(
      { ...treadmill, trainer: false }, streams, PIERRE_MODEL, { gpsQuality: 'good' },
    );
    expect(msToKmh(stale.meanMaximalSpeed['1200']!)).toBeCloseTo(16.7, 1);

    const before = await unchangedBy(async () => {
      store.activities.push(treadmill);
      store.analyses.set(treadmill.id, stale);
    });
    expect(msToKmh(before.criticalSpeedMs)).toBeCloseTo(14, 0);
    expect(before.criticalSpeedEvidence?.proof).toMatchObject({ durationS: 1200, ageDays: 6 });
  });

  it('se compte sur sa FC, réalise la séance du jour, et ne prouve aucun test', async () => {
    store.sessions = [
      session('ses_tempo', { blocks: [{ label: 'Tempo', zone: 'Z3', durationS: 3300, speedRangeMs: [3.61, 3.89] }] }),
    ];
    const treadmill = run('strava-2609', '2026-09-26', { trainer: true, distanceM: 8000 });
    const analysis = await ingest(treadmill, watch(TREADMILL_2609, false));
    expect(analysis.load.primarySource).toBe('hrtss');
    expect(analysis.meanMaximalSpeed).toEqual({});
    expect(analysis.meanMaximalSpeedHr).toEqual({});
    expect(analysis.intervals).toEqual([]);
    expect(analysis.wPrimeBalanceMinM).toBeNull();
    expect(store.sessions[0]).toMatchObject({ status: 'completed', completedActivityId: treadmill.id });

    store.sessions = [
      session('ses_test', {
        type: 'threshold', priority: 'key', plannedLoad: 59, blocks: [
          { label: 'Échauffement', zone: 'Z2', durationS: 1500 },
          { label: 'Contre-la-montre 20 min', zone: 'Z5', durationS: 1200, hrRange: [171, 185] },
          { label: 'Retour au calme', zone: 'Z1', durationS: 600 },
        ],
      }),
    ];
    const test = (await analyzeAndStore('pierre', treadmill.id, PIERRE_MODEL))!.compliance!;
    expect(test).toMatchObject({ plannedSessionId: 'ses_test', outcome: 'replaced' });
    expect(test.detail).toMatch(/^Ce n'est pas la séance prescrite : sa vitesse n'est pas mesurée au sol/);
  });
});
