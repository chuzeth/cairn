import { clamp } from './units.js';

/**
 * Contraintes environnementales.
 *
 * La chaleur et l'altitude ne sont pas des détails de confort : elles déplacent
 * la relation intensité/vitesse. Sans correction, un footing par 32 °C est lu
 * comme une baisse de forme, et une sortie à 2 200 m comme une contre-performance.
 */

/** Température de référence au-delà de laquelle la performance d'endurance se dégrade. */
const THERMAL_NEUTRAL_C = 13;

/**
 * Facteur de contrainte thermique. > 1 signifie « l'effort a coûté plus cher que
 * la vitesse ne le laisse croire ».
 *
 * La pénalité croît avec la température **et** avec la durée : l'accumulation de
 * chaleur est un phénomène intégratif. Ordre de grandeur retenu, cohérent avec
 * la littérature sur le marathon : ~2-3 % de perte à 25 °C sur 2-3 h,
 * ~6-8 % à 32 °C.
 */
export function heatStressFactor(tempC: number | null, durationS: number): number {
  if (tempC == null || !Number.isFinite(tempC)) return 1;
  const excess = Math.max(0, tempC - THERMAL_NEUTRAL_C);
  if (excess === 0) {
    // Le froid marqué coûte aussi, mais bien moins (habillement, vasoconstriction).
    const cold = Math.max(0, -5 - tempC);
    return 1 + cold * 0.0025;
  }
  const hours = clamp(durationS / 3600, 0.3, 8);
  const durationWeight = 0.55 + 0.45 * Math.min(1, hours / 3);
  return 1 + Math.pow(excess, 1.35) * 0.0028 * durationWeight;
}

/**
 * Facteur altitude sur la VO2max.
 *
 * Chez le sujet entraîné, la dégradation commence bas (~600 m) et progresse
 * d'environ 6,3 % par 1 000 m — les athlètes à VO2max élevée sont *plus*
 * pénalisés, la limitation étant déjà pulmonaire au niveau de la mer.
 * Avec une VO2max à 64,6 ml/kg/min, Pierre est concerné dès les Alpes moyennes.
 */
export function altitudeVo2Factor(altitudeM: number | null, vo2maxRel = 60): number {
  if (altitudeM == null || !Number.isFinite(altitudeM)) return 1;
  const threshold = vo2maxRel > 60 ? 580 : 900;
  const above = Math.max(0, altitudeM - threshold);
  const ratePerKm = vo2maxRel > 60 ? 0.068 : 0.058;
  return clamp(1 - (above / 1000) * ratePerKm, 0.62, 1);
}

/**
 * Impact de l'altitude sur la vitesse soutenable. Il est plus faible que
 * l'impact sur la VO2max : à intensité sous-maximale, une partie de la perte est
 * absorbée par l'augmentation de la fraction d'utilisation.
 */
export function altitudePaceFactor(altitudeM: number | null, vo2maxRel = 60): number {
  const vo2 = altitudeVo2Factor(altitudeM, vo2maxRel);
  return 1 - (1 - vo2) * 0.62;
}

/** Acclimatation : atténue la pénalité thermique après une exposition répétée. */
export function acclimatizationCredit(hotSessionsLast14Days: number): number {
  // Une acclimatation complète (10-14 séances) récupère ~60 % de la perte.
  return clamp(hotSessionsLast14Days / 12, 0, 1) * 0.6;
}

/** Applique le crédit d'acclimatation à un facteur thermique. */
export function adjustedHeatFactor(rawFactor: number, credit: number): number {
  return 1 + (rawFactor - 1) * (1 - credit);
}

/**
 * Pénalité de technicité du terrain sur la vitesse.
 * 1 = piste roulante, 5 = alpin très technique (pierriers, racines, dalles).
 * La pénalité porte surtout sur la descente et le plat rapide ; en montée raide,
 * la contrainte est d'abord métabolique et la technicité pèse peu.
 */
