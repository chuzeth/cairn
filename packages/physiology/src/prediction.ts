import type { CourseProfile, PacingSegment, PhysiologyModel, RaceGoal, RacePrediction } from '@cairn/core';
import { independentVertM } from './durability.js';
import { FLAT_RUNNING_COST, gaitForSpeed, locomotionCost, speedForMetabolicPower } from './grade.js';
import {
  descentSpeedCeiling, environmentalFactor, nightFactor,
  technicalityCostMultiplier, technicalityFactor,
} from './environment.js';
import { fuelingTargets } from './load.js';
import { clamp, formatClock } from './units.js';

/**
 * Prédiction de performance et construction du plan d'allure.
 *
 * Principe directeur : sur terrain varié, **l'allure optimale n'est pas une
 * vitesse constante, c'est une puissance métabolique constante**. Courir à
 * 5:00/km à plat puis vouloir tenir 5:00/km dans une côte à 12 % revient à
 * doubler sa dépense ; à l'inverse, se laisser porter en descente gaspille du
 * temps gratuit. Le moteur résout donc la course en puissance, puis convertit
 * segment par segment en vitesse — c'est ce que font, intuitivement, les
 * coureurs qui gèrent bien.
 */

/** Durabilité de référence de la population entraînée, %/h — sert de point zéro. */
const REFERENCE_DURABILITY_PCT_PER_HOUR = 3.0;

/**
 * Fraction de la vitesse critique soutenable en fonction de la durée.
 *
 * Calibrée sur les repères classiques de la physiologie de l'endurance :
 * 100 % à 20 min, ~93 % à 1 h, ~88 % à 2 h, ~84 % à 4 h, ~77 % à 6 h, ~72 % à 10 h.
 * Forme : f = 1 − c₁·L − c₂·L², avec L = ln(T / 1200 s).
 */
export function fractionalUtilization(durationS: number): number {
  if (durationS <= 1200) return 1;
  const L = Math.log(durationS / 1200);
  return clamp(1 - 0.0548 * L - 0.0081 * L * L, 0.5, 1);
}

export interface CourseSegment {
  index: number;
  label: string;
  fromM: number;
  toM: number;
  lengthM: number;
  grade: number;
  gainM: number;
  lossM: number;
  /** Altitude moyenne du segment, m. */
  altitudeM: number;
}

/**
 * Découpe le parcours. Si un profil altimétrique réel est fourni (GPX), on
 * l'utilise ; sinon on synthétise un profil canonique cohérent avec le D+ et le
 * D− annoncés — approximation honnête, signalée comme telle dans la sortie.
 */
export function buildCourseSegments(course: CourseProfile, targetSegmentM = 500): CourseSegment[] {
  if (course.points && course.points.length > 3) {
    return segmentsFromProfile(course.points, targetSegmentM);
  }
  return synthesizeSegments(course);
}

function segmentsFromProfile(
  points: { distanceM: number; altitudeM: number }[],
  targetSegmentM: number,
): CourseSegment[] {
  const sorted = [...points].sort((a, b) => a.distanceM - b.distanceM);
  const total = sorted[sorted.length - 1]!.distanceM;
  const count = Math.max(4, Math.round(total / targetSegmentM));
  const step = total / count;
  const out: CourseSegment[] = [];

  const altAt = (d: number): number => {
    if (d <= sorted[0]!.distanceM) return sorted[0]!.altitudeM;
    for (let i = 1; i < sorted.length; i++) {
      const b = sorted[i]!;
      if (d <= b.distanceM) {
        const a = sorted[i - 1]!;
        const span = b.distanceM - a.distanceM;
        const t = span > 0 ? (d - a.distanceM) / span : 0;
        return a.altitudeM + (b.altitudeM - a.altitudeM) * t;
      }
    }
    return sorted[sorted.length - 1]!.altitudeM;
  };

  for (let i = 0; i < count; i++) {
    const fromM = i * step;
    const toM = (i + 1) * step;
    const z0 = altAt(fromM);
    const z1 = altAt(toM);
    const dz = z1 - z0;
    out.push({
      index: i + 1,
      label: `km ${(fromM / 1000).toFixed(1)}–${(toM / 1000).toFixed(1)}`,
      fromM,
      toM,
      lengthM: step,
      grade: clamp(dz / step, -0.5, 0.5),
      gainM: Math.max(0, dz),
      lossM: Math.max(0, -dz),
      altitudeM: (z0 + z1) / 2,
    });
  }
  return out;
}

