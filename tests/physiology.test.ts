import { describe, expect, it } from 'vitest';
import {
  LAB_TEST_2025_07_24, PIERRE, courseFromLapFormat, describeLapFormat, isLapCourse, lapsForHours,
  type DailyCheckIn, type LapFormat, type PlannedSession, type PmcSeries,
} from '@cairn/core';
import {
  buildZones, computePmc, densifyDailyLoads, fitCriticalSpeed, formatClock,
  fractionalUtilization, gradeAdjustedSpeed, kmhToMs, locomotionCost, meanMaximal,
  modelFromLabOnly, msToKmh, normalizeStreams, predictRace, runningCost,
  runningTss, targetRaceDayTsb, vam, walkingCost, wPrimeBalance,
  polarizationIndex, mechanicalLoad, heatStressFactor, altitudeVo2Factor,
  durabilityAdjustedCs, detectIntervals, assessSeries, computeAcwr,
  descentSpeedCeiling, walkRunTransitionSpeed, speedForMetabolicPower,
  technicalityCostMultiplier, aggregateDurability, blendCriticalSpeed,
  csPriorFromThresholds, maximalEffortSupport, projectFrom, type DurabilityResult,
  buildPhysiologyModel, labWeight, PROOF_HALF_LIFE_DAYS, type FieldEvidence,
  matchPlannedSession, sessionOutcome, type RealizedEffort, computeReadiness,
  eccentricStrengthLoad, prescribedMechanicalLoad, ECCENTRIC_MOVEMENTS,
  type ReadinessDay, ACWR_SPIKE, analyzeDurability, buildPmcSeries, durabilityFactor,
  projectLoadRatios, type DurabilitySample, predictLapRace,
} from '@cairn/physiology';

const LAB_DATE = '2025-07-24';
const model = modelFromLabOnly(LAB_TEST_2025_07_24, LAB_DATE);

describe('Coût métabolique (Minetti 2002)', () => {
  it('reproduit les coûts de référence à plat', () => {
    expect(runningCost(0)).toBeCloseTo(3.6, 6);
    expect(walkingCost(0)).toBeCloseTo(2.5, 6);
  });

  it('atteint son minimum en descente autour de −18 %', () => {
    const grades = Array.from({ length: 91 }, (_, i) => -0.45 + i * 0.01);
    const costs = grades.map(runningCost);
    const minIdx = costs.indexOf(Math.min(...costs));
    expect(grades[minIdx]).toBeGreaterThan(-0.26);
    expect(grades[minIdx]).toBeLessThan(-0.12);
  });

  it('croît de façon monotone en montée', () => {
    for (let i = 0; i < 0.44; i += 0.01) {
      expect(runningCost(i + 0.01)).toBeGreaterThan(runningCost(i));
    }
  });

  it('choisit la marche en montée raide et la course à plat', () => {
    // 1,2 m/s à 25 % : personne ne court là, le modèle doit utiliser le coût de marche.
    expect(locomotionCost(1.2, 0.25)).toBeCloseTo(walkingCost(0.25), 6);
    // 4 m/s à plat : impossible en marchant.
    expect(locomotionCost(4, 0)).toBeCloseTo(runningCost(0), 6);
  });
});

describe('Vitesse corrigée de la pente (GAP)', () => {
  it('est neutre à plat', () => {
    expect(gradeAdjustedSpeed(4, 0)).toBeCloseTo(4, 6);
  });

  it('donne une équivalence crédible pour une marche rapide à 25 %', () => {
    const gap = gradeAdjustedSpeed(1.2, 0.25); // ≈ 4,3 km/h réels
    expect(msToKmh(gap)).toBeGreaterThan(10);
    expect(msToKmh(gap)).toBeLessThan(13);
  });

  it('dévalorise la descente rapide, métaboliquement bon marché', () => {
    expect(gradeAdjustedSpeed(4, -0.15)).toBeLessThan(4);
  });

  it('calcule une VAM cohérente', () => {
    // 1,0 m/s à 20 % ⇒ composante verticale ≈ 0,196 m/s ⇒ ~706 m/h
    expect(vam(1.0, 0.2)).toBeGreaterThan(650);
    expect(vam(1.0, 0.2)).toBeLessThan(760);
  });
});

describe('Zones — fidélité au compte rendu du laboratoire', () => {
  const zones = buildZones(model);
  const z = (k: string) => zones.find((x) => x.key === k)!;

  it('reproduit exactement les bornes de fréquence cardiaque prescrites', () => {
    expect(z('Z1').hrMax).toBe(141);
    expect(z('Z2').hrMax).toBe(155);
    expect(z('Z3').hrMax).toBe(171);
    expect(z('Z4').hrMax).toBe(175);
    expect(z('Z5').hrMax).toBe(187);
  });

  it('reproduit les bornes de vitesse prescrites', () => {
    expect(msToKmh(z('Z1').speedMaxMs)).toBeCloseTo(10.8, 1);
    expect(msToKmh(z('Z2').speedMaxMs)).toBeCloseTo(13.2, 1);
    expect(msToKmh(z('Z3').speedMaxMs)).toBeCloseTo(16.8, 1);
    expect(msToKmh(z('Z4').speedMaxMs)).toBeCloseTo(20.0, 1);
  });

  it('restitue les seuils du test sans les déformer', () => {
    expect(msToKmh(model.vt1.speedMs)).toBeCloseTo(13.2, 2);
    expect(msToKmh(model.vt2.speedMs)).toBeCloseTo(16.8, 2);
    expect(model.vt1.hr).toBe(155);
    expect(model.vt2.hr).toBe(171);
    expect(model.hrMax).toBe(187);
  });

  it("écarte la FC de repos du laboratoire, non représentative d'un vrai repos", () => {
    expect(model.hrRest).toBeLessThan(70);
    expect(model.hrRest).toBeGreaterThan(35);
  });
});

describe('Charge d\'entraînement', () => {
  it('attribue 100 points à une heure exactement au seuil', () => {
    const samples = Array.from({ length: 3600 }, () => ({
      dt: 1, speedMs: model.vt2.speedMs, grade: 0, hr: model.vt2.hr,
    }));
    const { tss, intensityFactor } = runningTss(samples, model.vt2.speedMs);
    expect(intensityFactor).toBeCloseTo(1, 2);
    expect(tss).toBeGreaterThan(97);
    expect(tss).toBeLessThan(103);
  });

  it('produit une charge mécanique proportionnelle au dénivelé négatif', () => {
    const descend = (durationS: number) =>
      Array.from({ length: durationS }, () => ({ dt: 1, speedMs: 2.5, grade: -0.15, hr: 150 }));
    const short = mechanicalLoad(descend(600));
    const long = mechanicalLoad(descend(1200));
    expect(long.score).toBeGreaterThan(short.score * 1.9);
    expect(long.descentM).toBeGreaterThan(short.descentM * 1.9);
  });

  it('ignore la descente dans la charge métabolique mais pas dans la mécanique', () => {
    const flat = Array.from({ length: 1800 }, () => ({ dt: 1, speedMs: 3.2, grade: 0, hr: 150 }));
    const down = Array.from({ length: 1800 }, () => ({ dt: 1, speedMs: 3.8, grade: -0.12, hr: 150 }));
    expect(mechanicalLoad(flat).score).toBeLessThan(mechanicalLoad(down).score);
  });

  it('déclare ce que la charge mécanique mesurée couvre', () => {
    // Un circuit de force ne produit aucun échantillon : la mesure n'y voit
    // rien, et un zéro par cécité doit pouvoir se distinguer d'un zéro mesuré.
    const flat = Array.from({ length: 600 }, () => ({ dt: 1, speedMs: 3.0, grade: 0, hr: 140 }));
    expect(mechanicalLoad(flat).coverage).toBe('running_descent');
  });
});

