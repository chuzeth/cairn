import { describe, expect, it } from 'vitest';
import {
  LAB_TEST_2025_07_24, PIERRE,
  type Activity, type ActivityStreams, type PhysiologyModel, type PlannedSession, type RaceGoal, type SessionBlock,
} from '@cairn/core';
import {
  analyzeActivity, buildPhysiologyModel, buildZones, checkHrCeiling, easySpeedOf, easyTerrainOf, fractionalUtilization,
  gradeAdjustedSpeed, hrCeilingOf, measureEasySpeeds, outcomeOf, runDurationOf, steadyRunLoad,
  type EasyRun, type HrHistogram, type RealizedEffort,
} from '@cairn/physiology';
import * as lib from '@cairn/coach';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * La charge prévue d'une séance facile.
 *
 * Le 22/09, Pierre a couru son décrassage comme prescrit : 48 min à 9,2 km/h,
 * FC moyenne 133 pour un plafond de 141. Il a coûté 41 points ; il en était
 * prévu 8 — la charge comptait le décrassage au milieu d'une Z1 qui commence à
 * 0 km/h, l'allure de la marche —, et l'app l'a déclaré remplacé.
 */

const hist = (entries: [number, number][]): HrHistogram =>
  Object.fromEntries(entries.map(([bpm, s]) => [String(bpm), s]));

/** La FC du 22/09 : 14 % du temps au-dessus de 141 bpm, jamais au-delà de 151. */
const HR_2209 = hist([[125, 600], [133, 1500], [139, 390], [145, 300], [150, 105]]);
const kmh = (v: number) => v / 3.6;

/** Le modèle du 22/09, et l'allure que ses décrassages mesurent. */
const MODEL_2209: PhysiologyModel = {
  ...PIERRE_MODEL,
  vt1: { hr: 155, speedMs: 3.002 },
  vt2: { hr: 171, speedMs: 3.82 },
  easySpeeds: { Z1: { flat: { hrCeiling: 141, speedMs: kmh(9.8), groundSpeedMs: kmh(9.17), runs: 3 } } },
  provenance: { ...PIERRE_MODEL.provenance, 'easySpeeds.Z1.flat': 'field' },
};

describe('Tenir un plafond de FC', () => {
  it('tient le plafond du décrassage du 22/09', () => {
    const check = checkHrCeiling(HR_2209, 141)!;
    expect(check.shareAbove).toBeCloseTo(0.14, 2);
    expect(check.shareFarAbove).toBe(0);
    expect(check.meanHr).toBeCloseTo(134, 0);
    expect(check.respected).toBe(true);
  });

  it('ne le tient pas au-dessus de lui, ni par un effort au-delà', () => {
    // Un footing couru à 150 : ce n'était plus un décrassage.
    expect(checkHrCeiling(hist([[140, 900], [150, 2000]]), 141)!.respected).toBe(false);
    // Onze pour cent du temps dix battements au-dessus : un effort, pas un retard de la FC.
    expect(checkHrCeiling(hist([[135, 2400], [155, 300]]), 141)!.respected).toBe(false);
    // Sans FC, rien à juger.
    expect(checkHrCeiling({}, 141)).toBeNull();
  });
});

/** Une sortie passée : durée, vitesses, FC, et le D+ par kilomètre qui dit son terrain. */
const run = (ageDays: number, min: number, ngs: number, ground: number, hr: HrHistogram, mPerKm = 0): EasyRun => ({
  ageDays, durationS: min * 60, normalizedGradedSpeedMs: kmh(ngs), groundSpeedMs: kmh(ground), hr,
  distanceM: kmh(ground) * min * 60, elevationGainM: (mPerKm * kmh(ground) * min * 60) / 1000,
});

