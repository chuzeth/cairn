import { describe, expect, it } from 'vitest';
import { PIERRE, type Activity, type ActivityStreams, type PlannedSession, type PmcSeries } from '@cairn/core';
import {
  analyzeActivity, computeReadiness, debriefSession, exerciseHrScore, extractMarkers, referenceGapOf,
  type DebriefRun,
} from '@cairn/physiology';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Le compte rendu d'une sortie : ce qu'elle apprend, lu contre l'historique.
 *
 * Le 15/11, après « Trail le midi » (16,5 km, 664 m D+), l'écran d'une sortie
 * alignait dix-neuf « blocs d'effort » qui n'étaient que des côtes, reprochait
 * une « zone grise » au terrain, interprétait une cadence moyenne et répondait
 * « OVER » — sans rien dire de ce que la sortie apprenait, ni de ce qu'elle
 * changeait pour la suite. Les fixtures reprennent ses chiffres : 11 km/h à
 * plat lui coûtaient 130 bpm fin septembre, 150 depuis la reprise du 09/11.
 */

const REF = referenceGapOf(PIERRE.labTests[0]!.vt1.speedMs);

/** Minutes, km/h, bpm, pente, cadence (pas/min). */
interface Seg { min: number; kmh: number; hr: number | null; grade?: number; cad?: number }

function streamsOf(segs: Seg[]): ActivityStreams {
  const s: ActivityStreams = { time: [], distance: [], altitude: [], velocity: [], grade: [], heartrate: [], cadence: [], moving: [] };
  let d = 0;
  let z = 300;
  for (const seg of segs) {
    for (let i = 0; i < seg.min * 60; i++) {
      const v = seg.kmh / 3.6;
      const g = seg.grade ?? 0;
      d += v;
      z += v * g;
      s.time.push(s.time.length);
      s.distance.push(d);
      s.altitude.push(z);
      s.velocity.push(v);
      s.grade.push(g);
      s.heartrate!.push(seg.hr);
      s.cadence!.push(seg.cad ?? 170);
      s.moving!.push(true);
    }
  }
  return s;
}

function runOf(id: string, date: string, segs: Seg[], over: Partial<Activity> = {}): DebriefRun {
  const streams = streamsOf(segs);
  const n = streams.time.length;
  const gain = streams.grade.reduce((acc, g, i) => acc + Math.max(0, g * streams.velocity[i]!), 0);
  const loss = streams.grade.reduce((acc, g, i) => acc + Math.max(0, -g * streams.velocity[i]!), 0);
  const activity: Activity = {
    id, athleteId: 'pierre', name: 'Course', sportType: 'Run', startDate: `${date}T16:00:00Z`,
    startDateLocal: `${date}T17:00:00Z`, distanceM: streams.distance.at(-1)!, movingTimeS: n, elapsedTimeS: n,
    totalElevationGainM: Math.round(gain), totalElevationLossM: Math.round(loss), averageSpeedMs: streams.distance.at(-1)! / n,
    averageHr: 140, ...over,
  };
  return { activity, analysis: analyzeActivity(activity, streams, PIERRE_MODEL, { gpsQuality: 'good' }) };
}

/** Un footing de 45 min à 11 km/h à plat, à la FC donnée. */
const easy = (id: string, date: string, hr: number, over: Partial<Activity> = {}) =>
  runOf(id, date, [{ min: 45, kmh: 11, hr }], over);

