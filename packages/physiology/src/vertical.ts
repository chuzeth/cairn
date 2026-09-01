import type { GradeBucket } from '@cairn/core';
import { locomotionCost, speedForMetabolicPower, vam } from './grade.js';
import { meanMaximal, type MmpCurve } from './mmp.js';

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
 * Courbe VAM : meilleure vitesse ascensionnelle soutenue sur chaque durée.
 * L'équivalent montagnard de la courbe puissance-durée.
 */
export function vamCurve(samples: readonly VerticalSample[], durations?: readonly number[]): MmpCurve {
  const instantaneous = samples.map((s) => (s.grade > 0.02 ? vam(s.speedMs, s.grade) : 0));
  const curve = meanMaximal(instantaneous, durations ?? [60, 120, 300, 600, 1200, 1800, 2700, 3600, 5400, 7200]);
  const out: MmpCurve = {};
  for (const [k, v] of Object.entries(curve)) out[k] = Math.round(v);
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
  /** Meilleure vitesse verticale descendante soutenue 5 min, m/h. */
  best5minDescentVamMh: number;
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

  const descentSeries = samples.map((s) =>
    s.grade < -0.02 ? s.speedMs * Math.sin(Math.atan(-s.grade)) * 3600 : 0,
  );
  const best = meanMaximal(descentSeries, [300]);

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
    best5minDescentVamMh: Math.round(best['300'] ?? 0),
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
