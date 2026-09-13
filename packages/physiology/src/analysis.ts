import type {
  Activity, ActivityAnalysis, ActivityStreams, AnalysisFlag,
  PhysiologyModel, PlannedSession, SessionCompliance,
} from '@cairn/core';
import { analyzeDurability, type DurabilitySample } from './durability.js';
import { cleanHeartRate, computeDecoupling, interpretDecoupling } from './decoupling.js';
import { environmentalFactor } from './environment.js';
import { elevationChange, gradeAdjustedSpeed } from './grade.js';
import { assessSeries, detectIntervals, inferSessionShape } from './intervals.js';
import { computeTrainingLoad, energyExpenditure, fuelingTargets, type LoadSample } from './load.js';
import { companionAtMeanMaximal, meanMaximal } from './mmp.js';
import { cumulativeVertical } from './streams.js';
import { buildZones, computeZoneDistribution } from './zones.js';
import {
  VERTICAL_CURVE_DURATIONS, descentCurve, gradeProfile, vamCurve, verticalityIndex,
} from './vertical.js';
import { wPrimeBalance } from './criticalSpeed.js';
import { matchPlannedSession, sessionOutcome } from './sessionMatch.js';
import { formatDuration, mean, movingAverage } from './units.js';

/**
 * Orchestrateur d'analyse.
 *
 * Point d'entrée unique : une activité + ses flux + le modèle physiologique
 * courant produisent l'objet d'analyse complet consommé par l'API, le front,
 * le planificateur et le LLM. Tout ce qui suit est déterministe et testable —
 * le modèle de langage n'intervient qu'ensuite, pour *interpréter* ces nombres,
 * jamais pour les produire.
 */

export interface AnalyzeOptions {
  sex?: 'M' | 'F';
  gpsQuality?: 'good' | 'poor' | 'none';
  /**
   * Séances prescrites le jour de l'activité. C'est le rattachement, et non la
   * date, qui décide laquelle — au plus une — cette activité concerne.
   */
  plannedSessions?: PlannedSession[];
  hotSessionsLast14Days?: number;
}