const shift = (date: string, n: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const debrief = (run: DebriefRun, history: DebriefRun[], context = {}) =>
  debriefSession({ run, history, model: PIERRE_MODEL, referenceGapMs: REF, context });

describe('Les marqueurs d’une sortie', () => {
  it('gardent des fenêtres stables hors échauffement, à la FC de l’allure', () => {
    const m = extractMarkers(streamsOf([{ min: 40, kmh: 11, hr: 140 }]), PIERRE_MODEL, { groundSpeed: true });
    expect(m.hr.verdict).toBe('good');
    expect(m.steady.length).toBeGreaterThan(20);
    expect(Math.min(...m.steady.map((w) => w.t))).toBeGreaterThanOrEqual(480);
    expect(m.steady.every((w) => Math.abs(w.hr - 140) < 1)).toBe(true);
  });

  it('écartent la FC calée sur la cadence, entrée par un saut que l’allure n’explique pas', () => {
    const m = extractMarkers(
      streamsOf([{ min: 20, kmh: 11, hr: 140, cad: 170 }, { min: 5, kmh: 11, hr: 169, cad: 170 }, { min: 15, kmh: 11, hr: 140, cad: 170 }]),
      PIERRE_MODEL,
      { groundSpeed: true },
    );
    expect(m.hr.cadenceLockS).toBeGreaterThanOrEqual(240);
    expect(m.hr.verdict).toBe('doubtful');
    expect(m.steady.some((w) => w.hr > 150)).toBe(false);
  });

  it('gardent une FC égale à la cadence quand elle y monte avec l’allure : au seuil, elle peut être vraie', () => {
    const m = extractMarkers(
      streamsOf([{ min: 20, kmh: 14, hr: 160, cad: 172 }, { min: 10, kmh: 15, hr: 168, cad: 170 }]),
      PIERRE_MODEL,
      { groundSpeed: true },
    );
    expect(m.hr.cadenceLockS).toBe(0);
  });

  it('notent l’effort dur qui précède une fenêtre : la FC y dit la séance, pas l’état du jour', () => {
    const intervals: Seg[] = Array.from({ length: 6 }, (): Seg[] => [{ min: 3, kmh: 16, hr: 178 }, { min: 2, kmh: 9, hr: 150 }]).flat();
    const run = runOf('a', '2026-09-20', [{ min: 15, kmh: 11, hr: 138 }, ...intervals, { min: 15, kmh: 11, hr: 152 }]);
    const late = run.analysis!.markers!.steady.filter((w) => w.t > 45 * 60);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((w) => w.hardBeforeS >= 180)).toBe(true);
  });

  it('comptent le temps au-dessus du seuil 1 par terrain', () => {
    const m = extractMarkers(
      streamsOf([{ min: 20, kmh: 11, hr: 140 }, { min: 15, kmh: 5, hr: 165, grade: 0.15 }, { min: 10, kmh: 11, hr: 140 }]),
      PIERRE_MODEL,
      { groundSpeed: true },
    );
    expect(m.intensity!.climbAboveVt1S).toBeGreaterThan(800);
    expect(m.intensity!.flatAboveVt1S).toBeLessThan(60);
    expect(m.climbs).toHaveLength(1);
    expect(m.climbs[0]!.hr).toBeCloseTo(165, 0);
  });
});

