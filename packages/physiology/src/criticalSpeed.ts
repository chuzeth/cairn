import type { MmpCurve } from './mmp.js';
import { interpolateCurve } from './mmp.js';
import { clamp } from './units.js';

/**
 * Modèle vitesse critique / D'.
 *
 * La vitesse critique (CS) est l'asymptote de la relation vitesse-durée : la
 * plus haute intensité soutenable en régime physiologique stable. D' est la
 * réserve de distance mobilisable au-dessus de CS. Ensemble, ils décrivent la
 * capacité d'un coureur bien mieux qu'une VMA isolée, et ils se ré-estiment en
 * continu depuis le terrain — là où un test de laboratoire vieillit.
 *
 * Modèle à 2 paramètres :   d = CS · t + D'
 * Modèle à 3 paramètres :   t = D' / (v − CS) + D' / (CS − v_max)
 *                           (Morton, 1996 — corrige la surestimation aux durées courtes)
 */

export interface CriticalSpeedFit {
  criticalSpeedMs: number;
  dPrimeM: number;
  /** Coefficient de détermination du modèle linéaire. */
  r2: number;
  /** Points effectivement utilisés pour l'ajustement. */
  points: { durationS: number; speedMs: number; distanceM: number }[];
  /** Vitesse instantanée maximale théorique (modèle 3 paramètres). */
  vMaxMs?: number;
  quality: 'strong' | 'usable' | 'weak' | 'insufficient';
}

/**
 * Fenêtre d'ajustement. En dessous de 2 min la contribution anaérobie fausse la
 * linéarité ; au-delà de ~20 min, la fatigue lente tire CS vers le bas.
 */
const FIT_MIN_S = 120;
const FIT_MAX_S = 1200;

/** Ajuste CS et D' par régression linéaire de la distance sur le temps. */
export function fitCriticalSpeed(curve: MmpCurve): CriticalSpeedFit {
  const points = Object.entries(curve)
    .map(([k, v]) => ({ durationS: Number(k), speedMs: v }))
    .filter(
      (p) =>
        Number.isFinite(p.durationS) &&
        Number.isFinite(p.speedMs) &&
        p.speedMs > 0 &&
        p.durationS >= FIT_MIN_S &&
        p.durationS <= FIT_MAX_S,
    )
    .map((p) => ({ ...p, distanceM: p.speedMs * p.durationS }))
    .sort((a, b) => a.durationS - b.durationS);

  if (points.length < 3) {
    return {
      criticalSpeedMs: 0,
      dPrimeM: 0,
      r2: 0,
      points,
      quality: 'insufficient',
    };
  }

  const n = points.length;
  const sumT = points.reduce((a, p) => a + p.durationS, 0);
  const sumD = points.reduce((a, p) => a + p.distanceM, 0);
  const sumTT = points.reduce((a, p) => a + p.durationS ** 2, 0);
  const sumTD = points.reduce((a, p) => a + p.durationS * p.distanceM, 0);

  const denom = n * sumTT - sumT ** 2;
  if (Math.abs(denom) < 1e-9) {
    return { criticalSpeedMs: 0, dPrimeM: 0, r2: 0, points, quality: 'insufficient' };
  }

  const cs = (n * sumTD - sumT * sumD) / denom;
  const dPrime = (sumD - cs * sumT) / n;

  const meanD = sumD / n;
  const ssTot = points.reduce((a, p) => a + (p.distanceM - meanD) ** 2, 0);
  const ssRes = points.reduce(
    (a, p) => a + (p.distanceM - (cs * p.durationS + dPrime)) ** 2,
    0,
  );
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Un D' négatif est physiologiquement absurde : il signale un jeu de points
  // dégénéré (par ex. une seule vraie performance). On dégrade proprement.
  const valid = cs > 1 && dPrime > 0;
  const quality: CriticalSpeedFit['quality'] = !valid
    ? 'weak'
    : r2 > 0.98 && n >= 5
      ? 'strong'
      : r2 > 0.9
        ? 'usable'
        : 'weak';

  return {
    criticalSpeedMs: valid ? cs : 0,
    dPrimeM: valid ? dPrime : 0,
    r2,
    points,
    quality,
  };
}

/**
 * Vitesse soutenable prédite pour une durée donnée (modèle hyperbolique).
 * Au-delà de ~30 min, le modèle à 2 paramètres surestime : on applique la
 * décroissance de durabilité (cf. `durability.ts`) en aval.
 */