/**
 * Profil synthétique : alternance montée / roulant / descente respectant le D+
 * et le D− totaux. On répartit le dénivelé sur un nombre de bosses cohérent avec
 * la distance, ce qui donne des pentes réalistes plutôt qu'une pente moyenne
 * uniforme — laquelle sous-estimerait fortement le coût réel.
 */
function synthesizeSegments(course: CourseProfile): CourseSegment[] {
  const { distanceM, elevationGainM, elevationLossM } = course;
  const climbs = clamp(Math.round(distanceM / 8000), 2, 12);
  const blocksPerClimb = 3; // montée · replat · descente
  const count = climbs * blocksPerClimb;
  const step = distanceM / count;

  // Répartition de la distance : 35 % en montée, 35 % en descente, 30 % roulant.
  const climbDistance = distanceM * 0.35;
  const descentDistance = distanceM * 0.35;
  const upGrade = climbDistance > 0 ? elevationGainM / climbDistance : 0;
  const downGrade = descentDistance > 0 ? -elevationLossM / descentDistance : 0;

  const out: CourseSegment[] = [];
  const baseAlt = 400;
  let alt = baseAlt;

  for (let i = 0; i < count; i++) {
    const phase = i % blocksPerClimb;
    // Montée : blocs 0 · roulant : bloc 1 · descente : bloc 2.
    // On étire les blocs de montée/descente pour atteindre 35 % chacun.
    const grade =
      phase === 0 ? clamp(upGrade * (blocksPerClimb * 0.35), -0.5, 0.5)
      : phase === 2 ? clamp(downGrade * (blocksPerClimb * 0.35), -0.5, 0.5)
      : 0.005;
    const dz = grade * step;
    const from = i * step;
    out.push({
      index: i + 1,
      label: `km ${(from / 1000).toFixed(1)}–${((from + step) / 1000).toFixed(1)}`,
      fromM: from,
      toM: from + step,
      lengthM: step,
      grade,
      gainM: Math.max(0, dz),
      lossM: Math.max(0, -dz),
      altitudeM: alt + dz / 2,
    });
    alt += dz;
  }
  return out;
}

export interface SegmentSolveOptions {
  technicality: 1 | 2 | 3 | 4 | 5;
  /** Aisance en descente de l'athlète, 1,0 = bon trailer de référence. */
  descentSkill?: number;
  /**
   * Modulation de la puissance le long du parcours, en fonction de la
   * progression (0 au départ, 1 à l'arrivée). Par défaut : constante.
   */
  shape?: (progress: number) => number;
}

/**
 * Résout un enchaînement de segments à puissance métabolique donnée.
 *
 * Deux contraintes s'appliquent : la puissance disponible — la technicité y
 * entre comme surcoût de transport — et, en descente, un plafond mécanique et
 * technique. Quand ce plafond mord, l'athlète produit moins que sa puissance
 * cible ; une part de cette capacité inutilisée est reportée sur les segments
 * non plafonnés (les montées), ce que fait naturellement un coureur qui gère
 * bien. On n'en récupère qu'une fraction : la capacité aérobie ne se met pas en
 * réserve indéfiniment.
 *
 * Sans cette redistribution, le modèle sous-estimerait le temps sur tout
 * parcours comportant beaucoup de descente.
 */
