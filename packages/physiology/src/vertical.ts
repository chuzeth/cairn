import type { GradeBucket, ParameterProvenance, PhysiologyModel } from '@cairn/core';
import { descentSpeedCeiling } from './environment.js';
import { FLAT_RUNNING_COST, locomotionCost, speedForMetabolicPower, vam } from './grade.js';
import { interpolateCurve, meanMaximal, type MmpCurve } from './mmp.js';
import { fractionalUtilization } from './prediction.js';

/**
 * Analyse verticale — la dimension propre au trail.
 *
 * En montée, la vitesse horizontale ne veut rien dire : seule compte la vitesse
 * ascensionnelle (VAM, m D+/h). En descente, ce n'est pas la vitesse mais la
 * capacité à encaisser qui limite. Ce module produit la signature de grimpeur
 * et de descendeur de l'athlète.
 */

export interface VerticalSample {
  dt: number;
  speedMs: number;
  grade: number;
  hr: number | null;
}

/** Tranches de pente utilisées pour le profil — resserrées autour du plat. */
export const GRADE_BUCKETS: [number, number][] = [
  [-Infinity, -0.30], [-0.30, -0.20], [-0.20, -0.12], [-0.12, -0.06], [-0.06, -0.02],
  [-0.02, 0.02],
  [0.02, 0.06], [0.06, 0.12], [0.12, 0.20], [0.20, 0.30], [0.30, Infinity],
];

/** Répartition du temps, de la distance et de la vitesse par tranche de pente. */
export function gradeProfile(samples: readonly VerticalSample[]): GradeBucket[] {
  return GRADE_BUCKETS.map(([from, to]) => {
    let seconds = 0;
    let distanceM = 0;
    let vertM = 0;
    for (const s of samples) {
      if (s.grade < from || s.grade >= to) continue;
      seconds += s.dt;
      distanceM += s.speedMs * s.dt;
      if (s.grade > 0) vertM += s.speedMs * s.dt * Math.sin(Math.atan(s.grade));
    }
    const bucket: GradeBucket = {
      from: from === -Infinity ? -0.6 : from,
      to: to === Infinity ? 0.6 : to,
      seconds: Math.round(seconds),
      distanceM: Math.round(distanceM),
      avgSpeedMs: seconds > 0 ? Math.round((distanceM / seconds) * 1000) / 1000 : 0,
    };
    if (from >= 0.02 && seconds > 0) {
      bucket.vamMh = Math.round((vertM / seconds) * 3600);
    }
    return bucket;
  });
}

/**
 * Durées de référence des courbes verticales, s — de la côte au col.
 *
 * Elles vont au-delà de deux heures parce qu'une rando-course en porte : une
 * montée plus longue que le plus long point mesuré ne se borne que par
 * extrapolation, et une extrapolation n'est pas une mesure.
 */
export const VERTICAL_CURVE_DURATIONS = [
  60, 120, 180, 300, 420, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400,
] as const;

/**
 * Courbe VAM : meilleure vitesse ascensionnelle soutenue sur chaque durée.
 * L'équivalent montagnard de la courbe puissance-durée.
 */
export function vamCurve(samples: readonly VerticalSample[], durations?: readonly number[]): MmpCurve {
  const instantaneous = samples.map((s) => (s.grade > 0.02 ? vam(s.speedMs, s.grade) : 0));
  return roundedMeanMaximal(instantaneous, durations ?? VERTICAL_CURVE_DURATIONS);
}

/**
 * Courbe de descente : meilleure vitesse verticale descendante soutenue sur
 * chaque durée, m D−/h. La même forme que la courbe VAM, et pour la même
 * raison : un point unique à cinq minutes ne dit rien d'une descente de
 * quarante, et c'est sur quarante qu'une séance la prescrit.
 */
export function descentCurve(samples: readonly VerticalSample[], durations?: readonly number[]): MmpCurve {
  const instantaneous = samples.map((s) =>
    s.grade < -0.02 ? s.speedMs * Math.sin(Math.atan(-s.grade)) * 3600 : 0,
  );
  return roundedMeanMaximal(instantaneous, durations ?? VERTICAL_CURVE_DURATIONS);
}

function roundedMeanMaximal(values: readonly number[], durations: readonly number[]): MmpCurve {
  const out: MmpCurve = {};
  for (const [k, v] of Object.entries(meanMaximal(values, durations))) out[k] = Math.round(v);
  return out;
}

/**
 * Analyse de descente : vitesse atteinte par tranche de pente, comparée à la
 * capacité de référence de l'athlète. Un déficit en descente est le gisement de
 * temps le plus rentable et le moins exploité en trail.
 */