export function analyzeActivity(
  activity: Activity,
  streams: ActivityStreams,
  model: PhysiologyModel,
  opts: AnalyzeOptions = {},
): ActivityAnalysis {
  const n = streams.time.length;
  const zones = buildZones(model);

  const hr = streams.heartrate
    ? cleanHeartRate(streams.heartrate, model.hrMax)
    : new Array<number | null>(n).fill(null);

  // On ne conserve que les échantillons en mouvement : une pause de 8 min à un
  // ravitaillement ne doit ni diluer les moyennes ni compter comme de la zone 1.
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (streams.moving ? streams.moving[i] : (streams.velocity[i] ?? 0) > 0.5) idx.push(i);
  }

  const loadSamples: LoadSample[] = idx.map((i) => ({
    dt: 1,
    speedMs: streams.velocity[i] ?? 0,
    grade: streams.grade[i] ?? 0,
    hr: hr[i] ?? null,
  }));

  const load = computeTrainingLoad(loadSamples, model, {
    sex: opts.sex ?? 'M',
    gpsQuality: opts.gpsQuality ?? 'good',
    rpe: activity.rpe,
  });

  // ── Zones ─────────────────────────────────────────────────────────────────
  const zoneDist = computeZoneDistribution(
    zones,
    loadSamples.map((s) => ({
      gradedSpeedMs: gradeAdjustedSpeed(s.speedMs, s.grade),
      hr: s.hr,
      dt: s.dt,
    })),
    model,
  );

  // ── Courbes maximales ─────────────────────────────────────────────────────
  const gapSeries = idx.map((i) => gradeAdjustedSpeed(streams.velocity[i] ?? 0, streams.grade[i] ?? 0));
  const durationS = idx.length;
  const relevantDurations = [5, 10, 20, 30, 60, 120, 180, 300, 420, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200]
    .filter((d) => d <= durationS);
  const mms = meanMaximal(gapSeries, relevantDurations);
  const roundedMms: Record<string, number> = {};
  for (const [k, v] of Object.entries(mms)) roundedMms[k] = Math.round(v * 1000) / 1000;

  // Contrepartie cardiaque de chaque point : c'est elle qui dira plus tard si ce
  // point atteste d'une limite ou d'une aisance.
  const hrAtMms: Record<string, number> = {};
  for (const [k, v] of Object.entries(companionAtMeanMaximal(gapSeries, idx.map((i) => hr[i] ?? null), relevantDurations))) {
    hrAtMms[k] = Math.round(v * 10) / 10;
  }

  const verticalSamples = idx.map((i) => ({
    dt: 1,
    speedMs: streams.velocity[i] ?? 0,
    grade: streams.grade[i] ?? 0,
    hr: hr[i] ?? null,
  }));
  // Montée et descente, sur les mêmes durées : ce sont les deux courbes que les
  // séances ne peuvent pas dépasser.
  const verticalDurations = VERTICAL_CURVE_DURATIONS.filter((d) => d <= durationS);
  const vamMms = vamCurve(verticalSamples, verticalDurations);
  const descentMms = descentCurve(verticalSamples, verticalDurations);

  // ── Découplage ────────────────────────────────────────────────────────────
  const decoupling = computeDecoupling(
    idx.map((i) => {
      const h = hr[i] ?? null;
      return {
        t: streams.time[i] ?? 0,
        speedMs: streams.velocity[i] ?? 0,
        grade: streams.grade[i] ?? 0,
        hr: h,
        // Fenêtre aérobie : entre la récupération et le seuil 2.
        zoneOk: h != null && h > model.vt1.hr - 22 && h < model.vt2.hr + 2,
      };
    }),
  );

  // ── Durabilité ────────────────────────────────────────────────────────────
  const cumVert = cumulativeVertical(streams);
  const durabilitySamples: DurabilitySample[] = idx.map((i) => ({
    t: streams.time[i] ?? 0,
    dt: 1,
    speedMs: streams.velocity[i] ?? 0,
    grade: streams.grade[i] ?? 0,
    hr: hr[i] ?? null,
    cumulativeVertM: cumVert[i] ?? 0,
  }));
  const durability = analyzeDurability(durabilitySamples, {
    hrMin: model.vt1.hr - 25,
    hrMax: model.vt2.hr + 3,
  });

  // ── Blocs d'effort ────────────────────────────────────────────────────────
  const intervals = detectIntervals(
    idx.map((i) => ({
      t: streams.time[i] ?? 0,
      speedMs: streams.velocity[i] ?? 0,
      grade: streams.grade[i] ?? 0,
      hr: hr[i] ?? null,
      cadence: streams.cadence?.[i] ?? null,
    })),
    zones,
  );

  // ── W'bal ─────────────────────────────────────────────────────────────────
  const wbal = wPrimeBalance(gapSeries, model.criticalSpeedMs, model.dPrimeM);
  const wPrimeMin = wbal.length ? Math.round(Math.min(...wbal)) : null;

  // ── Environnement ─────────────────────────────────────────────────────────
  const temps = streams.temperature?.filter((t): t is number => t != null) ?? [];
  const avgTemp = temps.length ? (mean(temps) as number) : (activity.averageTempC ?? null);
  const alts = streams.altitude.filter((a) => Number.isFinite(a) && a !== 0);
  const avgAlt = alts.length ? (mean(alts) as number) : null;
  const env = environmentalFactor({
    tempC: avgTemp,
    altitudeM: avgAlt,
    durationS,
    vo2maxRel: model.vo2maxRel,
    hotSessionsLast14Days: opts.hotSessionsLast14Days ?? 0,
  });

  // ── Énergie ───────────────────────────────────────────────────────────────
  const energy = energyExpenditure(loadSamples, model.bodyMassKg);
  const fuel = fuelingTargets(durationS, load.intensityFactor, avgTemp);

  const elevation = elevationChange(streams.altitude);

  const analysis: ActivityAnalysis = {
    activityId: activity.id,
    computedAt: new Date().toISOString(),
    load,
    zones: zoneDist,
    decoupling,
    meanMaximalSpeed: roundedMms,
    meanMaximalSpeedHr: hrAtMms,
    meanMaximalVam: vamMms,
    meanMaximalDescentVam: descentMms,
    gradeProfile: gradeProfile(verticalSamples),
    intervals,
    wPrimeBalanceMinM: wPrimeMin,
    durabilitySignal: {
      efDeclinePctPer1000mVert: durability.pctPer1000mVert,
      efDeclinePctPerHour: durability.pctPerHour,
      sampleQuality: durability.sampleQuality,
    },
    energy: {
      kcal: Math.round(energy.kcal),
      carbTargetGPerHour: fuel.carbGPerHour,
      fluidTargetMlPerHour: fuel.fluidMlPerHour,
    },
    environment: {
      avgTempC: avgTemp != null ? Math.round(avgTemp * 10) / 10 : null,
      heatStressFactor: env.heat,
      avgAltitudeM: avgAlt != null ? Math.round(avgAlt) : null,
      altitudeFactor: env.altitude,
    },
    flags: [],
  };

  analysis.flags = buildFlags(activity, analysis, model, {
    elevation,
    durationS,
    intervals,
    avgCadence: mean(streams.cadence ?? []) ?? null,
  });

  const match = matchPlannedSession(opts.plannedSessions ?? [], {
    activityId: activity.id,
    sportType: activity.sportType,
    durationS,
    load: load.metabolic,
  });
  if (match) analysis.compliance = assessCompliance(match, analysis, durationS);

  return analysis;
}