describe('L’allure facile, lue dans les sorties', () => {
  const runs = [
    run(1, 48, 9.8, 9.16, HR_2209),
    run(39, 40, 11.24, 11.1, hist([[136, 2000], [145, 400]])),
    run(72, 72, 8.89, 8.3, hist([[114, 4320]])),
    // Un footing : trop haut pour la Z1, dans la Z2.
    run(43, 49, 11.76, 10.29, hist([[138, 1300], [148, 1600], [156, 40]])),
    // Un fractionné : aucune des deux.
    run(2, 62, 13.16, 12.85, hist([[150, 1300], [165, 1500], [178, 900]])),
    // Une sortie facile hors de la fenêtre.
    run(100, 60, 12.5, 12.5, hist([[130, 3600]])),
  ];

  it('range chaque sortie dans la zone la plus facile dont elle a tenu le plafond', () => {
    const { speeds, provenance } = measureEasySpeeds(buildZones(PIERRE_MODEL), runs);
    // Trois décrassages, pondérés par leur durée : 9,75 km/h à plat.
    expect(speeds.Z1?.flat).toMatchObject({ hrCeiling: 141, runs: 3 });
    expect(speeds.Z1!.flat!.speedMs * 3.6).toBeCloseTo(9.75, 1);
    expect(speeds.Z1!.flat!.groundSpeedMs).toBeLessThan(speeds.Z1!.flat!.speedMs);
    expect(provenance['easySpeeds.Z1.flat']).toBe('field');
    // Un seul footing ne fait pas une allure : la Z2 reste par défaut, et le dit.
    expect(speeds.Z2).toBeUndefined();
    expect(provenance['easySpeeds.Z2.flat']).toBe('default');
    expect(provenance['easySpeeds.Z1.trail']).toBe('default');
  });

  it('entre dans le modèle avec sa provenance, et retombe sur le plafond de la zone sans sorties', () => {
    const model = buildPhysiologyModel(
      LAB_TEST_2025_07_24,
      {
        gradedSpeedCurve: {}, observedMaxHrs: [], restingHrs: [], bodyMasses: [], hrSpeedPairs: [],
        durability: { pctPerHour: 3, pctPer1000mVert: 4, confidence: 0.15 }, vamCurve: {}, dataDays: 30,
        easyRuns: runs,
      },
      '2026-09-23',
    );
    expect(model.provenance['easySpeeds.Z1.flat']).toBe('field');
    expect(easySpeedOf(model, 'Z1').runs).toBe(3);
    expect(model.provenance['easySpeeds.Z2.flat']).toBe('default');
    // Mesurée sur le plat, elle ne dit rien du sentier.
    expect(easySpeedOf(model, 'Z1', 'trail')).toMatchObject({ provenance: 'default', runs: 0 });
    // La valeur par défaut est la vitesse que les zones associent au plafond,
    // jamais le milieu d'une bande qui commence à 0 km/h.
    const z1 = buildZones(PIERRE_MODEL).find((z) => z.key === 'Z1')!;
    expect(easySpeedOf(PIERRE_MODEL, 'Z1')).toMatchObject({ provenance: 'default', runs: 0 });
    expect(easySpeedOf(PIERRE_MODEL, 'Z1').speedMs).toBeCloseTo(z1.speedMaxMs!, 3);
  });
});

/**
 * Les treize sorties des 90 jours avant le 23/09 qui ont tenu le plafond de Z2
 * sans tenir celui de Z1 : jours, minutes, vitesse graduée et au sol en km/h, D+
 * par kilomètre. Cinq sont de montagne — le 29/08, le 26/08, le 28/07, le 23/07
 * et le 17/07.
 */
const Z2_RUNS = (
  [
    [21, 104, 12.09, 11.15, 17], [25, 121, 10.51, 7.57, 70], [28, 64, 10.03, 6.29, 90],
    [29, 82, 11.51, 8.77, 38], [32, 30, 11.92, 10.68, 17], [34, 45, 12.07, 10.43, 31],
    [43, 49, 11.76, 10.29, 29], [53, 84, 11.6, 10.22, 38], [57, 51, 10.49, 8.67, 41],
    [62, 71, 10.77, 7.73, 74], [68, 75, 11.48, 9.56, 43], [79, 68, 11.44, 9.69, 35], [86, 97, 11.53, 10.53, 18],
  ] as const
).map(([age, min, ngs, ground, mPerKm]) =>
  run(age, min, ngs, ground, hist([[145, min * 54], [150, min * 6]]), mPerKm),
);

