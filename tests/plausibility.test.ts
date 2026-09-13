import { describe, expect, it } from 'vitest';
import { LAB_TEST_2025_07_24, type Activity, type ActivityStreams } from '@cairn/core';
import {
  analyzeActivity, buildPhysiologyModel, modelFromLabOnly, verticalCapacity, type FieldEvidence,
} from '@cairn/physiology';
import * as lib from '@cairn/coach';
import { PIERRE_MODEL, STORED_RANDO_0310 } from './fixtures/pierre.js';

const LAB_MODEL = modelFromLabOnly(LAB_TEST_2025_07_24, '2026-09-01');

describe('Courbe de descente', () => {
  it('se conserve dans l\'analyse, par durée, comme la montée', () => {
    // Quinze minutes à +15 % à 1,2 m/s, puis quinze minutes à −15 % à 2,5 m/s.
    const n = 1800;
    const grade = Array.from({ length: n }, (_, i) => (i < 900 ? 0.15 : -0.15));
    const velocity = grade.map((g) => (g > 0 ? 1.2 : 2.5));
    const distance: number[] = [];
    const altitude: number[] = [];
    velocity.reduce((d, v, i) => ((distance[i] = d + v), d + v), 0);
    grade.reduce((z, g, i) => ((altitude[i] = z + velocity[i]! * g), z + velocity[i]! * g), 400);
    const streams: ActivityStreams = { time: grade.map((_, i) => i), distance, altitude, velocity, grade };
    const activity: Activity = {
      id: 'synthetique', athleteId: 'pierre', name: 'Aller-retour', sportType: 'TrailRun',
      startDate: '2026-09-10T08:00:00Z', startDateLocal: '2026-09-10T10:00:00Z',
      distanceM: distance[n - 1]!, movingTimeS: n, elapsedTimeS: n,
      totalElevationGainM: 160, totalElevationLossM: 334, averageSpeedMs: 1.85,
    };

    const analysis = analyzeActivity(activity, streams, LAB_MODEL);
    const descent = analysis.meanMaximalDescentVam!;
    expect(Object.keys(descent).map(Number)).toEqual([60, 120, 180, 300, 420, 600, 900, 1200, 1800]);
    // 2,5 m/s le long d'une pente à 15 % font 1 335 m/h de vertical, tenus 15 min.
    expect(descent['900']).toBeCloseTo(1335, -1);
    expect(descent['1800']).toBeCloseTo(1335 / 2, -1);
    expect(analysis.meanMaximalVam['900']).toBeCloseTo(641, -1);
  });
});

describe('Capacité verticale', () => {
  const climb = verticalCapacity(PIERRE_MODEL, 'climb');
  const descent = verticalCapacity(PIERRE_MODEL, 'descent');

  it('lit la borne sur la courbe là où elle est mesurée, et le dit ailleurs', () => {
    expect(climb.at(3600)).toEqual({ vamMh: 812, provenance: 'field' });
    // En deçà du premier point : sa valeur, prudente et encore mesurée.
    expect(climb.at(30)).toEqual({ vamMh: 1823, provenance: 'field' });
    // Au-delà du dernier : une extrapolation, qui décroît et se déclare.
    const beyond = climb.at(3 * 3600);
    expect(beyond.provenance).toBe('default');
    expect(beyond.vamMh).toBeLessThan(738);
    // Sans aucun point, la borne est celle du moteur — jamais une mesure.
    expect(verticalCapacity(LAB_MODEL, 'descent').at(600).provenance).toBe('default');
    expect(verticalCapacity(LAB_MODEL, 'climb').at(600).provenance).toBe('default');
  });

  it('rend le temps minimal d\'un dénivelé, cohérent avec la borne', () => {
    const up = climb.timeFor(1384);
    expect(up.durationS / 60).toBeCloseTo(110.9, 0);
    expect(up.provenance).toBe('field');
    expect(climb.metersIn(up.durationS)).toBeCloseTo(1384, 0);
    expect(descent.timeFor(1384).durationS / 60).toBeCloseTo(52.5, 0);
  });

  it('porte la provenance des deux courbes dans le modèle', () => {
    const evidence: FieldEvidence = {
      gradedSpeedCurve: {}, observedMaxHrs: [], restingHrs: [], bodyMasses: [], hrSpeedPairs: [],
      durability: { pctPerHour: 3, pctPer1000mVert: 4, confidence: 0.15 },
      vamCurve: { '600': 1100 }, dataDays: 10,
    };
    const model = buildPhysiologyModel(LAB_TEST_2025_07_24, evidence, '2026-09-12');
    expect(model.provenance.vamCurve).toBe('field');
    expect(model.provenance.descentVamCurve).toBe('default');
    expect(LAB_MODEL.provenance).toMatchObject({ vamCurve: 'default', descentVamCurve: 'default' });
  });
});