/** Génère les signaux d'alerte automatiques. */
function buildFlags(
  activity: Activity,
  analysis: ActivityAnalysis,
  model: PhysiologyModel,
  ctx: {
    elevation: { gainM: number; lossM: number };
    durationS: number;
    intervals: ActivityAnalysis['intervals'];
    avgCadence: number | null;
  },
): AnalysisFlag[] {
  const flags: AnalysisFlag[] = [];

  // Dérive cardiaque
  if (analysis.decoupling.valid && analysis.decoupling.pctDrift != null) {
    const verdict = interpretDecoupling(analysis.decoupling.pctDrift, ctx.durationS);
    if (verdict.verdict === 'poor' || verdict.verdict === 'acceptable') {
      flags.push({
        code: 'aerobic_decoupling',
        severity: verdict.verdict === 'poor' ? 'warn' : 'watch',
        message: verdict.message,
        evidence: {
          pctDrift: analysis.decoupling.pctDrift,
          efFirstHalf: analysis.decoupling.efFirstHalf,
          efSecondHalf: analysis.decoupling.efSecondHalf,
        },
      });
    } else {
      flags.push({
        code: 'aerobic_decoupling_ok',
        severity: 'info',
        message: verdict.message,
        evidence: { pctDrift: analysis.decoupling.pctDrift },
      });
    }
  }

  // Charge mécanique
  if (analysis.load.mechanical > 70) {
    flags.push({
      code: 'high_eccentric_load',
      severity: analysis.load.mechanical > 110 ? 'warn' : 'watch',
      message:
        `Charge mécanique élevée (${analysis.load.mechanical} pts, ${Math.round(ctx.elevation.lossM)} m de D−). ` +
        `Les dégâts musculaires culminent à 24-48 h : prévoir 48 à 72 h avant la prochaine sollicitation excentrique.`,
      evidence: { mechanicalLoad: analysis.load.mechanical, descentM: Math.round(ctx.elevation.lossM) },
    });
  }

  // Zone dérivante : trop de temps en zone grise
  if (analysis.zones.threeZone.moderate > 0.35 && ctx.durationS > 2400) {
    flags.push({
      code: 'grey_zone',
      severity: 'watch',
      message:
        `${Math.round(analysis.zones.threeZone.moderate * 100)} % du temps entre les deux seuils. ` +
        `Cette « zone grise » coûte cher en fraîcheur pour un bénéfice adaptatif limité : soit plus facile, soit plus dur.`,
      evidence: { moderateFraction: Math.round(analysis.zones.threeZone.moderate * 100) },
    });
  }

  // Cadence
  if (ctx.avgCadence != null && ctx.avgCadence > 100 && ctx.avgCadence < 162) {
    flags.push({
      code: 'low_cadence',
      severity: 'watch',
      message:
        `Cadence moyenne à ${Math.round(ctx.avgCadence)} pas/min. Le test de juillet 2025 relevait 168 avec une cible à 170-180. ` +
        `Une cadence basse allonge le temps de contact et augmente les forces d'impact, en particulier en descente.`,
      evidence: { cadence: Math.round(ctx.avgCadence) },
    });
  }

  // Chaleur
  if (analysis.environment.heatStressFactor > 1.04) {
    flags.push({
      code: 'heat_stress',
      severity: 'info',
      message:
        `Séance réalisée par ${analysis.environment.avgTempC} °C : le coût réel est majoré d'environ ` +
        `${Math.round((analysis.environment.heatStressFactor - 1) * 100)} %. Les allures brutes sous-estiment l'effort produit.`,
      evidence: { tempC: analysis.environment.avgTempC, factor: analysis.environment.heatStressFactor },
    });
  }

  // Qualité de la série
  const series = assessSeries(ctx.intervals);
  if (series) {
    flags.push({
      code: `series_${series.verdict}`,
      severity: series.verdict === 'décrochage' ? 'warn' : 'info',
      message: series.message,
      evidence: { count: series.count, cv: series.consistencyCv, fadePct: series.fadePct },
    });
  }

  // Réserve anaérobie entamée
  if (analysis.wPrimeBalanceMinM != null && model.dPrimeM > 0) {
    const used = 1 - analysis.wPrimeBalanceMinM / model.dPrimeM;
    if (used > 0.85) {
      flags.push({
        code: 'w_prime_depleted',
        severity: 'info',
        message:
          `Réserve anaérobie vidée à ${Math.round(used * 100)} %. La séance a bien touché la filière visée — ` +
          `compter 48 h avant une nouvelle sollicitation de même nature.`,
        evidence: { wPrimeUsedPct: Math.round(used * 100) },
      });
    }
  }

  // Verticalité
  const vi = verticalityIndex(ctx.elevation.gainM, activity.distanceM);
  flags.push({
    code: 'verticality',
    severity: 'info',
    message: `Profil ${vi.label} (${vi.mPerKm} m D+/km).`,
    evidence: { mPerKm: vi.mPerKm },
  });

  return flags;
}