describe('Le sentier ne se court pas à l’allure du plat', () => {
  const { speeds, provenance } = measureEasySpeeds(buildZones(MODEL_2209), Z2_RUNS);
  const perHour = (v: number) => steadyRunLoad(3600, v, 3.82);

  it('mesure la Z2 sur chaque terrain : 60 points l’heure en montagne, 73 sur le plat', () => {
    expect(speeds.Z2?.trail).toMatchObject({ hrCeiling: 155, runs: 5 });
    expect(speeds.Z2?.flat).toMatchObject({ hrCeiling: 155, runs: 8 });
    expect(Math.round(perHour(speeds.Z2!.trail!.speedMs))).toBe(60);
    expect(Math.round(perHour(speeds.Z2!.flat!.speedMs))).toBe(73);
    expect(provenance['easySpeeds.Z2.trail']).toBe('field');
    // Au sol, on marche les pentes : moins de 8 km/h.
    expect(speeds.Z2!.trail!.groundSpeedMs * 3.6).toBeLessThan(8);
  });

  it('coupe à la montagne, pas au vallonné : 38 m D+/km, c’est du plat', () => {
    expect(easyTerrainOf({ elevationGainM: 380, distanceM: 10_000 })).toBe('flat');
    expect(easyTerrainOf({ elevationGainM: 410, distanceM: 10_000 })).toBe('trail');
  });

  it('compte une rando-course à l’allure du sentier, son retour au calme à celle du plat', () => {
    const model: PhysiologyModel = {
      ...MODEL_2209,
      easySpeeds: { ...MODEL_2209.easySpeeds, Z2: speeds.Z2 },
      provenance: { ...MODEL_2209.provenance, ...provenance, 'easySpeeds.Z1.flat': 'field' },
    };
    const rando = lib.longTrail(model, 180, 680);
    const [trail, cooldown] = rando.blocks;
    expect(trail!.terrain).toBe('trail');
    expect(cooldown!.terrain).toBeUndefined();
    expect(rando.plannedLoad).toBe(
      Math.round(steadyRunLoad(9600, speeds.Z2!.trail!.speedMs, 3.82) + steadyRunLoad(1200, kmh(9.8), 3.82)),
    );
    // Au plat, elle en aurait valu une trentaine de plus.
    const flat = lib.sessionTotals(model, [{ ...trail!, terrain: undefined }, cooldown!]).load;
    expect(flat - rando.plannedLoad).toBeGreaterThan(30);
    // Un footing, lui, reste au plat.
    expect(lib.endurance(model, 60).plannedLoad).toBe(Math.round(perHour(speeds.Z2!.flat!.speedMs)));
  });
});