export function solveSegmentTimes(
  segments: readonly CourseSegment[],
  targetPower: number,
  opts: SegmentSolveOptions,
): { times: number[]; elapsedS: number } {
  const RECOVERED_SHARE = 0.5;
  const shape = opts.shape ?? (() => 1);
  const totalLength = segments.reduce((a, s) => a + s.lengthM, 0);
  let boost = 1;
  let times: number[] = [];
  let elapsed = 0;

  for (let pass = 0; pass < 5; pass++) {
    times = [];
    elapsed = 0;
    let cumulativeLength = 0;
    let deficitWork = 0;
    let freeWork = 0;

    for (const seg of segments) {
      const progress = cumulativeLength / Math.max(1, totalLength);
      const localPower = targetPower * shape(progress) * boost;
      const costMult = technicalityCostMultiplier(opts.technicality, seg.grade);

      // Vitesse que la puissance disponible permettrait, technicité incluse.
      const desired = speedForMetabolicPower(localPower / costMult, seg.grade);
      const ceiling = descentSpeedCeiling(seg.grade, opts.technicality, opts.descentSkill ?? 1);
      const v = Math.max(0.35, Math.min(desired, ceiling));
      const dt = seg.lengthM / v;

      const actualPower = locomotionCost(v, seg.grade) * costMult * v;
      if (desired > ceiling) deficitWork += (localPower - actualPower) * dt;
      else freeWork += actualPower * dt;

      times.push(dt);
      elapsed += dt;
      cumulativeLength += seg.lengthM;
    }

    if (deficitWork <= 0 || freeWork <= 0) break;
    const nextBoost = clamp(1 + (RECOVERED_SHARE * deficitWork) / freeWork, 1, 1.18);
    if (Math.abs(nextBoost - boost) < 0.002) break;
    boost = nextBoost;
  }

  return { times, elapsedS: elapsed };
}

export interface PredictionInput {
  model: PhysiologyModel;
  course: CourseProfile;
  /** TSB métabolique attendu le jour de la course. */
  raceDayTsb?: number;
  /** Séances par forte chaleur sur les 14 derniers jours (acclimatation). */
  hotSessionsLast14Days?: number;
  /** Force de la fusion de la CS et incertitude du modèle (0–1). */
  confidenceOverride?: number;
  /**
   * Coupe le calcul des facteurs limitants. Indispensable : ceux-ci rejouent
   * `predictRace` sur des modèles altérés — sans ce garde-fou, la récursion
   * serait infinie.
   */
  skipLimiters?: boolean;
}

/**
 * Résout la course par itérations : la durée dépend de l'intensité soutenable,
 * qui dépend elle-même de la durée. Convergence en 5 à 8 tours.
 */