/** Compare l'exécution à la prescription. */
function assessCompliance(
  planned: PlannedSession,
  analysis: ActivityAnalysis,
  actualDurationS: number,
): SessionCompliance {
  const loadDev =
    planned.plannedLoad > 0
      ? ((analysis.load.metabolic - planned.plannedLoad) / planned.plannedLoad) * 100
      : 0;
  const durDev =
    planned.plannedDurationS > 0
      ? ((actualDurationS - planned.plannedDurationS) / planned.plannedDurationS) * 100
      : 0;

  // Intensité : on compare la vitesse graduée des blocs détectés à la cible du
  // premier bloc de travail prescrit.
  const targetBlock = planned.blocks.find((b) => b.speedRangeMs && b.zone !== 'Z1' && b.zone !== 'Z2');
  let intensityDev: number | null = null;
  if (targetBlock?.speedRangeMs && analysis.intervals.length > 0) {
    const targetMid = (targetBlock.speedRangeMs[0] + targetBlock.speedRangeMs[1]) / 2;
    const actual = mean(analysis.intervals.map((i) => i.avgGradedSpeedMs));
    if (actual != null && targetMid > 0) intensityDev = ((actual - targetMid) / targetMid) * 100;
  }

  // Deux questions distinctes, deux jeux de seuils : l'issue dit si c'est bien
  // la séance prescrite qui a eu lieu, le verdict note comment elle a été menée.
  const outcome = sessionOutcome({
    loadPct: loadDev,
    durationPct: durDev,
    intensityPct: intensityDev,
  });

  let verdict: SessionCompliance['verdict'];
  let detail: string;

  if (Math.abs(loadDev) <= 15 && Math.abs(durDev) <= 20 && (intensityDev == null || Math.abs(intensityDev) <= 4)) {
    verdict = 'on_target';
    detail = 'Séance exécutée conformément à la prescription.';
  } else if (intensityDev != null && Math.abs(intensityDev) > 8) {
    verdict = 'wrong_stimulus';
    detail =
      intensityDev > 0
        ? `Blocs courus ${intensityDev.toFixed(1)} % au-dessus de la cible : le stimulus visé a glissé vers une filière plus anaérobie.`
        : `Blocs courus ${Math.abs(intensityDev).toFixed(1)} % sous la cible : le stimulus visé n'a pas été atteint.`;
  } else if (loadDev < -20) {
    verdict = 'under';
    detail = `Charge réalisée ${Math.abs(loadDev).toFixed(0)} % en dessous du prévu.`;
  } else if (loadDev > 20) {
    verdict = 'over';
    detail = `Charge réalisée ${loadDev.toFixed(0)} % au-dessus du prévu. À surveiller sur la fraîcheur des jours suivants.`;
  } else {
    verdict = 'on_target';
    detail = 'Écarts mineurs, séance globalement conforme.';
  }

  if (outcome === 'replaced') {
    detail =
      `Ce n'est pas la séance prescrite : ${formatDuration(actualDurationS)} pour ` +
      `${formatDuration(planned.plannedDurationS)} et ${Math.round(analysis.load.metabolic)} points de charge ` +
      `pour ${Math.round(planned.plannedLoad)} prévus. ${detail}`;
  }

  return {
    plannedSessionId: planned.id,
    loadDeviationPct: Math.round(loadDev * 10) / 10,
    durationDeviationPct: Math.round(durDev * 10) / 10,
    intensityDeviationPct: intensityDev != null ? Math.round(intensityDev * 10) / 10 : null,
    outcome,
    verdict,
    detail,
  };
}