describe('Charge mécanique prescrite', () => {
  const CIRCUIT = {
    rounds: 1,
    exercises: [
      { movement: 'split_squat' as const, reps: 8 },
      { movement: 'step_down' as const, reps: 10 },
      { movement: 'single_leg_deadlift' as const, reps: 8 },
      { movement: 'eccentric_calf' as const, reps: 12 },
      { movement: 'isometric' as const, reps: 45 },
    ],
  };

  it('fait varier la charge avec le nombre de tours', () => {
    const un = eccentricStrengthLoad([{ ...CIRCUIT, rounds: 1 }]).score;
    const deux = eccentricStrengthLoad([{ ...CIRCUIT, rounds: 2 }]).score;
    const trois = eccentricStrengthLoad([{ ...CIRCUIT, rounds: 3 }]).score;
    expect(un).toBeGreaterThan(0);
    expect(deux).toBeCloseTo(un * 2, 10);
    expect(trois).toBeCloseTo(un * 3, 10);
  });

  it('ne prête aucune charge excentrique au gainage', () => {
    const gainage = eccentricStrengthLoad([
      { rounds: 5, exercises: [{ movement: 'isometric', reps: 60 }] },
    ]);
    expect(gainage.score).toBe(0);
    expect(gainage.reps).toBe(0);
  });

  it('compte deux fois un mouvement unilatéral', () => {
    // 10 répétitions par jambe font 20 freinages, pas 10.
    const uni = eccentricStrengthLoad([
      { rounds: 1, exercises: [{ movement: 'step_down', reps: 10 }] },
    ]);
    expect(ECCENTRIC_MOVEMENTS.step_down.unilateral).toBe(true);
    expect(uni.reps).toBe(20);
  });

  it('garde la calibration de la descente : ~40 pts pour 1 000 m de D−', () => {
    const m = prescribedMechanicalLoad({ elevationLossM: 1000 });
    expect(m.descent).toBeGreaterThan(37);
    expect(m.descent).toBeLessThan(43);
    expect(m.eccentricStrength).toBe(0);
    expect(m.total).toBeCloseTo(m.descent, 10);
  });

  it('isole la part qu\'aucun flux ne pourra confirmer', () => {
    // La séparation n'est pas cosmétique : c'est elle qui permet de dire, en
    // face d'un réalisé à zéro, si l'athlète n'a rien fait ou si la mesure est
    // aveugle. Confondues dans un total muet, les deux se lisent pareil.
    const m = prescribedMechanicalLoad({
      elevationLossM: 200,
      distanceM: 10000,
      circuits: [{ ...CIRCUIT, rounds: 3 }],
    });
    const sansCircuit = prescribedMechanicalLoad({ elevationLossM: 200, distanceM: 10000 });
    expect(m.eccentricStrength).toBeGreaterThan(0);
    expect(m.descent).toBeCloseTo(sansCircuit.total, 10);
    expect(m.total).toBeCloseTo(m.descent + m.eccentricStrength, 10);
  });
});

describe('PMC', () => {
  it('converge la CTL vers la charge quotidienne constante', () => {
    const daily = Array.from({ length: 400 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      load: 60,
    }));
    const pmc = computePmc(daily, { chronic: 42, acute: 7 });
    const last = pmc[pmc.length - 1]!;
    expect(last.ctl).toBeCloseTo(60, 0);
    expect(last.atl).toBeCloseTo(60, 0);
    expect(Math.abs(last.tsb)).toBeLessThan(0.5);
  });

  it('densifie les jours sans activité', () => {
    const dense = densifyDailyLoads(
      [
        { date: '2026-01-01', metabolic: 50, mechanical: 10 },
        { date: '2026-01-05', metabolic: 80, mechanical: 30 },
      ],
    );
    expect(dense).toHaveLength(5);
    expect(dense[1]!.metabolic).toBe(0);
    expect(dense[4]!.metabolic).toBe(80);
  });

  it('agrège deux activités du même jour', () => {
    const dense = densifyDailyLoads([
      { date: '2026-01-01', metabolic: 50, mechanical: 10 },
      { date: '2026-01-01', metabolic: 30, mechanical: 5 },
    ]);
    expect(dense[0]!.metabolic).toBe(80);
    expect(dense[0]!.mechanical).toBe(15);
  });

  it('signale un pic de charge par un ACWR élevé', () => {
    const daily = [
      ...Array.from({ length: 28 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), load: 40,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 0, 29 + i)).toISOString().slice(0, 10), load: 160,
      })),
    ];
    const acwr = computeAcwr(daily);
    expect(acwr[acwr.length - 1]!.value).toBeGreaterThan(1.5);
  });

  it('cible un TSB de course décroissant avec la durée', () => {
    expect(targetRaceDayTsb(2700).metabolic).toBeGreaterThan(targetRaceDayTsb(36000).metabolic);
  });
});