export function technicalityFactor(
  technicality: 1 | 2 | 3 | 4 | 5,
  grade: number,
): number {
  const base = [0, 1.0, 0.97, 0.93, 0.87, 0.79][technicality] ?? 0.93;
  if (grade > 0.15) {
    // En forte montée, on perd peu : la vitesse est déjà basse.
    return 1 - (1 - base) * 0.3;
  }
  if (grade < -0.08) {
    // En descente, la technicité coûte le plus cher.
    return 1 - (1 - base) * 1.35;
  }
  return base;
}

/**
 * Plafond de vitesse en descente, m/s.
 *
 * Correctif indispensable, et absent de la plupart des modèles : en descente,
 * le facteur limitant n'est **pas** l'aérobie. Le coût métabolique de Minetti y
 * est très bas — un modèle qui convertit naïvement la puissance disponible en
 * vitesse fait dévaler un −12 % à 25 km/h, ce que personne ne fait. Ce qui
 * limite réellement, c'est la tolérance aux forces d'impact excentriques, la
 * technique de pied et la lisibilité du terrain.
 *
 * Valeurs de référence pour un bon trailer sur terrain roulant, modulées par la
 * technicité et par l'aisance propre de l'athlète (`skill`, 1,0 = référence).
 */
export function descentSpeedCeiling(
  grade: number,
  technicality: 1 | 2 | 3 | 4 | 5,
  skill = 1,
): number {
  if (grade >= -0.01) return Infinity;
  const steep = Math.max(-0.5, grade);
  // ≈ 5,4 m/s à −2 %, 4,6 m/s à −10 %, 3,9 m/s à −20 %, 2,0 m/s à −45 %.
  const base = 5.5 + 7.6 * steep;
  const tech = [0, 1.0, 0.92, 0.83, 0.71, 0.58][technicality] ?? 0.83;
  return Math.max(0.6, base * tech * clamp(skill, 0.6, 1.35));
}

/**
 * Technicité exprimée en **surcoût métabolique** (× le coût de transport).
 *
 * C'est la formulation physiologiquement correcte : un sentier de pierriers ne
 * fait pas « produire moins de watts », il fait coûter plus cher chaque mètre —
 * stabilisation, appuis irréguliers, changements de rythme. Exprimer la
 * technicité en perte de vitesse conduit à la double-compter dès qu'on
 * raisonne en puissance, et fausse tout modèle de course.
 */
export function technicalityCostMultiplier(
  technicality: 1 | 2 | 3 | 4 | 5,
  grade: number,
): number {
  const speedFactor = technicalityFactor(technicality, grade);
  return speedFactor > 0 ? 1 / speedFactor : 1;
}

/** Pénalité de nuit (fatigue visuelle, prudence accrue, rythme circadien). */
export function nightFactor(nightHours: number, totalHours: number): number {
  if (nightHours <= 0 || totalHours <= 0) return 1;
  const fraction = clamp(nightHours / totalHours, 0, 1);
  return 1 - fraction * 0.05;
}

export interface EnvironmentContext {
  tempC: number | null;
  altitudeM: number | null;
  durationS: number;
  vo2maxRel: number;
  hotSessionsLast14Days?: number;
}

/** Facteur environnemental composite appliqué à la vitesse soutenable. */
export function environmentalFactor(ctx: EnvironmentContext): {
  total: number;
  heat: number;
  altitude: number;
} {
  const rawHeat = heatStressFactor(ctx.tempC, ctx.durationS);
  const heat = adjustedHeatFactor(rawHeat, acclimatizationCredit(ctx.hotSessionsLast14Days ?? 0));
  const altitude = altitudePaceFactor(ctx.altitudeM, ctx.vo2maxRel);
  // `heat` est une pénalité de coût (>1) ; on la convertit en facteur de vitesse.
  const heatSpeed = 1 / heat;
  return {
    total: Math.round(heatSpeed * altitude * 10000) / 10000,
    heat: Math.round(heat * 10000) / 10000,
    altitude: Math.round(altitude * 10000) / 10000,
  };
}
