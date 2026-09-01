import { describe, expect, it } from 'vitest';
import { LAB_TEST_2025_07_24, PIERRE } from '@cairn/core';
import {
  buildZones, computePmc, densifyDailyLoads, fitCriticalSpeed, formatClock,
  fractionalUtilization, gradeAdjustedSpeed, kmhToMs, locomotionCost, meanMaximal,
  modelFromLabOnly, msToKmh, normalizeStreams, predictRace, runningCost,
  runningTss, targetRaceDayTsb, vam, walkingCost, wPrimeBalance,
  polarizationIndex, mechanicalLoad, heatStressFactor, altitudeVo2Factor,
  durabilityAdjustedCs, detectIntervals, assessSeries, computeAcwr,
  descentSpeedCeiling, walkRunTransitionSpeed, speedForMetabolicPower,
  technicalityCostMultiplier,
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
  it('dégrade la vitesse critique avec le temps et le dénivelé', () => {
    const cs = 4.6;
    const m = { pctPerHour: 3, pctPer1000mVert: 4 };
    expect(durabilityAdjustedCs(cs, 0, 0, m)).toBeCloseTo(cs, 5);
    const after3h = durabilityAdjustedCs(cs, 3 * 3600, 0, m);
    const after3hVert = durabilityAdjustedCs(cs, 3 * 3600, 1500, m);
    expect(after3h).toBeLessThan(cs);
    expect(after3hVert).toBeLessThan(after3h);
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

describe('Profil athlète', () => {
  it('encode fidèlement le test du 24/07/2025', () => {
    expect(PIERRE.stravaAthleteId).toBe(95596908);
    expect(LAB_TEST_2025_07_24.vo2maxRel).toBe(64.6);
    expect(msToKmh(LAB_TEST_2025_07_24.vmaMs)).toBeCloseTo(20, 6);
    expect(LAB_TEST_2025_07_24.cadenceMeanSpm).toBe(168);
  });
});