export function predictRace(input: PredictionInput): RacePrediction & { segments: CourseSegment[] } {
  const { model, course } = input;
  const segments = buildCourseSegments(course);
  const totalGain = segments.reduce((a, s) => a + s.gainM, 0);
  const avgAltitude = segments.reduce((a, s) => a + s.altitudeM * s.lengthM, 0) / Math.max(1, course.distanceM);

  // Correction de durabilité : écart de l'athlète à la référence, plus la
  // pénalité propre au dénivelé (absente des modèles routiers) — le seul
  // dénivelé que la perte horaire ne contient pas déjà, sans quoi une perte
  // mesurée sur des sorties qui montent se compterait deux fois.
  const durabilityFactorFor = (hours: number): number => {
    const relative =
      ((REFERENCE_DURABILITY_PCT_PER_HOUR - model.durabilityPctPerHour) / 100) * hours * 0.45;
    const independent = independentVertM(hours * 3600, totalGain, model.durabilityVertRateMh);
    const vertical = (model.durabilityPctPer1000mVert / 100) * (independent / 1000) * 0.25;
    return clamp(1 + relative - vertical, 0.72, 1.12);
  };

  const freshness = clamp(1 + (input.raceDayTsb ?? 0) * 0.0008, 0.955, 1.028);

  let T = (course.distanceM / (model.criticalSpeedMs * 0.82)) * 1.15;
  let env = { total: 1, heat: 1, altitude: 1 };
  let durability = 1;
  let f = 1;
  let segmentTimes: number[] = [];

  for (let iter = 0; iter < 12; iter++) {
    const hours = T / 3600;
    f = fractionalUtilization(T);
    durability = durabilityFactorFor(hours);
    env = environmentalFactor({
      tempC: course.expectedTempC ?? null,
      altitudeM: avgAltitude,
      durationS: T,
      vo2maxRel: model.vo2maxRel,
      hotSessionsLast14Days: input.hotSessionsLast14Days ?? 0,
    });
    const night = nightFactor(course.nightHours ?? 0, hours);

    // Vitesse à plat équivalente soutenable, puis puissance métabolique cible.
    const equivalentFlatSpeed =
      model.criticalSpeedMs * f * durability * env.total * freshness * night;
    const targetPower = FLAT_RUNNING_COST * equivalentFlatSpeed;

    // Résolution segment par segment, à puissance cible décroissante :
    // +2,5 % au départ, −2,5 % à l'arrivée.
    const solved = solveSegmentTimes(segments, targetPower, {
      technicality: course.technicality,
      descentSkill: model.descentSkill,
      shape: (progress) => 1.025 - 0.05 * progress,
    });
    segmentTimes = solved.times;

    const next = solved.elapsedS;
    if (Math.abs(next - T) / T < 0.002) {
      T = next;
      break;
    }
    T = T * 0.4 + next * 0.6; // sous-relaxation : évite les oscillations
  }

  // Distance équivalente à plat : ce que la course « vaut » en kilomètres roulants.
  const flatEquivalent = segments.reduce((acc, seg, i) => {
    const dt = segmentTimes[i] ?? 0;
    const v = dt > 0 ? seg.lengthM / dt : 0;
    const cost = gaitForSpeed(v, seg.grade) === 'walk'
      ? walkCostAt(seg.grade)
      : runCostAt(seg.grade);
    return acc + seg.lengthM * (cost / FLAT_RUNNING_COST);
  }, 0);

  const confidence = input.confidenceOverride ?? model.confidence;
  // Incertitude : le trail est intrinsèquement plus dispersé que la route
  // (terrain, ravitaillement, météo, navigation).
  const baseCv = 0.045 + (course.technicality - 1) * 0.008 + Math.min(0.03, T / 3600 / 400);
  const sigma = baseCv * (1 + (1 - confidence) * 0.9);

  const pacing = buildPacing(segments, segmentTimes, model, course, T);

  const fuel = fuelingTargets(T, f * 0.9, course.expectedTempC ?? null);

  return {
    raceId: '',
    computedAt: new Date().toISOString(),
    predictedTimeS: Math.round(T),
    rangeS: [Math.round(T * (1 - 1.282 * sigma)), Math.round(T * (1 + 1.282 * sigma))],
    flatEquivalentDistanceM: Math.round(flatEquivalent),
    sustainableFractionOfCs: Math.round(f * 1000) / 1000,
    factors: {
      terrain: Math.round(technicalityFactor(course.technicality, 0) * 1000) / 1000,
      heat: Math.round((1 / env.heat) * 1000) / 1000,
      altitude: env.altitude,
      durability: Math.round(durability * 1000) / 1000,
      freshness: Math.round(freshness * 1000) / 1000,
    },
    pacing,
    fueling: {
      carbGPerHour: fuel.carbGPerHour,
      fluidMlPerHour: fuel.fluidMlPerHour,
      sodiumMgPerHour: fuel.sodiumMgPerHour,
      totalCarbG: Math.round((fuel.carbGPerHour * T) / 3600),
    },
    limiters: input.skipLimiters ? [] : computeLimiters(input, T),
    segments,
  };
}

function runCostAt(grade: number): number {
  const i = clamp(grade, -0.45, 0.45);
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}
function walkCostAt(grade: number): number {
  const i = clamp(grade, -0.45, 0.45);
  return 280.5 * i ** 5 - 58.7 * i ** 4 - 76.8 * i ** 3 + 51.9 * i ** 2 + 19.6 * i + 2.5;
}