/** Nom lisible de la séance, déduit de sa structure. */
export function describeSession(
  activity: Activity,
  analysis: ActivityAnalysis,
  durationS: number,
): string {
  return inferSessionShape(
    analysis.intervals,
    durationS,
    analysis.zones.threeZone.high,
    activity.totalElevationGainM,
    activity.distanceM,
  );
}

/** Résumé compact de l'analyse — c'est cet objet qui part vers le modèle de langage. */
export function summarizeForCoach(
  activity: Activity,
  analysis: ActivityAnalysis,
  model: PhysiologyModel,
): Record<string, unknown> {
  const descent = analysis.gradeProfile.filter((g) => g.to <= -0.02);
  return {
    nom: activity.name,
    date: activity.startDateLocal,
    type: activity.sportType,
    distance_km: Math.round((activity.distanceM / 100)) / 10,
    duree: Math.round(activity.movingTimeS / 60) + ' min',
    denivele_positif_m: Math.round(activity.totalElevationGainM),
    denivele_negatif_m: Math.round(activity.totalElevationLossM),
    charge_metabolique: analysis.load.metabolic,
    charge_mecanique: analysis.load.mechanical,
    // Un zéro mécanique peut vouloir dire « rien de descendant » comme
    // « rien de visible » : le flux ne porte que de la course.
    charge_mecanique_couvre:
      analysis.load.mechanicalCoverage === 'running_descent'
        ? 'descente courue seulement — un circuit de force ou toute autre charge excentrique hors course y vaut zéro, faute de flux'
        : analysis.load.mechanicalCoverage,
    source_charge: analysis.load.primarySource,
    intensite_relative: analysis.load.intensityFactor,
    vitesse_graduee_normalisee_kmh: Math.round(analysis.load.normalizedGradedSpeedMs * 36) / 10,
    repartition_zones_pct: Object.fromEntries(
      Object.entries(analysis.zones.fraction).map(([k, v]) => [k, Math.round(v * 100)]),
    ),
    modele_3_zones_pct: {
      bas: Math.round(analysis.zones.threeZone.low * 100),
      modere: Math.round(analysis.zones.threeZone.moderate * 100),
      haut: Math.round(analysis.zones.threeZone.high * 100),
    },
    derive_cardiaque_pct: analysis.decoupling.pctDrift,
    facteur_efficience: analysis.decoupling.efficiencyFactor,
    blocs_detectes: analysis.intervals.map((i) => ({
      n: i.index,
      duree_s: i.durationS,
      distance_m: i.distanceM,
      vitesse_graduee_kmh: Math.round(i.avgGradedSpeedMs * 36) / 10,
      pente_pct: Math.round(i.avgGrade * 1000) / 10,
      fc_moy: i.avgHr,
      zone: i.zone,
    })),
    meilleures_vitesses_graduees_kmh: Object.fromEntries(
      Object.entries(analysis.meanMaximalSpeed).map(([k, v]) => [`${k}s`, Math.round(v * 36) / 10]),
    ),
    courbe_vam_mh: analysis.meanMaximalVam,
    descente: {
      temps_s: descent.reduce((a, g) => a + g.seconds, 0),
      courbe_mh: analysis.meanMaximalDescentVam ?? null,
      vitesse_par_pente: descent.map((g) => ({
        pente: `${Math.round(g.from * 100)}..${Math.round(g.to * 100)} %`,
        vitesse_kmh: Math.round(g.avgSpeedMs * 36) / 10,
        secondes: g.seconds,
      })),
    },
    durabilite: analysis.durabilitySignal,
    w_prime_min_m: analysis.wPrimeBalanceMinM,
    w_prime_capacite_m: model.dPrimeM,
    energie: analysis.energy,
    environnement: analysis.environment,
    conformite: analysis.compliance ?? null,
    alertes: analysis.flags.map((f) => ({ code: f.code, gravite: f.severity, message: f.message })),
  };
}