describe('La FC à allure égale', () => {
  // Fin septembre, 130 bpm à 11 km/h ; coupure du 02/10 au 08/11 ; 150 depuis.
  const september = ['2026-09-15', '2026-09-18', '2026-09-21', '2026-09-24', '2026-09-27', '2026-09-30']
    .map((d, i) => easy(`s${i}`, d, 130 + (i % 2 ? 2 : -1)));
  const reprise = [easy('n1', '2026-11-09', 150), easy('n2', '2026-11-11', 152), easy('n3', '2026-11-13', 151)];

  it('dit l’écart à la meilleure forme, et ce que la coupure a coûté — pas une fatigue', () => {
    const today = easy('today', '2026-11-15', 152);
    const d = debrief(today, [...september, ...reprise]);
    const gap = d.findings.find((f) => f.code === 'aerobic_gap');
    expect(gap?.title).toMatch(/2[0-3] bpm plus haut/);
    expect(gap?.detail).toMatch(/39 jours sans courir/);
    expect(gap?.detail).toMatch(/ne se referme pas encore/);
    expect(d.findings.some((f) => f.code === 'cardiac_strain')).toBe(false);
    expect(d.implications.cardiac?.deltaBpm).toBeCloseTo(1, 0);
    expect(d.aerobicTrend.map((p) => Math.round(p.hr))).toContain(152);
  });

  it('dit que l’écart se referme quand la FC redescend sortie après sortie', () => {
    const closing = [easy('n1', '2026-11-09', 152), easy('n2', '2026-11-12', 148), easy('n3', '2026-11-16', 144)];
    const d = debrief(easy('today', '2026-11-20', 140), [...september, ...closing]);
    expect(d.findings.find((f) => f.code === 'aerobic_gap')?.detail).toMatch(/se referme d'environ \d bpm par semaine/);
  });

  const steady = Array.from({ length: 8 }, (_, i) => easy(`h${i}`, shift('2026-10-01', -2 * (8 - i)), 140 + (i % 2)));

  it('signale une sortie seule au-dessus de sa tendance comme un signal à surveiller', () => {
    const d = debrief(easy('today', '2026-10-01', 152), steady);
    const f = d.findings.find((x) => x.code === 'cardiac_strain')!;
    expect(f.tone).toBe('caution');
    expect(f.detail).toMatch(/Une sortie seule ne fait pas une tendance/);
    expect(d.implications.cardiac).toMatchObject({ streak: 1 });
  });

  it('en fait une fatigue à la deuxième sortie d’affilée', () => {
    const d = debrief(easy('today', '2026-10-03', 152), [...steady, easy('y', '2026-10-01', 150)]);
    const f = d.findings.find((x) => x.code === 'cardiac_strain')!;
    expect(f.tone).toBe('negative');
    expect(d.implications.cardiac!.streak).toBe(2);
  });

  it('ne dit rien d’un écart plus petit que le bruit', () => {
    const d = debrief(easy('today', '2026-10-01', 143), steady);
    expect(d.findings.some((f) => f.code === 'cardiac_strain' || f.code === 'cardiac_ease')).toBe(false);
  });

  it('ne lit pas la FC des fenêtres qui suivent un effort dur', () => {
    const intervals: Seg[] = Array.from({ length: 6 }, (): Seg[] => [{ min: 3, kmh: 16, hr: 178 }, { min: 2, kmh: 9, hr: 150 }]).flat();
    const session = runOf('today', '2026-10-01', [{ min: 15, kmh: 11, hr: 140 }, ...intervals, { min: 20, kmh: 11, hr: 156 }]);
    const d = debrief(session, steady);
    expect(d.aerobicTrend.find((p) => p.activityId === 'today')?.hr).toBeCloseTo(140, 0);
  });
});

describe('Le risque', () => {
  const month = [
    runOf('m1', '2026-11-09', [{ min: 50, kmh: 11.5, hr: 150 }]),
    runOf('m2', '2026-11-13', [{ min: 50, kmh: 12, hr: 150 }, { min: 4, kmh: 8, hr: 145, grade: -0.12 }]),
  ];
  const long = runOf('today', '2026-11-15', [
    { min: 30, kmh: 10, hr: 150 }, { min: 25, kmh: 4.5, hr: 160, grade: 0.15 },
    { min: 20, kmh: 9, hr: 145, grade: -0.18 }, { min: 25, kmh: 10, hr: 150 },
  ]);

  it('dit une sortie plus longue de 30 % que la plus longue du mois, avec le risque publié', () => {
    const d = debrief(long, month, { pain: { score: 0 } });
    const f = d.findings.find((x) => x.code === 'distance_spike')!;
    expect(f.domain).toBe('risk');
    expect(f.detail).toMatch(/1,52/);
    expect(f.detail).toMatch(/Sans douleur déclarée/);
    expect(d.implications.spike).not.toBeNull();
  });

  it('dit une descente plus grosse que tout le mois, et 72 h avant la prochaine descente rapide', () => {
    const d = debrief(long, month);
    expect(d.findings.some((x) => x.code === 'descent_novelty')).toBe(true);
    expect(d.implications.recovery.eccentricHours).toBe(72);
    expect(d.implications.recovery.qualityHours).toBe(48);
  });

  it('met une douleur déclarée avant tout le reste', () => {
    const d = debrief(long, month, { pain: { score: 3, site: 'mollet' } });
    expect(d.findings[0]).toMatchObject({ code: 'pain', title: 'Douleur à 3/10 (mollet)' });
  });
});

describe('L’intensité, par terrain', () => {
  const footing: Pick<PlannedSession, 'title' | 'type' | 'intent' | 'plannedDurationS' | 'blocks'> = {
    title: 'Footing', type: 'endurance', intent: '', plannedDurationS: 3600, blocks: [{ label: 'Footing', zone: 'Z2', durationS: 3600 }],
  };

  it('reproche une séance facile courue vite sur le plat', () => {
    const d = debrief(runOf('today', '2026-11-15', [{ min: 50, kmh: 12, hr: 162 }]), [], { planned: footing });
    expect(d.findings.some((f) => f.code === 'easy_too_fast')).toBe(true);
  });

  it('ne reproche rien quand ce sont les montées qui font passer le seuil', () => {
    const hilly = runOf('today', '2026-11-15', [
      { min: 15, kmh: 10, hr: 140 }, { min: 12, kmh: 5, hr: 165, grade: 0.15 }, { min: 10, kmh: 10, hr: 140 },
      { min: 12, kmh: 5, hr: 165, grade: 0.15 }, { min: 15, kmh: 10, hr: 140 },
    ]);
    const d = debrief(hilly, [], { planned: footing });
    expect(d.findings.some((f) => f.code === 'easy_too_fast')).toBe(false);
    expect(d.findings.find((f) => f.code === 'intensity_from_terrain')?.detail).toMatch(/l'allure facile y a été tenue/);
  });
});

describe('Une donnée douteuse retire le constat qu’elle fonde', () => {
  it('sans FC, ni FC à allure égale, ni dérive, ni intensité', () => {
    const noHr = runOf('today', '2026-10-01', [{ min: 45, kmh: 11, hr: null }]);
    const d = debrief(noHr, Array.from({ length: 6 }, (_, i) => easy(`h${i}`, shift('2026-10-01', -2 * (6 - i)), 140)));
    expect(d.findings.map((f) => f.code)).toEqual(['hr_quality']);
    expect(d.implications.cardiac).toBeNull();
  });
});

describe('La disponibilité lit le cœur à allure égale, à défaut d’une mesure au repos', () => {
  const pmc: PmcSeries = {
    metabolic: [{ date: '2026-11-16', load: 0, ctl: 30, atl: 30, tsb: 0 }],
    mechanical: [{ date: '2026-11-16', load: 0, ctl: 10, atl: 10, tsb: 0 }],
    acwr: [], mechanicalAcwr: [], monotony: [], strain: [], rampRate: [],
  };
  const signal = { date: '2026-11-15', deltaBpm: 10, typicalErrorBpm: 5, streak: 1 };

  it('deux erreurs types au-dessus de la tendance valent 40, deux au-dessous 80', () => {
    expect(exerciseHrScore(signal, 0)).toBe(40);
    expect(exerciseHrScore({ ...signal, deltaBpm: -10 }, 0)).toBe(80);
    expect(exerciseHrScore({ ...signal, streak: 2 }, 0)).toBe(35);
    // Un cœur bas sous une charge très lourde n'est pas une forme : il n'est pas récompensé.
    expect(exerciseHrScore({ ...signal, deltaBpm: -10 }, -25)).toBe(60);
  });

  it('pèse dans le score, avec sa provenance', () => {
    const r = computeReadiness({ date: '2026-11-16', pmc, checkIns: [], exerciseHr: signal });
    expect(r.sources.autonomic).toBe('exercise-hr');
    expect(r.components.autonomic).toBe(40);
    expect(r.weights.autonomic).toBeGreaterThan(0);
  });

  it('ne lit pas une course de plus de deux jours, ni à la place d’une FC de repos', () => {
    expect(computeReadiness({ date: '2026-11-18', pmc, checkIns: [], exerciseHr: signal }).sources.autonomic).toBe('default');
    const rested = computeReadiness({
      date: '2026-11-16', pmc, exerciseHr: signal, restingHrBaseline: 50,
      checkIns: [{ athleteId: 'pierre', date: '2026-11-16', restingHr: 50 }],
    });
    expect(rested.sources.autonomic).toBe('resting-hr');
  });
});