describe('La charge prévue de ce qui se court sous un plafond', () => {
  it('compte le décrassage du 22/09 à l’allure que Pierre court sous 141 bpm', () => {
    const planned = lib.recovery(MODEL_2209, 45);
    // 45 min à 9,8 km/h à plat pour un SV2 à 13,75 : 38 points, pas 8.
    expect(planned.plannedLoad).toBe(Math.round(steadyRunLoad(2700, kmh(9.8), 3.82)));
    expect(planned.plannedLoad).toBe(38);
    expect(planned.plannedDistanceM).toBe(Math.round(2700 * kmh(9.17)));
    // Couru 48 min 15 comme le 22/09, il vaut ce que la charge réalisée a mesuré.
    const [run] = planned.blocks;
    expect(lib.sessionTotals(MODEL_2209, [{ ...run!, durationS: 2895 }]).load).toBe(41);
    // Sans sorties mesurées, la vitesse du plafond de la zone — 31 points, pas 8.
    expect(lib.recovery(PIERRE_MODEL, 45).plannedLoad).toBe(31);
  });

  it('compte les retours au calme et les récupérations actives de la même façon', () => {
    const cooldown = lib.tempo(MODEL_2209).blocks.at(-1)!;
    expect(cooldown.zone).toBe('Z1');
    expect(lib.sessionTotals(MODEL_2209, [cooldown]).load).toBe(Math.round(steadyRunLoad(cooldown.durationS!, kmh(9.8), 3.82)));

    const work: SessionBlock = {
      label: 'Répétitions', zone: 'Z4', durationS: 180, repeat: 5, speedRangeMs: [3.9, 4.0],
    };
    const trotted = { ...work, recovery: { durationS: 120, zone: 'Z1' as const, active: true } };
    const passive = { ...work, recovery: { durationS: 120, zone: 'Z1' as const, active: false } };
    const bare = lib.sessionTotals(MODEL_2209, [work]).load;
    // Dix minutes trottinées sous le plafond de la Z1 : 8 points, à l'allure qu'on y court.
    expect(lib.sessionTotals(MODEL_2209, [trotted]).load - bare).toBeCloseTo(steadyRunLoad(600, kmh(9.8), 3.82), -0.5);
    // Passive, elle ne se court pas : la charge réalisée ne compte pas l'athlète à l'arrêt.
    expect(lib.sessionTotals(MODEL_2209, [passive]).load).toBe(bare);
  });

  it('compte une descente à ce que sa pente coûte, pas à 80 % du SV1', () => {
    const descent = lib.downhillSession(MODEL_2209).blocks.find((b) => b.effort)!;
    const alone = { ...descent, recovery: undefined };
    // 90 m sur une pente de 15 % en 3 min : 3,4 m/s au sol, la moitié à plat.
    const ground = 90 / Math.sin(Math.atan(0.15)) / 180;
    expect(lib.sessionTotals(MODEL_2209, [alone]).load).toBe(
      Math.round(6 * steadyRunLoad(180, gradeAdjustedSpeed(ground, -0.15), 3.82)),
    );
    expect(lib.sessionTotals(MODEL_2209, [alone]).load).toBeLessThan(0.6 * 6 * steadyRunLoad(180, 0.8 * 3.002, 3.82));
  });

  it('compte la course à l’intensité que sa prédiction tient, jamais à 85 points l’heure', () => {
    const race: RaceGoal = {
      id: 'race_test', athleteId: 'pierre', name: 'Trail test', date: '2026-10-18', priority: 'A',
      course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 3, expectedTempC: 10 },
      target: { placing: 10 },
    };
    const T = 3.5 * 3600;
    const plan = (over: Partial<Parameters<typeof lib.buildTrainingPlan>[0]> = {}) =>
      lib.buildTrainingPlan({
        athleteId: 'pierre', model: MODEL_2209, constraints: PIERRE.constraints, race, currentCtl: 40,
        estimatedRaceDurationS: T, startDate: '2026-09-21', ...over,
      }).weeks.flatMap((w) => w.sessions).find((s) => s.type === 'race')!;
    expect(plan({ raceLoad: 257.4 }).plannedLoad).toBe(257);
    const atCs = steadyRunLoad(T, MODEL_2209.criticalSpeedMs * fractionalUtilization(T), 3.82);
    expect(plan().plannedLoad).toBe(Math.round(atCs));
    expect(plan().plannedLoad).not.toBe(Math.round(3.5 * 85));
  });
});