describe('Construction', () => {
  const library = (model: typeof LAB_MODEL) => [
    lib.recovery(model), lib.endurance(model, 60, 200), lib.longRun(model, 150, 600),
    lib.longTrail(model, 180, 1384), lib.tempo(model), lib.threshold(model), lib.vo2max(model),
    lib.hillRepeats(model), lib.downhillSession(model), lib.racePace(model), lib.strength(model),
  ];

  it('ne construit aucune séance impossible, sur le laboratoire comme sur le terrain', () => {
    for (const [name, model] of [['laboratoire', LAB_MODEL], ['terrain', PIERRE_MODEL]] as const) {
      for (const s of library(model)) {
        const refused = lib.checkVertical(s.blocks, lib.verticalOf(model), s.type).filter((v) => !v.feasible);
        expect(refused.map(lib.describeVerdict), `${name} — ${s.title}`).toEqual([]);
        expect(lib.elevationGainOf(s.blocks), `${name} — ${s.title}`).toBe(s.elevationGainM);
      }
    }
  });

  it('fait céder le dénivelé de la rando-course plutôt que sa descente, et le dit', () => {
    const s = lib.longTrail(PIERRE_MODEL, 180, 1384);
    expect(s.elevationGainM).toBeLessThan(1384);
    expect(s.title).toContain(`${s.elevationGainM} m D+`);
    expect(s.blocks.find((b) => b.elevationLossM)?.elevationLossM).toBe(s.elevationGainM);
    expect(lib.totalDuration(s.blocks)).toBe(180 * 60);
    expect(s.amendments?.join(' ')).toMatch(/Dénivelé ramené de 1384 à \d+ m/);
  });

  it('laisse à la remontée d\'une descente le temps que la courbe accorde', () => {
    // 90 m remontés en 3 min 30 : au-delà de ce que Pierre a jamais tenu sur cette durée.
    const s = lib.downhillSession(PIERRE_MODEL, 6, 150);
    expect(s.amendments?.[0]).toMatch(/récupération/);
    expect(lib.elevationLossOf(s.blocks)).toBe(s.elevationGainM);
    expect(s.elevationGainM).toBeLessThan(540);
  });
});

describe('Écriture par le coach', () => {
  it('refuse une montée que la courbe n\'atteste pas, en donnant la borne', () => {
    expect(() =>
      lib.parseSessionBlocks(
        [
          { label: 'Montées', zone: 'Z2', durationS: 3320, elevationGainM: 1384, elevationLossM: 0 },
          { label: 'Descentes', zone: 'Z2', durationS: 2582, elevationLossM: 1384 },
        ],
        PIERRE_MODEL,
      ),
    ).toThrow(/1501 m\/h ; ta courbe de montée atteste 826 m\/h sur cette durée \(terrain\)/);
  });

  it('refuse une descente logée dans trop peu de temps', () => {
    expect(() =>
      lib.parseSessionBlocks(
        [
          { label: 'Montées', zone: 'Z2', durationS: 6660, elevationGainM: 1384, elevationLossM: 0 },
          { label: 'Descentes', zone: 'Z2', durationS: 960, elevationLossM: 1384 },
        ],
        PIERRE_MODEL,
      ),
    ).toThrow(/blocks\[1\] : .*5190 m\/h ; ta courbe de descente atteste \d+ m\/h/);
  });

  it('refuse une descente posée sur une montée à vitesse cible', () => {
    expect(() =>
      lib.parseSessionBlocks(
        [{ label: 'Montée', zone: 'Z2', durationS: 3600, vamTargetMh: 600, elevationLossM: 600 }],
        PIERRE_MODEL,
      ),
    ).toThrow(/monte pendant toute sa durée/);
  });

  it('dit où il a situé une descente que personne n\'a déclarée', () => {
    expect(() =>
      lib.parseSessionBlocks(
        [{ label: 'Montées', zone: 'Z2', durationS: 3320, elevationGainM: 1384 }],
        PIERRE_MODEL,
      ),
    ).toThrow(/Aucun bloc ne déclare son D−/);
  });

  it('accepte le même dénivelé dans le temps qu\'il demande', () => {
    const blocks = lib.parseSessionBlocks(
      [
        { label: 'Montées', zone: 'Z2', durationS: 6700, elevationGainM: 1384, elevationLossM: 0 },
        { label: 'Descentes', zone: 'Z2', durationS: 3200, elevationLossM: 1384 },
      ],
      PIERRE_MODEL,
    );
    const totals = lib.sessionTotals(PIERRE_MODEL, blocks);
    expect(totals.elevationGainM).toBe(1384);
    expect(totals.mechanicalLoad).toBe(lib.sessionTotals(PIERRE_MODEL, blocks, 1384).mechanicalLoad);
  });
});

describe('Séance déjà écrite', () => {
  it('répare la rando-course enregistrée sans l\'allonger, et dit ce qu\'elle a cédé', () => {
    const t = lib.transformSession(STORED_RANDO_0310, 1, PIERRE_MODEL);
    const verdicts = lib.checkVertical(t.blocks, lib.verticalOf(PIERRE_MODEL), 'long_trail');
    expect(verdicts.length).toBe(2);
    expect(verdicts.every((v) => v.feasible)).toBe(true);
    expect(t.plannedDurationS).toBe(lib.totalDuration(STORED_RANDO_0310.blocks));
    // La descente est située sur le bloc qui suit la montée, et la boucle se referme.
    expect(t.blocks[2]!.elevationLossM).toBe(t.plannedElevationGainM);
    expect(t.plannedElevationGainM).toBeLessThan(1384);
    expect(t.amendments[0]).toMatch(/Dénivelé ramené de 1384 à \d+ m D\+ et de 1384 à \d+ m D−/);
  });
});
