import { describe, expect, it } from 'vitest';
import {
  LAB_TEST_2025_07_24, PIERRE,
  type Activity, type ActivityStreams, type PhysiologyModel, type PlannedSession, type RaceGoal, type SessionBlock,
} from '@cairn/core';
import {
  analyzeActivity, buildPhysiologyModel, buildZones, checkHrCeiling, easySpeedOf, fractionalUtilization,
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
  easySpeeds: { Z1: { hrCeiling: 141, speedMs: kmh(9.8), groundSpeedMs: kmh(9.17), runs: 3 } },
  provenance: { ...PIERRE_MODEL.provenance, 'easySpeeds.Z1': 'field' },
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

describe('L’allure facile, lue dans les sorties', () => {
  const run = (ageDays: number, min: number, ngs: number, ground: number, hr: HrHistogram): EasyRun => ({
    ageDays, durationS: min * 60, normalizedGradedSpeedMs: kmh(ngs), groundSpeedMs: kmh(ground), hr,
  });
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
    expect(speeds.Z1).toMatchObject({ hrCeiling: 141, runs: 3 });
    expect(speeds.Z1!.speedMs * 3.6).toBeCloseTo(9.75, 1);
    expect(speeds.Z1!.groundSpeedMs).toBeLessThan(speeds.Z1!.speedMs);
    expect(provenance.Z1).toBe('field');
    // Un seul footing ne fait pas une allure : la Z2 reste par défaut, et le dit.
    expect(speeds.Z2).toBeUndefined();
    expect(provenance.Z2).toBe('default');
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
    expect(model.provenance['easySpeeds.Z1']).toBe('field');
    expect(easySpeedOf(model, 'Z1').runs).toBe(3);
    expect(model.provenance['easySpeeds.Z2']).toBe('default');
    // La valeur par défaut est la vitesse que les zones associent au plafond,
    // jamais le milieu d'une bande qui commence à 0 km/h.
    const z1 = buildZones(PIERRE_MODEL).find((z) => z.key === 'Z1')!;
    expect(easySpeedOf(PIERRE_MODEL, 'Z1')).toMatchObject({ provenance: 'default', runs: 0 });
    expect(easySpeedOf(PIERRE_MODEL, 'Z1').speedMs).toBeCloseTo(z1.speedMaxMs!, 3);
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