describe('Une séance facile est faite quand elle tient ce qu’elle prescrit', () => {
  const decrassage = (over: Partial<PlannedSession> = {}): PlannedSession => {
    const t = lib.recovery(PIERRE_MODEL, 45);
    return {
      id: 'ses_pjqznyszxmo', athleteId: 'pierre', date: '2026-09-22', type: 'recovery', title: t.title,
      intent: t.intent, blocks: t.blocks, plannedLoad: 8, plannedMechanicalLoad: 1, plannedDurationS: 2700,
      priority: 'optional', status: 'planned', ...over,
    };
  };
  const RUN_2209: RealizedEffort = {
    activityId: 'strava-20282930209', sportType: 'Run', date: '2026-09-22', durationS: 2895, load: 40.8,
    hrSeconds: HR_2209,
  };

  it('juge le 22/09 sur sa durée et son plafond, pas sur une charge prévue cinq fois trop basse', () => {
    expect(hrCeilingOf(decrassage())).toBe(141);
    expect(outcomeOf(decrassage(), RUN_2209, PIERRE_MODEL)).toBe('fulfilled');
    // Au-dessus du plafond, ce n'est pas le décrassage, quelle que soit sa charge.
    const footing = { ...RUN_2209, load: 8, hrSeconds: hist([[140, 900], [150, 2000]]) };
    expect(outcomeOf(decrassage(), footing, PIERRE_MODEL)).toBe('replaced');
    // Deux fois trop long non plus.
    expect(outcomeOf(decrassage(), { ...RUN_2209, durationS: 5800 }, PIERRE_MODEL)).toBe('replaced');
  });

  it('mesure la durée sur ce qui se court, pas sur la souplesse qui s’y ajoute', () => {
    const t = lib.recovery(PIERRE_MODEL, 45);
    const withAnnex: PlannedSession = decrassage({
      blocks: [...t.blocks, { label: 'Souplesse', kind: 'mobility', zone: 'Z1', durationS: 1200 }],
      plannedDurationS: 3900,
    });
    expect(runDurationOf(withAnnex)).toBe(2700);
    expect(outcomeOf(withAnnex, { ...RUN_2209, durationS: 2700 }, PIERRE_MODEL)).toBe('fulfilled');
  });

  it('ne prête un plafond qu’aux séances qui ne prescrivent que lui', () => {
    expect(hrCeilingOf({ type: 'endurance', blocks: lib.endurance(PIERRE_MODEL, 60).blocks })).toBe(155);
    expect(hrCeilingOf({ type: 'threshold', blocks: lib.threshold(PIERRE_MODEL).blocks })).toBeNull();
    // Une rando-course prescrit aussi son dénivelé.
    expect(hrCeilingOf({ type: 'long_trail', blocks: lib.longTrail(PIERRE_MODEL, 180, 600).blocks })).toBeNull();
  });

  it('dit « faite » le décrassage du 22/09 dans l’analyse, et ce qu’il a tenu', () => {
    const n = 2895;
    const velocity = new Array<number>(n).fill(2.547);
    const heartrate = Object.entries(HR_2209).flatMap(([bpm, s]) => new Array<number>(s).fill(Number(bpm)));
    const streams: ActivityStreams = {
      time: velocity.map((_, i) => i), distance: velocity.map((v, i) => v * (i + 1)),
      altitude: new Array<number>(n).fill(200), velocity, grade: new Array<number>(n).fill(0), heartrate,
    };
    const activity: Activity = {
      id: 'strava-20282930209', athleteId: 'pierre', name: 'Course à pied dans l’après-midi', sportType: 'Run',
      startDate: '2026-09-22T14:18:00Z', startDateLocal: '2026-09-22T16:18:00Z', distanceM: 7371,
      movingTimeS: n, elapsedTimeS: n, totalElevationGainM: 0, totalElevationLossM: 0, averageSpeedMs: 2.547,
    };
    const { compliance } = analyzeActivity(activity, streams, PIERRE_MODEL, { plannedSessions: [decrassage()] });
    expect(compliance).toMatchObject({ outcome: 'fulfilled', verdict: 'on_target' });
    expect(compliance!.detail).toMatch(/^Séance exécutée comme prescrite : 48'15" courues pour 45'00", FC moyenne 13\d bpm sous le plafond de 141/);
    expect(compliance!.detail).not.toMatch(/charge/);

    // Sans FC, le plafond ne se vérifie pas, et la séance le dit.
    const blind = analyzeActivity(activity, { ...streams, heartrate: undefined }, PIERRE_MODEL, {
      plannedSessions: [decrassage()],
    }).compliance!;
    expect(blind.detail).toMatch(/^Sans fréquence cardiaque, le plafond de 141 bpm ne se vérifie pas/);
  });
});