export interface DescentAnalysis {
  /** Distance descendue, m. */
  descentM: number;
  /** Temps passé en descente, s. */
  descentTimeS: number;
  /** Vitesse verticale moyenne en descente, m/h. */
  avgDescentVamMh: number;
  /** Meilleure vitesse verticale descendante soutenue, m/h, par durée. */
  curve: MmpCurve;
  /** Vitesse moyenne par tranche de pente descendante, m/s. */
  speedByGrade: { grade: string; speedMs: number; seconds: number }[];
  /** Part du temps total passée en descente. */
  descentFraction: number;
}

export function analyzeDescent(samples: readonly VerticalSample[]): DescentAnalysis {
  const totalTime = samples.reduce((a, s) => a + s.dt, 0);
  let descentM = 0;
  let descentTimeS = 0;

  for (const s of samples) {
    if (s.grade >= -0.02) continue;
    descentTimeS += s.dt;
    descentM += s.speedMs * s.dt * Math.sin(Math.atan(-s.grade));
  }

  const buckets: [string, number, number][] = [
    ['-30 % et plus', -Infinity, -0.30],
    ['-30 à -20 %', -0.30, -0.20],
    ['-20 à -12 %', -0.20, -0.12],
    ['-12 à -6 %', -0.12, -0.06],
    ['-6 à -2 %', -0.06, -0.02],
  ];

  const speedByGrade = buckets.map(([label, lo, hi]) => {
    let d = 0;
    let t = 0;
    for (const s of samples) {
      if (s.grade < lo || s.grade >= hi) continue;
      d += s.speedMs * s.dt;
      t += s.dt;
    }
    return { grade: label, speedMs: t > 0 ? Math.round((d / t) * 100) / 100 : 0, seconds: Math.round(t) };
  });

  return {
    descentM: Math.round(descentM),
    descentTimeS: Math.round(descentTimeS),
    avgDescentVamMh: descentTimeS > 0 ? Math.round((descentM / descentTimeS) * 3600) : 0,
    curve: descentCurve(samples, VERTICAL_CURVE_DURATIONS.filter((d) => d <= samples.length)),
    speedByGrade,
    descentFraction: totalTime > 0 ? Math.round((descentTimeS / totalTime) * 100) / 100 : 0,
  };
}

/**
 * Rendement en montée : rapport entre la VAM réalisée et la VAM théorique
 * attendue pour la puissance métabolique dépensée. Un rendement < 1 signale un
 * choix de foulée sous-optimal (courir là où il fallait marcher, ou l'inverse)
 * ou une technique de montée perfectible (bâtons, appui mains-cuisses, cadence).
 */
export function climbingEfficiency(
  samples: readonly VerticalSample[],
  criticalSpeedMs: number,
): { efficiency: number; sampleSeconds: number } | null {
  const climbing = samples.filter((s) => s.grade > 0.08 && s.speedMs > 0.4);
  const seconds = climbing.reduce((a, s) => a + s.dt, 0);
  if (seconds < 300) return null;

  let actualVert = 0;
  let expectedVert = 0;
  for (const s of climbing) {
    actualVert += s.speedMs * s.dt * Math.sin(Math.atan(s.grade));
    // Référence : monter à la vitesse critique équivalente sur cette pente.
    const targetPower = locomotionCost(criticalSpeedMs, 0) * criticalSpeedMs;
    const refSpeed = speedForMetabolicPower(targetPower, s.grade);
    expectedVert += refSpeed * s.dt * Math.sin(Math.atan(s.grade));
  }

  return {
    efficiency: expectedVert > 0 ? Math.round((actualVert / expectedVert) * 1000) / 1000 : 0,
    sampleSeconds: Math.round(seconds),
  };
}

/**
 * Classement de la sortie sur l'échelle de « verticalité » : m D+ par kilomètre.
 * Convention usuelle du trail : < 20 roulant, 20-40 vallonné, 40-70 montagne,
 * > 70 très montagneux.
 */