/** Regroupe les segments fins en tronçons lisibles et produit les consignes. */
function buildPacing(
  segments: CourseSegment[],
  times: number[],
  model: PhysiologyModel,
  course: CourseProfile,
  totalTimeS: number,
): PacingSegment[] {
  // On agrège en ~10 à 14 tronçons pour rester exploitable en course.
  const groupCount = clamp(Math.round(course.distanceM / 3500), 6, 14);
  const perGroup = Math.ceil(segments.length / groupCount);
  const out: PacingSegment[] = [];
  let cumulative = 0;

  for (let g = 0; g < segments.length; g += perGroup) {
    const chunk = segments.slice(g, g + perGroup);
    const chunkTimes = times.slice(g, g + perGroup);
    const lengthM = chunk.reduce((a, s) => a + s.lengthM, 0);
    const durationS = chunkTimes.reduce((a, t) => a + t, 0);
    const gainM = chunk.reduce((a, s) => a + s.gainM, 0);
    const lossM = chunk.reduce((a, s) => a + s.lossM, 0);
    const avgGrade = lengthM > 0 ? (gainM - lossM) / lengthM : 0;
    const speed = durationS > 0 ? lengthM / durationS : 0;
    cumulative += durationS;

    const progress = cumulative / totalTimeS;
    // Plafond de FC : on protège le début de course, on libère la fin.
    const hrCeil = Math.round(
      model.vt1.hr + (model.vt2.hr - model.vt1.hr) * clamp(0.15 + progress * 0.75, 0, 1),
    );
    const hrFloor = Math.round(hrCeil - 10);

    out.push({
      index: out.length + 1,
      label: `km ${(chunk[0]!.fromM / 1000).toFixed(1)}–${(chunk[chunk.length - 1]!.toM / 1000).toFixed(1)}`,
      fromM: Math.round(chunk[0]!.fromM),
      toM: Math.round(chunk[chunk.length - 1]!.toM),
      elevationGainM: Math.round(gainM),
      elevationLossM: Math.round(lossM),
      avgGrade: Math.round(avgGrade * 1000) / 1000,
      targetSpeedMs: Math.round(speed * 1000) / 1000,
      targetVamMh: avgGrade > 0.04 ? Math.round(speed * Math.sin(Math.atan(avgGrade)) * 3600) : undefined,
      targetHrRange: [hrFloor, hrCeil],
      estimatedDurationS: Math.round(durationS),
      cumulativeTimeS: Math.round(cumulative),
      cue: pacingCue(progress, avgGrade, out.length + 1, groupCount),
    });
  }
  return out;
}

function pacingCue(progress: number, grade: number, index: number, total: number): string {
  if (index === 1)
    return "Départ volontairement contenu : deux dents en dessous de ce que tu te sens capable de tenir. C'est ici qu'on perd les courses.";
  if (progress < 0.3 && grade > 0.08)
    return 'Montée en début de course : cadence courte, marche dès que la pente rend la course inefficace. Ne force pas la respiration.';
  if (progress < 0.3)
    return 'Encore en gestion. La sensation doit rester « facile mais soutenue ».';
  if (progress < 0.6 && grade < -0.06)
    return "Descente : relâche les épaules, cadence haute, appuis courts. Tu gagnes du temps ici sans coût cardiaque — mais c'est ce qui abîme les cuisses.";
  if (progress < 0.6) return 'Cœur de course : verrouille ton allure, mange et bois selon le plan.';
  if (progress < 0.85 && grade > 0.08)
    return "Montée de la phase décisive : c'est le moment de passer devant. Contrôle la FC, ne pars pas en dette.";
  if (progress < 0.85)
    return "Phase où les écarts se creusent. Si les sensations sont bonnes, tu peux monter d'un cran.";
  if (index === total) return 'Dernier tronçon : tout ce qui reste. Plus rien à garder.';
  return "Fin de course : accepte l'inconfort, tiens la cadence plutôt que la foulée.";
}

/**
 * Classement des facteurs limitants, par contrefactuels : on rejoue la
 * prédiction en améliorant un paramètre à la fois et on mesure le temps gagné.
 * C'est ce qui transforme une prédiction en levier d'entraînement.
 */