export function predictSpeed(cs: number, dPrime: number, durationS: number): number {
  if (durationS <= 0 || cs <= 0) return 0;
  return cs + dPrime / durationS;
}

/** Durée maximale soutenable à une vitesse donnée, au-dessus de CS. */
export function timeToExhaustion(cs: number, dPrime: number, speedMs: number): number {
  if (speedMs <= cs) return Infinity;
  return dPrime / (speedMs - cs);
}

/**
 * Bilan de D' au fil de l'effort (« W'bal »), forme différentielle de
 * Froncioni-Skiba : la réserve se vide proportionnellement au dépassement de CS
 * et se recharge d'autant plus vite qu'on est loin en dessous.
 *
 * Sert à savoir si un fractionné a réellement touché la réserve anaérobie ou
 * si les récupérations étaient trop généreuses.
 */
export function wPrimeBalance(
  speeds: readonly number[],
  cs: number,
  dPrime: number,
  dt = 1,
): number[] {
  const out = new Array<number>(speeds.length);
  if (cs <= 0 || dPrime <= 0) return out.fill(dPrime);
  let bal = dPrime;
  for (let i = 0; i < speeds.length; i++) {
    const v = speeds[i] as number;
    if (!Number.isFinite(v)) {
      out[i] = bal;
      continue;
    }
    if (v > cs) {
      bal -= (v - cs) * dt;
    } else {
      // Recharge asymptotique vers D', d'autant plus rapide que l'écart à CS est grand.
      bal += (cs - v) * ((dPrime - bal) / dPrime) * dt;
    }
    bal = clamp(bal, -dPrime * 0.2, dPrime);
    out[i] = bal;
  }
  return out;
}

/**
 * Ancrage sur le test de laboratoire. Une VMA de 20 km/h et un SV2 à 16,8 km/h
 * impliquent une CS proche du SV2 : la littérature situe CS entre le seuil
 * ventilatoire 2 et ~3 % au-dessus. On s'en sert comme prior quand le terrain
 * ne fournit pas encore assez de points.
 */
export function csPriorFromThresholds(vt2SpeedMs: number, vmaMs: number): {
  criticalSpeedMs: number;
  dPrimeM: number;
} {
  const cs = vt2SpeedMs * 1.02;
  // D' typique d'un coureur d'endurance entraîné : 150-250 m.
  // On l'échelonne sur l'écart VMA-CS, qui mesure la réserve « vitesse ».
  const reserve = Math.max(0, vmaMs - cs);
  const dPrime = clamp(120 + reserve * 130, 100, 320);
  return { criticalSpeedMs: cs, dPrimeM: dPrime };
}

/**
 * Fusion bayésienne simple entre l'ajustement terrain et le prior laboratoire,
 * pondérée par la qualité de l'ajustement. Le laboratoire garde du poids tant
 * que le terrain n'a pas produit d'efforts maximaux exploitables.
 */
export function blendCriticalSpeed(
  fit: CriticalSpeedFit,
  prior: { criticalSpeedMs: number; dPrimeM: number },
): { criticalSpeedMs: number; dPrimeM: number; weightField: number } {
  const w =
    fit.quality === 'strong' ? 0.85 : fit.quality === 'usable' ? 0.6 : fit.quality === 'weak' ? 0.25 : 0;
  if (w === 0 || fit.criticalSpeedMs <= 0) {
    return { ...prior, weightField: 0 };
  }
  return {
    criticalSpeedMs: fit.criticalSpeedMs * w + prior.criticalSpeedMs * (1 - w),
    dPrimeM: fit.dPrimeM * w + prior.dPrimeM * (1 - w),
    weightField: w,
  };
}

/** Vitesse prédite à une durée, en s'appuyant d'abord sur la courbe observée. */
export function speedAtDuration(
  curve: MmpCurve,
  fit: { criticalSpeedMs: number; dPrimeM: number },
  durationS: number,
): number {
  const observed = interpolateCurve(curve, durationS);
  const modelled = predictSpeed(fit.criticalSpeedMs, fit.dPrimeM, durationS);
  if (observed == null) return modelled;
  // On retient le max : la courbe observée est un plancher de capacité.
  return Math.max(observed, modelled * 0.97);
}