export function verticalityIndex(elevationGainM: number, distanceM: number): {
  mPerKm: number;
  label: string;
} {
  const mPerKm = distanceM > 0 ? (elevationGainM / distanceM) * 1000 : 0;
  const label =
    mPerKm < 20 ? 'roulant' : mPerKm < 40 ? 'vallonné' : mPerKm < 70 ? 'montagne' : 'très montagneux';
  return { mPerKm: Math.round(mPerKm), label };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capacité verticale — ce qu'une séance ne peut pas exiger
// ─────────────────────────────────────────────────────────────────────────────

export type VerticalDirection = 'climb' | 'descent';

/** Vitesse verticale maximale tenue sur une durée, et ce sur quoi elle repose. */
export interface VerticalBound {
  vamMh: number;
  provenance: ParameterProvenance;
}

/**
 * Ce que l'athlète peut monter ou descendre, lu sur ses propres courbes.
 *
 * Une borne mesurée n'existe qu'entre le plus court et le plus long point de sa
 * courbe. En deçà du premier, on retient sa valeur : c'est prudent, et c'est
 * encore une mesure. Au-delà du dernier, la décroissance est celle de la loi
 * d'utilisation fractionnelle, ancrée sur ce dernier point. Sans aucun point, la
 * borne est celle du moteur : la puissance de la vitesse critique sur la pente la
 * plus favorable pour monter, le plafond d'un trailer de référence en terrain
 * moyen pour descendre. Ces deux cas sont des valeurs par défaut et se déclarent
 * comme telles — une extrapolation qu'on lirait comme une mesure propagerait
 * jusqu'à la séance une capacité que personne n'a vue.
 */
export interface VerticalCapacity {
  direction: VerticalDirection;
  /** Vitesse verticale maximale sur `durationS`, m/h. */
  at(durationS: number): VerticalBound;
  /** Mètres franchissables au plus en `durationS`. */
  metersIn(durationS: number): number;
  /**
   * Temps minimal pour franchir `meters` : le plus court effort dont la courbe
   * dit qu'il couvre ce dénivelé. `Infinity` quand rien ne le couvre.
   */
  timeFor(meters: number): { durationS: number; provenance: ParameterProvenance };
}

const REFERENCE_GRADES = Array.from({ length: 41 }, (_, i) => 0.05 + i * 0.01);
const REFERENCE_TECHNICALITY = 3;
/** Au-delà de la courbe : de quoi borner une journée entière. */
const BEYOND_CURVE_S = [21600, 28800, 43200, 86400, 172800];

function referenceVam(model: PhysiologyModel, direction: VerticalDirection, durationS: number): number {
  const f = fractionalUtilization(durationS);
  if (direction === 'climb') {
    const power = FLAT_RUNNING_COST * model.criticalSpeedMs * f;
    return Math.max(...REFERENCE_GRADES.map((g) => vam(speedForMetabolicPower(power, g), g)));
  }
  return f * REFERENCE_DESCENT_MH;
}

/** Plafond vertical d'un trailer de référence en terrain moyen, sur la pente la plus favorable, m/h. */
const REFERENCE_DESCENT_MH = Math.max(
  ...REFERENCE_GRADES.map(
    (g) => descentSpeedCeiling(-g, REFERENCE_TECHNICALITY) * Math.sin(Math.atan(g)) * 3600,
  ),
);

export function verticalCapacity(model: PhysiologyModel, direction: VerticalDirection): VerticalCapacity {
  const measured = (direction === 'climb' ? model.vamCurve : model.descentVamCurve) ?? {};
  const keys = Object.keys(measured)
    .map(Number)
    .filter((k) => Number.isFinite(k) && k > 0 && (measured[String(k)] ?? 0) > 0)
    .sort((a, b) => a - b);
  const curve: MmpCurve = Object.fromEntries(keys.map((k) => [String(k), measured[String(k)] as number]));
  const last = keys[keys.length - 1];

  // Une séance se juge par centaines de segments pendant la construction d'un
  // plan : la borne d'une même durée ne se recalcule pas.
  const memo = new Map<number, VerticalBound>();
  const bound = (t: number): VerticalBound => {
    if (last === undefined) return { vamMh: referenceVam(model, direction, t), provenance: 'default' };
    if (t <= last) return { vamMh: interpolateCurve(curve, t) as number, provenance: 'field' };
    return {
      vamMh: ((curve[String(last)] as number) * fractionalUtilization(t)) / fractionalUtilization(last),
      provenance: 'default',
    };
  };
  const at = (durationS: number): VerticalBound => {
    const t = Math.max(1, durationS);
    const cached = memo.get(t);
    if (cached) return cached;
    const b = bound(t);
    if (memo.size < 20_000) memo.set(t, b);
    return b;
  };

  const metersIn = (durationS: number) => (at(durationS).vamMh * Math.max(0, durationS)) / 3600;

  const timeFor = (meters: number) => {
    if (!(meters > 0)) return { durationS: 0, provenance: at(1).provenance };
    const grid = [...new Set([...(keys.length ? keys : VERTICAL_CURVE_DURATIONS), ...BEYOND_CURVE_S])]
      .sort((a, b) => a - b);
    let lo = 0;
    for (const hi of grid) {
      if (metersIn(hi) >= meters) {
        let a = lo;
        let b = hi;
        for (let i = 0; i < 40; i++) {
          const mid = (a + b) / 2;
          if (metersIn(mid) >= meters) b = mid;
          else a = mid;
        }
        return { durationS: b, provenance: at(b).provenance };
      }
      lo = hi;
    }
    return { durationS: Infinity, provenance: at(lo).provenance };
  };

  return { direction, at, metersIn, timeFor };
}