function computeLimiters(input: PredictionInput, baseTime: number): RacePrediction['limiters'] {
  const variants: { factor: string; mutate: (m: PhysiologyModel) => PhysiologyModel; explanation: string }[] = [
    {
      factor: 'Vitesse critique (+3 %)',
      mutate: (m) => ({ ...m, criticalSpeedMs: m.criticalSpeedMs * 1.03 }),
      explanation: 'Gain obtenu en repoussant le seuil : fractionné au seuil et tempo prolongé.',
    },
    {
      factor: 'Durabilité (niveau élite)',
      mutate: (m) => ({ ...m, durabilityPctPerHour: 1.5, durabilityPctPer1000mVert: 2.0 }),
      explanation:
        "Gain obtenu en résistant mieux à la fatigue : volume aérobie, sorties longues avec dénivelé, travail à jeun contrôlé.",
    },
    {
      factor: 'Fraîcheur optimale au départ',
      mutate: (m) => m,
      explanation: "Gain obtenu par un affûtage bien conduit — le levier le moins coûteux et le plus souvent gâché.",
    },
  ];

  const out: RacePrediction['limiters'] = [];
  for (const v of variants) {
    const altered =
      v.factor === 'Fraîcheur optimale au départ'
        ? predictRace({ ...input, raceDayTsb: 15, skipLimiters: true })
        : predictRace({ ...input, model: v.mutate(input.model), skipLimiters: true });
    const gain = baseTime - altered.predictedTimeS;
    if (gain > 20) {
      out.push({ factor: v.factor, impactS: Math.round(gain), explanation: v.explanation });
    }
  }
  return out.sort((a, b) => b.impactS - a.impactS);
}

/**
 * Probabilité d'atteindre l'objectif. La dispersion des temps de course suit
 * approximativement une loi log-normale ; on intègre la densité jusqu'au temps cible.
 */
export function goalProbability(prediction: RacePrediction, targetTimeS: number): number {
  const median = prediction.predictedTimeS;
  if (median <= 0 || targetTimeS <= 0) return 0;
  // σ reconstitué depuis l'intervalle à 80 %.
  const sigma = Math.log(prediction.rangeS[1] / median) / 1.282;
  if (sigma <= 0) return targetTimeS >= median ? 1 : 0;
  const z = (Math.log(targetTimeS) - Math.log(median)) / sigma;
  return Math.round(normalCdf(z) * 1000) / 10;
}

function normalCdf(z: number): number {
  // Approximation d'Abramowitz & Stegun (erreur < 7,5·10⁻⁸).
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Traduit un objectif de classement en temps cible, à partir des résultats des
 * éditions précédentes. Sans historique, on ne peut rien affirmer : la fonction
 * le dit explicitement plutôt que d'inventer un chiffre.
 */
export function placingToTargetTime(
  goal: RaceGoal,
): { targetTimeS: number | null; basis: string } {
  const editions = goal.target?.previousEditions ?? [];
  const placing = goal.target?.placing;
  if (!placing) return { targetTimeS: goal.target?.timeS ?? null, basis: 'Objectif exprimé en temps.' };
  if (editions.length === 0) {
    return {
      targetTimeS: null,
      basis:
        `Aucun résultat d'édition précédente enregistré pour « ${goal.name} ». ` +
        `Renseigne les temps du top ${placing} des dernières années pour convertir l'objectif de classement en temps cible.`,
    };
  }

  // Temps du rang visé, pour chaque édition disponible, puis médiane pondérée
  // vers les éditions récentes.
  const relevant = editions.filter((e) => Math.abs(e.placing - placing) <= 3);
  const pool = relevant.length > 0 ? relevant : editions;
  const sorted = [...pool].sort((a, b) => b.year - a.year);
  const weights = sorted.map((_, i) => Math.pow(0.7, i));
  const totalW = weights.reduce((a, b) => a + b, 0);
  const weighted = sorted.reduce((acc, e, i) => acc + e.timeS * (weights[i] as number), 0) / totalW;

  return {
    targetTimeS: Math.round(weighted),
    basis:
      `Estimé depuis ${sorted.length} édition(s) : ${sorted
        .map((e) => `${e.year} — ${e.placing}ᵉ en ${formatClock(e.timeS)}`)
        .join(', ')}. Pondération vers les éditions récentes.`,
  };
}