describe('Projection du PMC sur des charges à venir', () => {
  const seed = { ctl: 40, atl: 40 };
  const days = (from: string, n: number, load: number) =>
    Array.from({ length: n }, (_, i) => ({
      date: new Date(new Date(`${from}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10),
      load,
    }));

  it('part de l\'état donné et couvre exactement la fenêtre', () => {
    const points = projectFrom(seed, days('2026-09-01', 10, 50), '2026-09-01', '2026-09-10');
    expect(points).toHaveLength(10);
    expect(points[0]!.date).toBe('2026-09-01');
    expect(points[points.length - 1]!.date).toBe('2026-09-10');
  });

  it('compte zéro les jours absents des charges — c\'est ainsi qu\'une coupure se paie', () => {
    const coupure = projectFrom(seed, [], '2026-09-01', '2026-09-11');
    const last = coupure[coupure.length - 1]!;
    expect(last.ctl).toBeLessThan(seed.ctl);
    // La fatigue s'efface plus vite que la forme : onze jours suffisent à
    // renverser le TSB, et à faire d'une charge d'aujourd'hui un mauvais point
    // de départ pour un plan qui commence plus tard.
    expect(last.atl).toBeLessThan(last.ctl);
    expect(last.tsb).toBeGreaterThan(0);
  });

  it('n\'invente rien hors de la fenêtre', () => {
    // Une charge datée hors bornes ne pèse pas, et une fenêtre inversée ne
    // produit aucun point plutôt qu'un état supposé.
    const hors = projectFrom(seed, days('2026-08-01', 5, 200), '2026-09-01', '2026-09-05');
    expect(hors).toEqual(projectFrom(seed, [], '2026-09-01', '2026-09-05'));
    expect(projectFrom(seed, [], '2026-09-05', '2026-09-01')).toEqual([]);
  });

  it('additionne deux charges du même jour', () => {
    const seule = projectFrom(seed, [{ date: '2026-09-01', load: 100 }], '2026-09-01', '2026-09-01');
    const deux = projectFrom(
      seed,
      [{ date: '2026-09-01', load: 60 }, { date: '2026-09-01', load: 40 }],
      '2026-09-01',
      '2026-09-01',
    );
    expect(deux[0]!.load).toBe(seule[0]!.load);
    expect(deux[0]!.tsb).toBe(seule[0]!.tsb);
  });
});

describe('Ratio de charge de chaque filière', () => {
  const day = (i: number) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);

  it('donne son ratio à la filière mécanique, qui s\'emballe quand la métabolique ne bouge pas', () => {
    // Quatre semaines régulières, puis un palier excentrique : la charge
    // cardiovasculaire est la même, le freinage sextuple.
    const loads = Array.from({ length: 29 }, (_, i) => ({
      date: day(i), metabolic: 60, mechanical: i === 28 ? 40 : 6,
    }));
    const pmc = buildPmcSeries(loads);
    expect(pmc.acwr[28]!.value).toBeLessThanOrEqual(1.3);
    expect(pmc.mechanicalAcwr[28]!.value).toBeGreaterThan(ACWR_SPIKE.mechanical);
  });

  it('lit un pic prévu contre la charge chronique réalisée avant lui', () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ date: day(i), metabolic: 50, mechanical: 20 }));
    const planned = [
      { date: day(40), metabolic: 50, mechanical: 60 },
      // Hors fenêtre : ne pèse rien.
      { date: day(60), metabolic: 500, mechanical: 500 },
    ];
    const points = projectLoadRatios(history, planned, day(40), day(41));
    expect(points.map((p) => p.date)).toEqual([day(40), day(41)]);
    const mechanical = computeAcwr([...history, planned[0]!].map((l) => ({ date: l.date, load: l.mechanical })));
    expect(points[0]!.mechanical).toBe(mechanical[40]!.value);
    // Sans l'historique, le même jour ne mesure plus rien : la série part de lui.
    expect(projectLoadRatios([], planned, day(40), day(41))[0]!.mechanical).toBe(1);
  });
});

describe('Vitesse critique', () => {
  it('retrouve CS et D\' depuis une courbe synthétique', () => {
    const CS = 4.6;
    const DP = 210;
    const curve: Record<string, number> = {};
    for (const t of [120, 180, 300, 420, 600, 900, 1200]) curve[String(t)] = CS + DP / t;
    const fit = fitCriticalSpeed(curve);
    expect(fit.criticalSpeedMs).toBeCloseTo(CS, 3);
    expect(fit.dPrimeM).toBeCloseTo(DP, 0);
    expect(fit.r2).toBeGreaterThan(0.999);
    expect(fit.quality).toBe('strong');
  });

  it('refuse de conclure sur trop peu de points', () => {
    expect(fitCriticalSpeed({ '300': 4.5 }).quality).toBe('insufficient');
  });

  it("n'accorde le poids d'une mesure qu'aux ajustements portés par un effort maximal", () => {
    // Une courbe irréprochable — r² > 0,999, qualité « strong » —, mais produite
    // en aisance : le point long, celui qui fixe l'asymptote, a été couru 20 bpm
    // sous le seuil 2. C'est le cas que le r² seul ne sait pas voir.
    const CS = 3.6;
    const DP = 260;
    const durations = [120, 180, 300, 420, 600, 900, 1200];
    const curve: Record<string, number> = {};
    for (const t of durations) curve[String(t)] = CS + DP / t;
    const fit = fitCriticalSpeed(curve);
    expect(fit.quality).toBe('strong');

    const labVt2Hr = LAB_TEST_2025_07_24.vt2.hr;
    const prior = csPriorFromThresholds(LAB_TEST_2025_07_24.vt2.speedMs, LAB_TEST_2025_07_24.vmaMs);

    // Cas 1 — tous les points au seuil : le terrain mesure, il garde tout son poids.
    const maximal = Object.fromEntries(durations.map((t) => [String(t), labVt2Hr + 6]));
    const proven = maximalEffortSupport(fit, maximal, labVt2Hr);
    expect(proven.support).toBe(1);
    expect(blendCriticalSpeed(fit, prior, proven.support).weightField).toBeCloseTo(0.85, 6);

    // Cas 2 — seul le point long est sous-maximal. Il pèse un tiers de la fenêtre
    // en durée : le poids du terrain doit reculer d'autant, et la CS retenue
    // remonter vers le laboratoire.
    const easyLongEffort = { ...maximal, '1200': labVt2Hr - 20 };
    const partial = maximalEffortSupport(fit, easyLongEffort, labVt2Hr);
    expect(partial.support).toBeCloseTo(2520 / 3720, 6);
    expect(partial.untestableS).toBe(0);

    const strict = blendCriticalSpeed(fit, prior, partial.support);
    const naive = blendCriticalSpeed(fit, prior);
    expect(strict.weightField).toBeLessThan(naive.weightField);
    expect(strict.criticalSpeedMs).toBeGreaterThan(naive.criticalSpeedMs);

    // Cas 3 — aucun effort au seuil : la courbe n'atteste que d'une régularité,
    // le laboratoire reprend la main entièrement.
    const easy = Object.fromEntries(durations.map((t) => [String(t), labVt2Hr - 20]));
    const unproven = blendCriticalSpeed(fit, prior, maximalEffortSupport(fit, easy, labVt2Hr).support);
    expect(unproven.weightField).toBe(0);
    expect(unproven.criticalSpeedMs).toBeCloseTo(prior.criticalSpeedMs, 6);

    // Cas 4 — sans FC, le critère se tait plutôt que de conclure.
    const silent = maximalEffortSupport(fit, {}, labVt2Hr);
    expect(silent.support).toBe(1);
    expect(silent.untestableS).toBe(3720);
  });

  it("fait vieillir la preuve d'effort maximal au lieu de la faire disparaître d'un coup", () => {
    // Une courbe portée par un seul effort maximal, qu'on fait vieillir jour après
    // jour. Le défaut corrigé ici : la séance sortait de la fenêtre d'observation
    // à date fixe, et la vitesse critique sautait d'un quart en vingt-quatre
    // heures — sans qu'aucune donnée n'ait changé.
    const durations = [120, 180, 300, 420, 600, 900, 1200];
    const CS = 3.6;
    const DP = 260;
    const curve: Record<string, number> = {};
    const hr: Record<string, number> = {};
    for (const t of durations) {
      curve[String(t)] = CS + DP / t;
      hr[String(t)] = LAB_TEST_2025_07_24.vt2.hr + 12;
    }

    const BASE = Date.parse('2026-09-02T00:00:00Z');
    const PROOF_AGE_AT_BASE = 40;
    const modelAtDay = (k: number) => {
      const asOf = new Date(BASE + k * 86_400_000).toISOString().slice(0, 10);
      const evidence: FieldEvidence = {
        gradedSpeedCurve: curve,
        gradedSpeedCurveHr: hr,
        gradedSpeedCurveAgeDays: Object.fromEntries(
          durations.map((t) => [String(t), PROOF_AGE_AT_BASE + k]),
        ),
        observedMaxHrs: [],
        restingHrs: [],
        bodyMasses: [],
        hrSpeedPairs: [],
        durability: { pctPerHour: 3, pctPer1000mVert: 4, confidence: 0.5 },
        vamCurve: {},
        dataDays: 60,
      };
      return buildPhysiologyModel(LAB_TEST_2025_07_24, evidence, asOf);
    };

    const days = Array.from({ length: 261 }, (_, k) => modelAtDay(k));

    // Continuité : d'un jour au suivant, la vitesse critique ne bouge jamais de
    // plus d'un centième de km/h. L'ancienne coupure dure valait 3,4 km/h.
    const steps = days.slice(1).map((m, i) => Math.abs(m.criticalSpeedMs - days[i]!.criticalSpeedMs));
    expect(Math.max(...steps) * 3.6).toBeLessThan(0.01);

    // Le passage du 120ᵉ jour de preuve — l'ancienne falaise — n'a rien de
    // particulier.
    const atBoundary = Math.abs(days[81]!.criticalSpeedMs - days[80]!.criticalSpeedMs);
    expect(atBoundary * 3.6).toBeLessThan(0.01);

    // La preuve s'escompte : à une demi-vie d'écart, elle ne pèse plus que moitié.
    const fresh = days[0]!.criticalSpeedEvidence!;
    const halved = days[PROOF_HALF_LIFE_DAYS]!.criticalSpeedEvidence!;
    expect(fresh.lastProofAgeDays).toBe(PROOF_AGE_AT_BASE);
    // `support` est arrondi au millième dans le modèle : on tolère cet arrondi.
    expect(Math.abs(halved.support - fresh.support / 2)).toBeLessThanOrEqual(0.001);

    // La confiance suit l'âge de la preuve au lieu de rester muette.
    const confidences = days.map((m) => m.confidence);
    expect(confidences[confidences.length - 1]!).toBeLessThan(confidences[0]!);
    expect(days.slice(1).every((m, i) => m.confidence <= days[i]!.confidence)).toBe(true);

    // Le laboratoire ne récupère que ce que sa fraîcheur lui laisse : la preuve
    // éteinte, la CS reste tirée par le terrain, loin du prior de 17,1 km/h.
    const last = days[days.length - 1]!;
    const prior = csPriorFromThresholds(LAB_TEST_2025_07_24.vt2.speedMs, LAB_TEST_2025_07_24.vmaMs);
    expect(last.criticalSpeedEvidence!.support).toBeLessThan(0.1);
    expect(last.criticalSpeedMs).toBeLessThan(prior.criticalSpeedMs * 0.85);
    expect(last.criticalSpeedMs).toBeGreaterThan(CS);
    expect(last.criticalSpeedEvidence!.weightLab).toBeLessThan(
      labWeight(LAB_TEST_2025_07_24.date, last.asOf),
    );
  });

  it('vide puis recharge la réserve anaérobie', () => {
    const cs = 4.5;
    const dp = 200;
    const hard = new Array(40).fill(5.5);
    const easy = new Array(120).fill(3.0);
    const bal = wPrimeBalance([...hard, ...easy], cs, dp);
    expect(bal[39]!).toBeLessThan(dp);
    expect(bal[159]!).toBeGreaterThan(bal[39]!);
  });
});

describe('Environnement', () => {
  it('pénalise la chaleur, davantage sur les efforts longs', () => {
    expect(heatStressFactor(13, 3600)).toBeCloseTo(1, 3);
    const short = heatStressFactor(30, 3600);
    const long = heatStressFactor(30, 4 * 3600);
    expect(short).toBeGreaterThan(1.02);
    expect(long).toBeGreaterThan(short);
    expect(long).toBeLessThan(1.15);
  });

  it("dégrade la VO2max avec l'altitude, plus fortement chez un athlète entraîné", () => {
    expect(altitudeVo2Factor(300, 64.6)).toBeCloseTo(1, 3);
    const trained = altitudeVo2Factor(2500, 64.6);
    const average = altitudeVo2Factor(2500, 50);
    expect(trained).toBeLessThan(average);
    expect(trained).toBeGreaterThan(0.8);
    expect(trained).toBeLessThan(0.95);
  });
});

describe('Durabilité', () => {
  const durabilityEntry = (
    pctPerHour: number,
    pctPer1000mVert: number | null,
    timeVertCorrelation: number | null = 0.5,
  ): { result: DurabilityResult; ageDays: number; durationS: number } => ({
    result: {
      pctPerHour,
      pctPer1000mVert,
      baselineEf: 0.03,
      windows: [],
      sampleQuality: 'good',
      r2Time: 0.8,
      timeVertCorrelation,
    },
    ageDays: 10,
    durationS: 5400,
  });

  it("ne présente pas comme mesurée une valeur qui atteint sa borne de plausibilité", () => {
    // Des pentes verticales très dispersées, dont l'agrégat dépasse la borne :
    // la régression n'a rien identifié. Ramené à 20 %/1 000 m, ce non-résultat
    // coûterait plus de 10 % dans la prédiction de course, avec l'apparence
    // d'une mesure.
    const saturated = aggregateDurability([
      durabilityEntry(6.5, 23.4),
      durabilityEntry(6.4, 25.7),
      durabilityEntry(6.6, 29.0),
    ]);
    expect(saturated.raw.perVert).toBeGreaterThanOrEqual(20);
    expect(saturated.measured.perVert).toBe(false);
    expect(saturated.pctPer1000mVert).toBe(4.0);
    // La perte horaire, elle, reste dans ses bornes : elle est mesurée.
    expect(saturated.measured.perHour).toBe(true);
    expect(saturated.pctPerHour).toBeCloseTo(6.5, 6);

    // Un agrégat intérieur aux bornes passe intact, et se déclare mesuré.
    const measured = aggregateDurability([
      durabilityEntry(3.2, 5.1),
      durabilityEntry(3.4, 5.4),
      durabilityEntry(3.0, 4.8),
    ]);
    expect(measured.measured).toEqual({ perHour: true, perVert: true });
    expect(measured.pctPer1000mVert).toBeCloseTo(5.1, 6);

    // Aucune séance n'ayant produit de pente verticale, la valeur est un repli
    // annoncé comme tel — pas un zéro déguisé en mesure.
    const absent = aggregateDurability([durabilityEntry(3.2, null), durabilityEntry(3.4, null)]);
    expect(absent.raw.perVert).toBeNull();
    expect(absent.measured.perVert).toBe(false);
    expect(absent.pctPer1000mVert).toBe(4.0);
  });

  it('dégrade la vitesse critique avec le temps et le dénivelé', () => {
    const cs = 4.6;
    const m = { pctPerHour: 3, pctPer1000mVert: 4 };
    expect(durabilityAdjustedCs(cs, 0, 0, m)).toBeCloseTo(cs, 5);
    const after3h = durabilityAdjustedCs(cs, 3 * 3600, 0, m);
    const after3hVert = durabilityAdjustedCs(cs, 3 * 3600, 1500, m);
    expect(after3h).toBeLessThan(cs);
    expect(after3hVert).toBeLessThan(after3h);
  });

  it('ne compte qu\'une fois la perte que le dénivelé réexprime', () => {
    // Une perte horaire de 6 % mesurée sur des sorties à 300 m D+/h, et une
    // perte par 1 000 m qui n'en est que la réexpression : 20 %. Sur 3 h et
    // 900 m, les deux termes disent la même perte de 18 %, pas √3 fois elle.
    const model = { pctPerHour: 6, pctPer1000mVert: 20, vertRateMh: 300 };
    expect(durabilityFactor(3 * 3600, 900, model)).toBeCloseTo(0.82, 6);
    // Le dénivelé au-delà de ce rythme, lui, est indépendant du temps et s'ajoute.
    expect(durabilityFactor(3 * 3600, 1500, model)).toBeCloseTo(1 - 0.18 - 0.2 * 0.6, 6);
    // Sans rythme connu, rien n'est contenu : les deux pertes s'additionnent.
    expect(durabilityFactor(3 * 3600, 1200, { pctPerHour: 3, pctPer1000mVert: 4 })).toBeCloseTo(0.862, 6);
  });

  it('ne fait pas passer pour mesurée une pente verticale colinéaire au temps', () => {
    // Deux heures de montée régulière : le D+ cumulé suit exactement le temps.
    const samples: DurabilitySample[] = Array.from({ length: 7200 }, (_, t) => ({
      t, dt: 1, speedMs: 2.5, grade: 0.08, hr: 140 + (15 * t) / 7200,
      cumulativeVertM: 2.5 * Math.sin(Math.atan(0.08)) * t,
    }));
    const steady = analyzeDurability(samples, { hrMin: 120, hrMax: 180 });
    expect(steady.pctPerHour).toBeGreaterThan(0);
    expect(steady.timeVertCorrelation).toBeCloseTo(1, 3);
    expect(steady.pctPer1000mVert).toBeNull();

    // Une pente par 1 000 m intérieure à ses bornes ne suffit plus : sa séance
    // doit prouver qu'elle sépare le dénivelé du temps. Sans corrélation — une
    // analyse d'avant le moteur 1.3.0 —, rien n'est prouvé.
    const collinear = aggregateDurability([18.1, 17.9, 18.4].map((v) => durabilityEntry(6, v, 0.97)));
    expect(collinear.measured.perVert).toBe(false);
    expect(collinear.pctPer1000mVert).toBe(4.0);
    const legacy = aggregateDurability([18.1, 17.9, 18.4].map((v) => durabilityEntry(6, v, null)));
    expect(legacy.measured.perVert).toBe(false);
    const separated = aggregateDurability([18.1, 17.9, 18.4].map((v) => durabilityEntry(6, v, 0.5)));
    expect(separated.measured.perVert).toBe(true);
    expect(separated.pctPer1000mVert).toBeCloseTo(18.1, 6);
  });

  it('situe la perte horaire par le D+ horaire des séances qui la mesurent', () => {
    const entries = [300, 350, 900].map((vertM) => ({ ...durabilityEntry(6, null), durationS: 3600, vertM }));
    expect(aggregateDurability(entries).vertRateMh).toBe(350);
    // Une perte horaire tombée au repli ne contient le dénivelé de personne.
    const fallback = [300, 350, 900].map((vertM) => ({ ...durabilityEntry(16, null), durationS: 3600, vertM }));
    expect(aggregateDurability(fallback).vertRateMh).toBeNull();
  });
});

describe('Détection de structure', () => {
  const zones = buildZones(model);

  it('retrouve 5 × 3 min dans un flux synthétique', () => {
    const samples: { t: number; speedMs: number; grade: number; hr: number | null; cadence: number | null }[] = [];
    let t = 0;
    const push = (n: number, v: number) => {
      for (let i = 0; i < n; i++) samples.push({ t: t++, speedMs: v, grade: 0, hr: 150, cadence: 170 });
    };
    push(600, 3.0);            // échauffement
    for (let r = 0; r < 5; r++) { push(180, 4.9); push(90, 2.6); }
    push(400, 3.0);            // retour au calme
    const intervals = detectIntervals(samples, zones);
    expect(intervals).toHaveLength(5);
    expect(intervals[0]!.durationS).toBeGreaterThan(170);
    expect(intervals[0]!.durationS).toBeLessThan(200);
  });

  it('ne fabrique pas de blocs sur un footing continu', () => {
    const samples = Array.from({ length: 3000 }, (_, i) => ({
      t: i, speedMs: 3.2 + Math.sin(i / 40) * 0.06, grade: 0, hr: 145, cadence: 168,
    }));
    expect(detectIntervals(samples, zones)).toHaveLength(0);
  });

  it('juge la régularité d\'une série', () => {
    const base = { startS: 0, endS: 180, durationS: 180, distanceM: 900, avgGrade: 0, avgHr: 170, maxHr: 175, avgCadence: 175, zone: 'Z4' as const };
    const steady = [5.0, 4.99, 5.01, 4.98, 5.0].map((v, i) => ({ ...base, index: i + 1, avgSpeedMs: v, avgGradedSpeedMs: v }));
    expect(assessSeries(steady)!.verdict).toBe('excellent');
    const fading = [5.3, 5.1, 4.9, 4.7, 4.5].map((v, i) => ({ ...base, index: i + 1, avgSpeedMs: v, avgGradedSpeedMs: v }));
    expect(assessSeries(fading)!.verdict).toBe('décrochage');
  });
});

describe('Polarisation', () => {
  it('classe une distribution polarisée au-dessus de 2', () => {
    expect(polarizationIndex(0.82, 0.04, 0.14)).toBeGreaterThan(2);
  });
  it('classe une distribution seuillée en dessous de 2', () => {
    expect(polarizationIndex(0.6, 0.3, 0.1)).toBeLessThan(2);
  });
});

describe('Normalisation des flux', () => {
  it('ré-échantillonne un flux irrégulier à 1 Hz', () => {
    const time = [0, 3, 7, 12, 20];
    const distance = [0, 10, 24, 40, 66];
    const altitude = [100, 101, 103, 106, 110];
    const heartrate = [110, 120, 130, 140, 150];
    const res = normalizeStreams({ time, distance, altitude, heartrate });
    expect(res.streams.time).toHaveLength(21);
    expect(res.streams.distance[20]).toBeCloseTo(66, 1);
    expect(res.streams.heartrate![20]).toBe(150);
    expect(res.hrCoverage).toBeCloseTo(1, 2);
  });

  it('empêche la distance de reculer', () => {
    const res = normalizeStreams({
      time: [0, 1, 2, 3, 4],
      distance: [0, 5, 3, 12, 18], // recul GPS au 3ᵉ point
      altitude: [0, 0, 0, 0, 0],
    });
    const d = res.streams.distance;
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeGreaterThanOrEqual(d[i - 1]!);
  });
});

describe('Résolution vitesse ↔ puissance', () => {
  it('est exactement réciproque de la puissance métabolique', () => {
    for (const grade of [-0.3, -0.1, 0, 0.08, 0.2, 0.35]) {
      for (const v of [1.0, 1.8, 2.6, 4.0]) {
        const p = locomotionCost(v, grade) * v;
        const solved = speedForMetabolicPower(p, grade);
        expect(solved).toBeCloseTo(v, 4);
      }
    }
  });

  it('ne diverge pas au voisinage du seuil de transition marche/course', () => {
    for (const grade of [0, 0.1, 0.2, 0.3]) {
      const vt = walkRunTransitionSpeed(grade);
      for (const v of [vt - 0.02, vt, vt + 0.02]) {
        const solved = speedForMetabolicPower(locomotionCost(v, grade) * v, grade);
        expect(Number.isFinite(solved)).toBe(true);
        expect(Math.abs(solved - v)).toBeLessThan(0.35);
      }
    }
  });

  it('exprime la technicité comme un surcoût, jamais inférieur à 1', () => {
    for (const t of [1, 2, 3, 4, 5] as const) {
      for (const g of [-0.2, 0, 0.2]) {
        expect(technicalityCostMultiplier(t, g)).toBeGreaterThanOrEqual(0.999);
      }
    }
  });
});

describe('Prédiction de course', () => {
  it('décroît la fraction de vitesse critique soutenable avec la durée', () => {
    expect(fractionalUtilization(1200)).toBe(1);
    expect(fractionalUtilization(3600)).toBeCloseTo(0.93, 2);
    expect(fractionalUtilization(7200)).toBeCloseTo(0.876, 2);
    expect(fractionalUtilization(4 * 3600)).toBeLessThan(fractionalUtilization(2 * 3600));
  });

  it('plafonne la vitesse de descente sous la limite technique', () => {
    const p = predictRace({
      model,
      course: { distanceM: 20000, elevationGainM: 0, elevationLossM: 1500, technicality: 3 },
      skipLimiters: true,
    });
    // Aucun tronçon descendant ne doit dépasser le plafond mécanique : sans lui,
    // le modèle dévalerait à plus de 20 km/h sur du −12 %.
    for (const seg of p.pacing) {
      if (seg.avgGrade < -0.04) {
        expect(seg.targetSpeedMs).toBeLessThanOrEqual(
          descentSpeedCeiling(seg.avgGrade, 3) + 0.35,
        );
      }
    }
  });

  it('ralentit quand la technicité augmente, toutes choses égales', () => {
    const course = { distanceM: 30000, elevationGainM: 1000, elevationLossM: 1000, expectedTempC: 12 };
    const easy = predictRace({ model, course: { ...course, technicality: 1 }, skipLimiters: true });
    const hard = predictRace({ model, course: { ...course, technicality: 5 }, skipLimiters: true });
    expect(hard.predictedTimeS).toBeGreaterThan(easy.predictedTimeS * 1.1);
  });

  it('prédit un temps plausible sur un trail de 32 km / 1200 m D+', () => {
    const p = predictRace({
      model,
      course: {
        distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200,
        technicality: 3, expectedTempC: 14,
      },
      raceDayTsb: 10,
    });
    const hours = p.predictedTimeS / 3600;
    // Un coureur à VMA 20 km/h correctement préparé vise le top 10 régional sur
    // ce format : entre 2h40 et 3h10.
    expect(hours).toBeGreaterThan(2.66);
    expect(hours).toBeLessThan(3.2);
    expect(p.flatEquivalentDistanceM).toBeGreaterThan(32000);
    expect(p.pacing.length).toBeGreaterThan(5);
    expect(p.fueling.carbGPerHour).toBeGreaterThan(50);
  });

  it('classe le trail plus lent que la route à distance égale', () => {
    const base = { distanceM: 32000, elevationLossM: 0, technicality: 1 as const, expectedTempC: 14 };
    const road = predictRace({ model, course: { ...base, elevationGainM: 0 }, skipLimiters: true });
    const trail = predictRace({
      model,
      course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 4, expectedTempC: 14 },
      skipLimiters: true,
    });
    expect(trail.predictedTimeS).toBeGreaterThan(road.predictedTimeS);
  });

  it('termine son calcul de facteurs limitants sans récursion infinie', () => {
    const p = predictRace({
      model,
      course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 3 },
    });
    expect(Array.isArray(p.limiters)).toBe(true);
  });

  it('reste cohérent avec les temps de référence du laboratoire sur route', () => {
    // Le labo annonce 3 h 11 min sur marathon. Le modèle, sur parcours plat et
    // roulant, doit tomber dans le même ordre de grandeur.
    const p = predictRace({
      model,
      course: { distanceM: 42195, elevationGainM: 0, elevationLossM: 0, technicality: 1, expectedTempC: 13 },
      raceDayTsb: 12,
      skipLimiters: true,
    });
    const min = p.predictedTimeS / 60;
    expect(min).toBeGreaterThan(165); // 2 h 45
    expect(min).toBeLessThan(215);    // 3 h 35
  });
});

describe("Format à boucle répétée — l'enregistrement", () => {
  const lap: LapFormat = { lengthM: 6706, intervalS: 3600, elevationGainM: null, elevationLossM: null };

  it('lit une ambition en heures comme un nombre de boucles', () => {
    expect(lapsForHours(lap.intervalS, 10)).toBe(10);
    expect(lapsForHours(1800, 10)).toBe(20);
    expect(lapsForHours(lap.intervalS, 0.5)).toBe(1); // jamais moins d'une boucle
  });

  it("fait de la distance une conséquence de l'ambition, jamais une donnée", () => {
    const dix = courseFromLapFormat(lap, 10);
    const vingt = courseFromLapFormat(lap, 20);
    expect(dix.distanceM).toBe(67060);
    expect(vingt.distanceM).toBe(134120);
    expect(isLapCourse(dix)).toBe(true);
    expect(dix.lap).toEqual(lap);
  });

  it('porte le dénivelé inconnu au lieu de le combler', () => {
    const inconnu = courseFromLapFormat(lap, 10);
    // Le zéro existe pour l'arithmétique ; l'étiquette dit qu'il n'est pas un plat.
    expect(inconnu.elevationGainM).toBe(0);
    expect(inconnu.unknowns).toContain('elevation');
    expect(describeLapFormat(lap)).toContain('inconnu');

    const connu = courseFromLapFormat({ ...lap, elevationGainM: 120, elevationLossM: 120 }, 10);
    expect(connu.elevationGainM).toBe(1200);
    expect(connu.unknowns ?? []).not.toContain('elevation');
  });
});

describe('Format à boucle répétée — la prédiction', () => {
  const lap: LapFormat = { lengthM: 6706, intervalS: 3600, elevationGainM: null, elevationLossM: null };
  const course = courseFromLapFormat(lap, 10, { technicality: 3 }, ['technicality']);
  // L'ancre de laboratoire ne mesure pas la durabilité : on lui donne celle que
  // le terrain a relevée, puisque c'est elle qui décide de ce format.
  const terrain = { ...model, durabilityPctPerHour: 4.4, durabilityVertRateMh: 316 };
  const base = predictLapRace({ model: terrain, course, targetLaps: 10, raceDayTsb: 10 });

  it('refuse de répondre à un parcours qui ne décrit pas de boucle', () => {
    expect(() =>
      predictLapRace({
        model: terrain,
        course: { distanceM: 67060, elevationGainM: 0, elevationLossM: 0, technicality: 3 },
        targetLaps: 10,
      }),
    ).toThrow();
  });

  it("allonge la boucle tour après tour et réduit le repos d'autant", () => {
    for (let i = 1; i < base.laps.length; i++) {
      expect(base.laps[i]!.lapTimeS).toBeGreaterThan(base.laps[i - 1]!.lapTimeS);
      expect(base.laps[i]!.restS).toBeLessThan(base.laps[i - 1]!.restS);
    }
    // Le repos est exactement ce que la cloche laisse.
    for (const l of base.laps) {
      expect(l.lapTimeS + l.restS).toBeCloseTo(lap.intervalS, 0);
    }
  });

  it('répond par des boucles, pas par un temps de parcours', () => {
    expect(base.distanceM).toBe(67060);
    expect(base.targetLaps).toBe(10);
    expect(base.runningTimeS).toBeLessThan(10 * lap.intervalS);
    expect(base.totalRestS).toBeCloseTo(10 * lap.intervalS - base.runningTimeS, -1);
  });

  it('situe la boucle où le temps de boucle atteint la cloche', () => {
    expect(base.horizonReason).toBe('cutoff');
    expect(base.cutoffLap).not.toBeNull();
    expect(base.sustainableLaps).toBe(base.cutoffLap! - 1);
    expect(base.laps[base.cutoffLap! - 1]!.lapTimeS).toBeGreaterThanOrEqual(lap.intervalS);
    expect(base.laps[base.cutoffLap! - 2]!.lapTimeS).toBeLessThan(lap.intervalS);
  });

  it('fait tenir moins de boucles à durabilité plus faible, vitesse critique égale', () => {
    const fragile = predictLapRace({
      model: { ...terrain, durabilityPctPerHour: terrain.durabilityPctPerHour + 2.6 },
      course,
      targetLaps: 10,
      raceDayTsb: 10,
      skipCounterfactuals: true,
    });
    expect(fragile.sustainableLaps).toBeLessThan(base.sustainableLaps);
    // La première boucle bouge peu : c'est la dérive, pas le niveau, qui coûte.
    expect(Math.abs(fragile.laps[0]!.lapTimeS - base.laps[0]!.lapTimeS)).toBeLessThan(
      fragile.laps[9]!.lapTimeS - base.laps[9]!.lapTimeS,
    );
  });

  it("classe les facteurs limitants dans l'ordre où ils arrivent", () => {
    expect(base.limiters.length).toBeGreaterThan(0);
    for (let i = 1; i < base.limiters.length; i++) {
      expect(base.limiters[i]!.fromLap).toBeGreaterThanOrEqual(base.limiters[i - 1]!.fromLap);
    }
    // Sur ce format, la durabilité est un facteur — et elle a un prix chiffré.
    const durabilite = base.limiters.find((l) => l.factor.startsWith('Durabilité'));
    expect(durabilite).toBeDefined();
    expect(durabilite!.costAtTargetS).toBeGreaterThan(60);
  });

  it('nomme ce qui manque et chiffre ce que le manque coûte', () => {
    const vert = base.unknowns.find((u) => u.field.includes('Dénivelé'));
    expect(vert).toBeDefined();
    expect(vert!.assumed).toContain('plate');

    const avecVert = predictLapRace({
      model: terrain,
      course: courseFromLapFormat({ ...lap, elevationGainM: 100, elevationLossM: 100 }, 10, {
        technicality: 3,
      }),
      targetLaps: 10,
      raceDayTsb: 10,
      skipCounterfactuals: true,
    });
    // La sensibilité annoncée est celle qu'on mesure en renseignant le tracé.
    expect(avecVert.laps[9]!.lapTimeS).toBeGreaterThan(base.laps[9]!.lapTimeS + 30);
    expect(avecVert.unknowns).toEqual([]);
  });

  it("ne nomme pas de cloche manquée au-delà de sa calibration", () => {
    // Durabilité de référence et ancre de laboratoire : la cloche ne mord
    // qu'après l'horizon de projection. La réponse doit le dire au lieu
    // d'extrapoler une courbe calibrée sur dix heures jusqu'à trente.
    const solide = predictLapRace({
      model: { ...model, durabilityPctPerHour: 3 },
      course,
      targetLaps: 10,
      raceDayTsb: 10,
      skipCounterfactuals: true,
    });
    expect(solide.horizonReason).toBe('horizon');
    expect(solide.cutoffLap).toBeNull();
    expect(solide.laps.length).toBe(solide.sustainableLaps);
  });

  it('arrête la projection quand la durabilité touche sa borne', () => {
    // Une décroissance arrivée à son plancher n'est plus une mesure : rien de
    // ce qui suit ne s'affiche, et la boucle de sortie reste inconnue.
    const usé = predictLapRace({
      model: { ...model, durabilityPctPerHour: 5.7 },
      course,
      targetLaps: 10,
      raceDayTsb: 10,
      skipCounterfactuals: true,
    });
    expect(usé.horizonReason).toBe('durability-clamp');
    expect(usé.cutoffLap).toBeNull();
    for (const l of usé.laps) expect(l.lapTimeS).toBeLessThan(lap.intervalS);
  });

  it("ne chiffre pas une ambition que la projection ne vouche pas", () => {
    const trop = predictLapRace({
      model: { ...model, durabilityPctPerHour: 5.7 },
      course: courseFromLapFormat(lap, 40, { technicality: 3 }),
      targetLaps: 40,
      raceDayTsb: 10,
      skipCounterfactuals: true,
    });
    expect(trop.targetProbability).toBeNull();
    expect(trop.laps.length).toBeLessThan(40);
  });
});

describe('Profil athlète', () => {
  it('encode fidèlement le test du 24/07/2025', () => {
    expect(PIERRE.stravaAthleteId).toBe(95596908);
    expect(LAB_TEST_2025_07_24.vo2maxRel).toBe(64.6);
    expect(msToKmh(LAB_TEST_2025_07_24.vmaMs)).toBeCloseTo(20, 6);
    expect(LAB_TEST_2025_07_24.cadenceMeanSpm).toBe(168);
  });
});

describe('Rattachement d\'une activité à la séance prescrite', () => {
  const session = (over: Partial<PlannedSession> = {}): PlannedSession => ({
    id: 'ses_recup', athleteId: 'pierre', date: '2026-09-02', type: 'recovery',
    title: 'Décrassage 40 min', intent: 'Faciliter le retour veineux.', blocks: [],
    plannedLoad: 7, plannedMechanicalLoad: 2, plannedDurationS: 2400,
    priority: 'optional', status: 'planned', ...over,
  });
  // La sortie réellement courue le 02/09 : 103 min, 134 points de charge.
  const sortie = (over: Partial<RealizedEffort> = {}): RealizedEffort => ({
    activityId: 'strava-20007158487', sportType: 'TrailRun', durationS: 6201, load: 134, ...over,
  });

  const longue = session({
    id: 'ses_longue', type: 'long_run', title: 'Sortie longue 1.6 h',
    plannedLoad: 92, plannedDurationS: 5904, priority: 'key',
  });

  it('retient la séance la plus proche de ce qui a été fait, pas la première du jour', () => {
    expect(matchPlannedSession([session(), longue], sortie())?.id).toBe('ses_longue');
    // L'ordre d'entrée en base ne doit rien y changer.
    expect(matchPlannedSession([longue, session()], sortie())?.id).toBe('ses_longue');
    // Et un décrassage réellement couru reste rattaché au décrassage.
    expect(matchPlannedSession([session(), longue], sortie({ durationS: 2300, load: 8 }))?.id).toBe('ses_recup');
  });

  it('reprend une séance passée en « manquée » quand l\'activité arrive après les règles', () => {
    const cotes = session({
      id: 'ses_cotes', type: 'hill_repeats', title: 'Côtes — 8 × 90 s à 10 %',
      plannedLoad: 37, plannedDurationS: 3360, priority: 'key', status: 'missed',
      rationale: 'Séance non réalisée : statut passé à « manquée ».',
    });
    const courue = sortie({ activityId: 'strava-20007144020', durationS: 1333, load: 35 });
    expect(matchPlannedSession([cotes], courue)?.id).toBe('ses_cotes');
  });

  it('refuse une séance dont la place est tenue par une autre activité', () => {
    const prise = session({ status: 'completed', completedActivityId: 'strava-autre' });
    expect(matchPlannedSession([prise], sortie())).toBeNull();
    // La ré-analyse de la même activité, elle, retrouve son rattachement.
    expect(matchPlannedSession([prise], sortie({ activityId: 'strava-autre' }))?.id).toBe('ses_recup');
  });

  it('refuse une séance annulée ou déplacée', () => {
    expect(matchPlannedSession([session({ status: 'cancelled' })], sortie())).toBeNull();
    expect(matchPlannedSession([session({ status: 'moved' })], sortie())).toBeNull();
  });

  it('refuse une séance retirée par une absence déclarée', () => {
    // Courir pendant une coupure annoncée n'honore aucune prescription : ce
    // jour-là, le plan ne demandait plus rien.
    expect(matchPlannedSession([session({ status: 'withdrawn' })], sortie())).toBeNull();
  });

  it('refuse de croiser les disciplines', () => {
    expect(matchPlannedSession([session()], sortie({ sportType: 'Swim' }))).toBeNull();
    expect(matchPlannedSession([session({ type: 'strength' })], sortie())).toBeNull();
    expect(matchPlannedSession([session({ type: 'cross_training' })], sortie({ sportType: 'Ride' }))?.id)
      .toBe('ses_recup');
  });

  it('ne rattache rien quand le jour ne prescrit rien', () => {
    expect(matchPlannedSession([], sortie())).toBeNull();
  });
});

describe('Séance réalisée ou remplacée', () => {
  it('refuse d\'enregistrer une conformité quand l\'écart est matériel', () => {
    // 02/09 : 103 min et 134 points là où 40 min et 7 points étaient prescrits.
    expect(sessionOutcome({ loadPct: 1814, durationPct: 158, intensityPct: null })).toBe('replaced');
    // 01/09 : charge conforme par coïncidence, mais 22 min pour 56 min de côtes.
    expect(sessionOutcome({ loadPct: -5.4, durationPct: -60.3, intensityPct: null })).toBe('replaced');
  });

  it('laisse « réalisée » une séance simplement mal exécutée', () => {
    expect(sessionOutcome({ loadPct: 22, durationPct: 12, intensityPct: 6 })).toBe('fulfilled');
    expect(sessionOutcome({ loadPct: -35, durationPct: -18, intensityPct: null })).toBe('fulfilled');
  });

  it('compte le stimulus manqué comme une substitution, à volume tenu', () => {
    expect(sessionOutcome({ loadPct: 5, durationPct: 3, intensityPct: -20 })).toBe('replaced');
    expect(sessionOutcome({ loadPct: 5, durationPct: 3, intensityPct: -10 })).toBe('fulfilled');
  });
});

describe('Provenance de la disponibilité', () => {
  const pmc = (over: Partial<PmcSeries> = {}): PmcSeries => ({
    metabolic: [{ date: '2026-09-02', ctl: 50, atl: 50, tsb: 0, load: 50 }],
    mechanical: [{ date: '2026-09-02', ctl: 30, atl: 30, tsb: 0, load: 30 }],
    acwr: [{ date: '2026-09-02', value: 1.0 }],
    mechanicalAcwr: [], monotony: [], strain: [], rampRate: [],
    ...over,
  });
  const at = (checkIns: DailyCheckIn[] = [], series = pmc()) =>
    computeReadiness({ date: '2026-09-02', pmc: series, checkIns });
  const checkIn = (over: Partial<DailyCheckIn> = {}): DailyCheckIn => ({
    date: '2026-09-02', athleteId: 'pierre', ...over,
  });
  const full = {
    fatigue: 2, sleepHours: 7.5, sleepQuality: 4, soreness: 2, stress: 2, motivation: 4,
  } as const;

  it('retire du calcul ce qui n\'a pas de source, au lieu de l\'y supposer', () => {
    const r = at();
    expect(r.sources.subjective).toBe('default');
    expect(r.sources.autonomic).toBe('default');
    expect(r.sources.tsbMetabolic).toBe('load');
    // Ressenti et système autonome sont muets : leurs 0,52 vont aux deux
    // composantes de charge, au prorata de 0,26 et 0,22.
    expect(r.weights.subjective).toBe(0);
    expect(r.weights.autonomic).toBe(0);
    expect(r.weights.tsbMetabolic).toBeCloseTo(0.54, 6);
    expect(r.weights.tsbMechanical).toBeCloseTo(0.46, 6);
    // Plus rien d'inventé n'entre dans le score : il est étroit, pas supposé.
    expect(r.assumedShare).toBe(0);
  });

  it('rend son poids nominal à chaque composante quand tout est relevé', () => {
    const r = at([checkIn({ ...full, hrvRmssd: 62 })]);
    expect(r.sources.subjective).toBe('declared');
    expect(r.sources.autonomic).toBe('hrv');
    expect(r.weights).toEqual({
      tsbMetabolic: 0.26, tsbMechanical: 0.22, subjective: 0.32, autonomic: 0.2,
    });
    expect(r.assumedShare).toBe(0);
  });

  it('fait toujours 100 % des poids affichés', () => {
    for (const c of [[], [checkIn({ fatigue: 2 })], [checkIn({ ...full })], [checkIn({ hrvRmssd: 55 })]]) {
      const w = at(c).weights;
      const sum = w.tsbMetabolic + w.tsbMechanical + w.subjective + w.autonomic;
      expect(sum).toBeCloseTo(1, 9);
    }
  });

  it('accepte une réponse partielle sans en supposer le reste', () => {
    // Seul le sommeil est déclaré : les cinq autres questions ne pèsent rien.
    // Le ressenti garde sa pleine voix de composante, et récupère même une part
    // du système autonome, muet lui aussi — 0,32 sur 0,80 de poids sourcé.
    const r = at([checkIn({ sleepHours: 8.5 })]);
    expect(r.sources.subjective).toBe('partial');
    expect(r.weights.subjective).toBeCloseTo(0.4, 6);
    expect(r.assumedShare).toBe(0);
    // 8 h 30 seules valent bien mieux que la valeur neutre d'avant.
    expect(r.components.subjective).toBe(100);
  });

  it('distingue le rMSSD de la FC de repos, et les deux d\'une absence', () => {
    expect(at([checkIn({ restingHr: 46 })]).sources.autonomic).toBe('resting-hr');
    expect(at([checkIn({ hrvRmssd: 55, restingHr: 46 })]).sources.autonomic).toBe('hrv');
    expect(at([checkIn({ motivation: 5 })]).sources.autonomic).toBe('default');
  });

  it('ne compte pour relevé qu\'un point du jour daté du jour', () => {
    const r = at([checkIn({ date: '2026-09-01', ...full })]);
    expect(r.sources.subjective).toBe('default');
    expect(r.weights.subjective).toBe(0);
  });

  it('avoue un score entièrement supposé quand la charge manque aussi', () => {
    const r = at([], pmc({ metabolic: [], mechanical: [], acwr: [] }));
    expect(r.sources.tsbMetabolic).toBe('default');
    expect(r.sources.tsbMechanical).toBe('default');
    // Rien à redistribuer : on garde les poids nominaux et on le dit.
    expect(r.weights).toEqual({
      tsbMetabolic: 0.26, tsbMechanical: 0.22, subjective: 0.32, autonomic: 0.2,
    });
    expect(r.assumedShare).toBe(1);
  });

  it('ne laisse pas un signal absent diluer un signal présent', () => {
    // Une journée franchement mauvaise au ressenti, sans HRV. L'ancienne règle
    // noyait ce signal sous un cinquième de valeur neutre.
    const bad = at([checkIn({ fatigue: 5, sleepHours: 5, sleepQuality: 1, soreness: 5, stress: 5, motivation: 1 })]);
    const good = at([checkIn({ fatigue: 1, sleepHours: 9.5, sleepQuality: 5, soreness: 1, stress: 1, motivation: 5 })]);
    expect(bad.components.subjective).toBe(0);
    expect(good.components.subjective).toBe(100);
    expect(bad.weights.subjective).toBeCloseTo(0.4, 6);
    expect(good.score - bad.score).toBe(40);
  });
});

describe('Fatigue perçue', () => {
  const pmc = (): PmcSeries => ({
    metabolic: [{ date: '2026-09-02', ctl: 50, atl: 50, tsb: 0, load: 50 }],
    mechanical: [{ date: '2026-09-02', ctl: 30, atl: 30, tsb: 0, load: 30 }],
    acwr: [{ date: '2026-09-02', value: 1.0 }],
    mechanicalAcwr: [], monotony: [], strain: [], rampRate: [],
  });
  const at = (over: Partial<DailyCheckIn>) =>
    computeReadiness({
      date: '2026-09-02',
      pmc: pmc(),
      checkIns: [{ date: '2026-09-02', athleteId: 'pierre', ...over }],
    });

  it('entre dans le score, et plus lourd que les autres items', () => {
    expect(at({ fatigue: 5 }).components.subjective).toBe(0);
    expect(at({ fatigue: 1 }).components.subjective).toBe(100);
    // À réponses complètes par ailleurs, un cran de fatigue pèse plus qu'un
    // cran de stress : c'est l'item le plus sensible de l'échelle de Hooper.
    const base = { fatigue: 3, sleepHours: 7.5, sleepQuality: 3, soreness: 3, stress: 3, motivation: 3 };
    const tired = at({ ...base, fatigue: 5 }).components.subjective;
    const stressed = at({ ...base, stress: 5 }).components.subjective;
    expect(tired).toBeLessThan(stressed);
  });

  it('se dit dans la recommandation quand elle est haute', () => {
    expect(at({ fatigue: 4 }).recommendation).toContain('fatigue perçue élevée');
    expect(at({ fatigue: 2 }).recommendation).not.toContain('fatigue perçue élevée');
  });
});

describe('Ligne de base du ressenti', () => {
  const pmc = (): PmcSeries => ({
    metabolic: [{ date: '2026-09-30', ctl: 50, atl: 50, tsb: 0, load: 50 }],
    mechanical: [{ date: '2026-09-30', ctl: 30, atl: 30, tsb: 0, load: 30 }],
    acwr: [{ date: '2026-09-30', value: 1.0 }],
    mechanicalAcwr: [], monotony: [], strain: [], rampRate: [],
  });
  /** `n` jours d'historique à `sleepHours` heures, puis le jour évalué. */
  const withHistory = (n: number, past: number, todayHours: number): DailyCheckIn[] => {
    const days: DailyCheckIn[] = [];
    for (let i = n; i >= 1; i--) {
      const d = new Date(Date.UTC(2026, 8, 30) - i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date: d, athleteId: 'pierre', sleepHours: past });
    }
    days.push({ date: '2026-09-30', athleteId: 'pierre', sleepHours: todayHours });
    return days;
  };
  const subjective = (n: number, past: number, today: number) =>
    computeReadiness({ date: '2026-09-30', pmc: pmc(), checkIns: withHistory(n, past, today) })
      .components.subjective;

  it('reste sur l\'échelle absolue tant que l\'historique est trop court', () => {
    // 6 h, sous les 7 déclarations qu'exige une moyenne : (6-5)/3 → 33.
    expect(subjective(6, 6, 6)).toBe(33);
    expect(computeReadiness({
      date: '2026-09-30', pmc: pmc(), checkIns: withHistory(6, 6, 6),
    }).sources.subjective).toBe('partial');
  });

  it('cesse de compter un déficit chez qui dort court depuis toujours', () => {
    // Même nuit de 6 h, mais c'est sa norme depuis un mois : plus un déficit.
    expect(subjective(28, 6, 6)).toBe(50);
    // Et la même nuit chez qui dort huit heures d'habitude devient un manque.
    expect(subjective(28, 8, 6)).toBeLessThan(20);
  });

  it('bascule progressivement, sans qu\'un jour fasse tout changer', () => {
    const seq = [7, 10, 14, 21, 28].map((n) => subjective(n, 8, 6));
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeLessThan(seq[i - 1]!);
    // À 7 déclarations la ligne de base ne pèse encore rien : échelle absolue.
    expect(seq[0]).toBe(33);
  });

  it('le dit dans la provenance quand toutes les réponses valent contre la norme', () => {
    const history: DailyCheckIn[] = [];
    for (let i = 28; i >= 1; i--) {
      const d = new Date(Date.UTC(2026, 8, 30) - i * 86_400_000).toISOString().slice(0, 10);
      history.push({
        date: d, athleteId: 'pierre',
        fatigue: 3, sleepHours: 7, sleepQuality: 3, soreness: 3, stress: 3, motivation: 3,
      });
    }
    const today: DailyCheckIn = {
      date: '2026-09-30', athleteId: 'pierre',
      fatigue: 3, sleepHours: 7, sleepQuality: 3, soreness: 3, stress: 3, motivation: 3,
    };
    const r = computeReadiness({ date: '2026-09-30', pmc: pmc(), checkIns: [...history, today] });
    expect(r.sources.subjective).toBe('baseline');
    // Une journée en tous points ordinaire pour lui : 50, ni bonne ni mauvaise.
    expect(r.components.subjective).toBe(50);
  });
});

describe('Conseil du jour', () => {
  /** Une journée dont seule la fraîcheur varie : elle seule fixe le verdict. */
  const pmc = (tsb: number): PmcSeries => ({
    metabolic: [{ date: '2026-09-12', ctl: 50, atl: 50 - tsb, tsb, load: 0 }],
    mechanical: [{ date: '2026-09-12', ctl: 30, atl: 30 - tsb, tsb, load: 0 }],
    acwr: [{ date: '2026-09-12', value: 1.0 }],
    mechanicalAcwr: [], monotony: [], strain: [], rampRate: [],
  });
  const at = (day?: ReadinessDay, tsb = 0) =>
    computeReadiness({ date: '2026-09-12', pmc: pmc(tsb), checkIns: [], day });
  const advice = (day?: ReadinessDay, tsb = 0) => at(day, tsb).recommendation;

  it('tient les trois bandes de verdict là où les tests suivants les attendent', () => {
    expect(at(undefined, 20).verdict).toBe('green');
    expect(at(undefined, 0).verdict).toBe('amber');
    expect(at(undefined, -30).verdict).toBe('red');
  });

  it('ne conseille aucune séance le jour où il n\'y en a pas', () => {
    const a = advice({ session: 'none' });
    expect(a).not.toContain('Garde la séance');
    expect(a).not.toContain('la séance prévue');
    expect(a).toContain('Rien n\'est prévu aujourd\'hui');
  });

  it('dit, sous une absence déclarée, d\'où vient la fraîcheur qu\'on lit', () => {
    // Le 12/09 : l'écran titre « Rien aujourd'hui », le tableau de bord affiche
    // « Frais, prêt à performer », et la carte conseillait de garder une séance
    // qui n'existait pas. Les deux surfaces se rejoignent ici.
    const a = advice({ session: 'none', absence: 'chosen' });
    expect(a).toContain('absence déclarée couvre la journée');
    expect(a).toContain('vient de l\'arrêt, pas de la forme');
    expect(a).not.toContain('séance');
  });

  it('avoue ce qu\'il ne regarde pas quand l\'absence est une maladie ou une blessure', () => {
    expect(advice({ session: 'none', absence: 'injury' })).toContain('ni ta guérison ni ta douleur');
    expect(advice({ session: 'none', absence: 'chosen' })).not.toContain('guérison');
  });

  it('ne laisse pas un feu vert couvrir une reprise', () => {
    // Onze jours sans impact : la fraîcheur est au plus haut *parce que* rien
    // n'a été couru. C'est la configuration où le verdict seul trompe le plus.
    const back = advice({ session: 'work', daysWithoutImpact: 11 }, 20);
    expect(back).toContain('11 jours sans impact');
    expect(back).toContain('parce que tu as coupé');
    // Six jours ne sont pas une reprise : la séance se conseille normalement.
    expect(advice({ session: 'work', daysWithoutImpact: 6 }, 20)).toContain('exécutée telle quelle');
  });

  it('distingue un repos prescrit et une séance déjà faite d\'une séance à faire', () => {
    expect(advice({ session: 'rest' })).toContain('Repos prescrit');
    expect(advice({ session: 'done' })).toContain('est faite');
    expect(advice({ session: 'work' })).toContain('Garde la séance');
  });

  it('ne suppose aucune séance quand personne n\'a dit ce que la journée tient', () => {
    for (const tsb of [20, 0, -30]) expect(advice(undefined, tsb)).not.toContain('séance');
  });

  it('garde ses raisons dans toutes les situations', () => {
    // Le verdict et la situation sont deux moitiés indépendantes : ce que le
    // corps dit ne disparaît pas parce que la journée ne demande rien.
    for (const day of [
      { session: 'work' }, { session: 'rest' }, { session: 'none' },
      { session: 'done' }, { session: 'none', absence: 'chosen' },
    ] as ReadinessDay[]) {
      expect(advice(day, -30)).toContain('fatigue musculaire élevée');
    }
  });
});
