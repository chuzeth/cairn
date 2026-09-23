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
 *
 * Exportée : un effort maximal plus court que la fenêtre ne mesure pas la
 * vitesse critique, et le planificateur ne le compte pas comme un test.
 */
export const CS_FIT_MIN_S = 120;
export const CS_FIT_MAX_S = 1200;

/** Ajuste CS et D' par régression linéaire de la distance sur le temps. */
export function fitCriticalSpeed(curve: MmpCurve): CriticalSpeedFit {
  const points = Object.entries(curve)
    .map(([k, v]) => ({ durationS: Number(k), speedMs: v }))
    .filter(
      (p) =>
        Number.isFinite(p.durationS) &&
        Number.isFinite(p.speedMs) &&
        p.speedMs > 0 &&
        p.durationS >= CS_FIT_MIN_S &&
        p.durationS <= CS_FIT_MAX_S,
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
 * Plancher du bilan : au-delà, la réserve n'est plus une réserve.
 *
 * Elle descend un peu sous zéro parce que le modèle est un ajustement, pas une
 * comptabilité exacte — mais l'épuisement, lui, est à zéro.
 */
const W_PRIME_FLOOR = -0.2;

/**
 * Bilan de D' après un segment couru à vitesse constante — forme intégrée de
 * Froncioni-Skiba.
 *
 * Au-dessus de CS, la réserve se vide au rythme exact du dépassement. En
 * dessous, elle se recharge vers D' de façon asymptotique, d'autant plus vite
 * qu'on est loin sous CS : dB/dt = (CS − v)·(D' − B)/D', dont la solution est
 * une exponentielle. L'intégrer fermée plutôt que pas à pas, c'est pouvoir
 * juger une séance sur ses segments — vingt blocs au lieu de dix mille
 * secondes — sans que la réponse dépende du pas choisi.
 *
 * C'est le même modèle que la série seconde par seconde : `wPrimeBalance`
 * passe par ici. Deux implémentations du même bilan, ce serait deux verdicts
 * possibles sur la même séance.
 */
export function wPrimeAfter(
  balanceM: number,
  speedMs: number,
  cs: number,
  dPrime: number,
  durationS: number,
): number {
  if (!(dPrime > 0) || !(durationS > 0)) return balanceM;
  if (!Number.isFinite(speedMs) || !(cs > 0)) return balanceM;
  const next =
    speedMs > cs
      ? balanceM - (speedMs - cs) * durationS
      : dPrime - (dPrime - balanceM) * Math.exp((-(cs - speedMs) * durationS) / dPrime);
  return clamp(next, dPrime * W_PRIME_FLOOR, dPrime);
}

/**
 * Bilan de D' au fil de l'effort (« W'bal »), échantillon par échantillon.
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
    bal = wPrimeAfter(bal, speeds[i] as number, cs, dPrime, dt);
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
 * Demi-vie d'une preuve d'effort maximal, en jours.
 *
 * Plus courte que celle d'un test de laboratoire (270 j) — la forme bouge —, plus
 * longue que la pondération de fraîcheur de l'enveloppe (60 j) : un maximum
 * démontré reste une information sur ce que la physiologie de l'athlète sait
 * produire, même quand la performance elle-même n'est plus d'actualité.
 */
export const PROOF_HALF_LIFE_DAYS = 90;

export interface MaximalEffortSupport {
  /** Part de l'ajustement adossée à une preuve d'effort maximal, 0–1, âge compris. */
  support: number;
  /** Durée cumulée des points prouvés, pondérée par l'âge de chaque preuve. */
  provenS: number;
  testedS: number;
  untestableS: number;
  /** Âge de la preuve la plus récente, en jours. `null` si aucun point n'est prouvé. */
  lastProofAgeDays: number | null;
  /** Le point prouvé le plus long : l'effort maximal le plus proche de l'asymptote. */
  longestProof: { durationS: number; speedMs: number; ageDays: number } | null;
}

/**
 * Preuve d'effort maximal.
 *
 * Le r² ne mesure pas l'intention : une sortie en aisance est régulière, donc
 * parfaitement ajustée. La signature d'un effort réellement conduit à la vitesse
 * critique est cardiaque — il se déroule au voisinage du seuil 2, donc à une FC
 * moyenne au moins égale à la FC du SV2 sur toute sa durée, ce qu'aucun footing
 * ne produit jamais.
 *
 * On mesure donc la part de l'ajustement portée par de tels points, pondérée par
 * la durée : c'est le bout long de la courbe qui fixe l'asymptote, donc c'est là
 * que la preuve compte. Un point sans FC n'est ni prouvé ni réfuté : il sort du
 * calcul, et si aucun point n'est testable le critère se tait plutôt que de
 * conclure (`support` = 1).
 *
 * Une preuve a une durée de vie : ce que l'athlète tenait au seuil il y a trois
 * mois atteste moins bien de sa capacité d'aujourd'hui que sa séance de la
 * semaine dernière. Chaque preuve est donc escomptée exponentiellement selon son
 * âge, ce qui fait décroître `support` de façon continue au lieu de s'effondrer
 * le jour où la séance qui la portait sort de la fenêtre d'observation.
 */
export function maximalEffortSupport(
  fit: CriticalSpeedFit,
  hrAtBest: Record<string, number>,
  thresholdHr: number,
  ageDaysAtBest: Record<string, number> = {},
  halfLifeDays = PROOF_HALF_LIFE_DAYS,
): MaximalEffortSupport {
  let provenS = 0;
  let testedS = 0;
  let untestableS = 0;
  let lastProofAgeDays: number | null = null;
  let longestProof: MaximalEffortSupport['longestProof'] = null;

  for (const p of fit.points) {
    const hr = hrAtBest[String(p.durationS)];
    if (hr == null || !Number.isFinite(hr) || hr <= 0 || !(thresholdHr > 0)) {
      untestableS += p.durationS;
      continue;
    }
    testedS += p.durationS;
    if (hr < thresholdHr) continue;

    const age = Math.max(0, ageDaysAtBest[String(p.durationS)] ?? 0);
    provenS += p.durationS * Math.pow(0.5, age / halfLifeDays);
    if (lastProofAgeDays == null || age < lastProofAgeDays) lastProofAgeDays = age;
    if (longestProof == null || p.durationS > longestProof.durationS) {
      longestProof = { durationS: p.durationS, speedMs: p.speedMs, ageDays: age };
    }
  }

  return {
    support: testedS > 0 ? provenS / testedS : 1,
    provenS,
    testedS,
    untestableS,
    lastProofAgeDays,
    longestProof,
  };
}

/**
 * Fusion bayésienne simple entre l'ajustement terrain et le prior laboratoire.
 *
 * Le poids du terrain est le produit de deux choses distinctes : la qualité de
 * l'ajustement — sa régularité — et la preuve que les efforts ajustés étaient
 * maximaux. Sans la seconde, la première ne mesure que la constance de l'allure.
 *
 * Mais le laboratoire ne récupère pas pour autant tout ce que le terrain ne
 * prouve pas : il vieillit lui aussi, et `labWeight` chiffre déjà cette
 * obsolescence. Il ne réclame donc du reliquat que la part que sa fraîcheur lui
 * laisse ; le solde retombe sur l'ajustement terrain, qui même non prouvé reste
 * un plancher — l'athlète a réellement tenu ces allures. Sans cette règle, un
 * test d'effort de treize mois reprend la main entière dès que la dernière preuve
 * de terrain s'efface, et impose une vitesse critique que rien d'observé ne
 * soutient.
 */
export function blendCriticalSpeed(
  fit: CriticalSpeedFit,
  prior: { criticalSpeedMs: number; dPrimeM: number },
  maximalEffortSupport = 1,
  labWeight = 1,
): {
  criticalSpeedMs: number;
  dPrimeM: number;
  weightField: number;
  weightLab: number;
  maximalEffortSupport: number;
} {
  const quality =
    fit.quality === 'strong' ? 0.85 : fit.quality === 'usable' ? 0.6 : fit.quality === 'weak' ? 0.25 : 0;
  const support = clamp(Number.isFinite(maximalEffortSupport) ? maximalEffortSupport : 1, 0, 1);
  const wField = quality * support;

  // Sans ajustement exploitable, il n'y a pas de plancher terrain sur lequel
  // retomber : le laboratoire est tout ce qu'on a.
  if (fit.criticalSpeedMs <= 0) {
    return { ...prior, weightField: 0, weightLab: 1, maximalEffortSupport: support };
  }

  const wLab = (1 - wField) * clamp(Number.isFinite(labWeight) ? labWeight : 1, 0, 1);
  return {
    criticalSpeedMs: fit.criticalSpeedMs * (1 - wLab) + prior.criticalSpeedMs * wLab,
    dPrimeM: fit.dPrimeM * (1 - wLab) + prior.dPrimeM * wLab,
    weightField: wField,
    weightLab: wLab,
    maximalEffortSupport: support,
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
