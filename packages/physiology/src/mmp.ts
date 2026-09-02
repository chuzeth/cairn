/**
 * Courbes maximales moyennes (« mean-maximal curves »).
 *
 * Pour chaque durée de référence, la meilleure moyenne jamais soutenue sur cette
 * durée. Appliquée à la vitesse corrigée de la pente, elle donne la signature
 * puissance-durée de l'athlète ; appliquée à la vitesse ascensionnelle, elle
 * donne sa courbe de grimpeur.
 *
 * Implémentation en O(n·d) via sommes préfixées — indispensable pour traiter
 * des années d'activités à 1 Hz sans ramer.
 */

/** Durées de référence, en secondes. De l'effort neuromusculaire à l'ultra. */
export const MMP_DURATIONS = [
  5, 10, 15, 20, 30, 45,
  60, 90, 120, 180, 240, 300, 420, 600, 720, 900, 1200, 1800,
  2400, 3600, 5400, 7200, 10800, 14400, 21600, 28800, 43200,
] as const;

export type MmpCurve = Record<string, number>;

/**
 * Meilleure moyenne d'un signal sur chaque durée.
 *
 * @param values  Signal échantillonné à 1 Hz (vitesse, VAM, puissance…).
 * @param durations Durées à évaluer, en secondes.
 * @param mode  `'mean'` pour une moyenne classique, `'accumulate'` quand le
 *              signal est un débit dont on veut le cumul rapporté à la durée
 *              (identique mathématiquement, conservé pour la lisibilité).
 */
export function meanMaximal(
  values: readonly number[],
  durations: readonly number[] = MMP_DURATIONS,
): MmpCurve {
  const n = values.length;
  const out: MmpCurve = {};
  if (n === 0) return out;

  // Somme préfixée : prefix[i] = Σ values[0..i-1]
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = values[i] as number;
    prefix[i + 1] = (prefix[i] as number) + (Number.isFinite(v) ? v : 0);
  }

  for (const d of durations) {
    const w = Math.round(d);
    if (w <= 0 || w > n) continue;
    let best = -Infinity;
    for (let i = 0; i + w <= n; i++) {
      const sum = (prefix[i + w] as number) - (prefix[i] as number);
      if (sum > best) best = sum;
    }
    if (Number.isFinite(best)) out[String(w)] = best / w;
  }
  return out;
}

/**
 * Signal associé, moyenné sur la fenêtre qui a produit chaque maximum.
 *
 * Une courbe maximale dit *ce qui a été tenu*, jamais *à quel prix*. En passant
 * la fréquence cardiaque comme signal associé, on récupère pour chaque durée la
 * contrepartie cardiaque du point retenu — ce qui permet ensuite de distinguer
 * un effort maximal d'une sortie en aisance particulièrement régulière.
 */
export function companionAtMeanMaximal(
  values: readonly number[],
  companion: readonly (number | null | undefined)[],
  durations: readonly number[] = MMP_DURATIONS,
): MmpCurve {
  const n = values.length;
  const out: MmpCurve = {};
  if (n === 0) return out;

  const prefix = new Float64Array(n + 1);
  const cSum = new Float64Array(n + 1);
  const cCount = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = values[i] as number;
    prefix[i + 1] = (prefix[i] as number) + (Number.isFinite(v) ? v : 0);
    const c = companion[i];
    const ok = c != null && Number.isFinite(c);
    cSum[i + 1] = (cSum[i] as number) + (ok ? (c as number) : 0);
    cCount[i + 1] = (cCount[i] as number) + (ok ? 1 : 0);
  }

  for (const d of durations) {
    const w = Math.round(d);
    if (w <= 0 || w > n) continue;
    let best = -Infinity;
    let at = -1;
    for (let i = 0; i + w <= n; i++) {
      const sum = (prefix[i + w] as number) - (prefix[i] as number);
      if (sum > best) {
        best = sum;
        at = i;
      }
    }
    if (at < 0) continue;
    const count = (cCount[at + w] as number) - (cCount[at] as number);
    // Une moyenne calculée sur quelques échantillons ne qualifie pas un effort :
    // sans couverture large, on préfère ne rien dire.
    if (count < w * 0.8) continue;
    out[String(w)] = ((cSum[at + w] as number) - (cSum[at] as number)) / count;
  }
  return out;
}

/**
 * Meilleur temps sur des distances de référence, à partir du flux de distance
 * cumulée (réelle ou corrigée de la pente). Deux pointeurs, O(n).
 */
export function bestTimeForDistances(
  cumulativeDistance: readonly number[],
  distances: readonly number[],
): Record<string, number> {
  const out: Record<string, number> = {};
  const n = cumulativeDistance.length;
  if (n < 2) return out;

  for (const target of distances) {
    let best = Infinity;
    let lo = 0;
    for (let hi = 0; hi < n; hi++) {
      const dHi = cumulativeDistance[hi] as number;
      while (lo < hi && dHi - (cumulativeDistance[lo] as number) >= target) {
        const dt = hi - lo;
        if (dt < best) best = dt;
        lo++;
      }
    }
    if (Number.isFinite(best)) out[String(target)] = best;
  }
  return out;
}

/**
 * Enveloppe de plusieurs courbes : la meilleure valeur observée, toutes
 * activités confondues, sur une fenêtre glissante (typiquement 90 jours).
 */
export function envelopeCurve(curves: readonly MmpCurve[]): MmpCurve {
  const out: MmpCurve = {};
  for (const c of curves) {
    for (const [k, v] of Object.entries(c)) {
      const prev = out[k];
      if (prev === undefined || v > prev) out[k] = v;
    }
  }
  return out;
}

/**
 * Enveloppe pondérée par la fraîcheur : une performance de la semaine dernière
 * pèse plus qu'une performance d'il y a trois mois. Décroissance exponentielle
 * de demi-vie `halfLifeDays`.
 */
export function decayedEnvelope(
  entries: readonly { curve: MmpCurve; ageDays: number }[],
  halfLifeDays = 60,
): MmpCurve {
  return decayedEnvelopeWithCompanion(entries, halfLifeDays).curve;
}

/**
 * Même enveloppe, en conservant pour chaque durée la valeur du signal associé
 * (`companion`) de l'activité qui a fourni le point retenu. Sans cela,
 * l'enveloppe perd la trace de *comment* chaque point a été produit — et un
 * ajustement ne peut plus distinguer une mesure d'une régularité.
 */
export function decayedEnvelopeWithCompanion(
  entries: readonly { curve: MmpCurve; companion?: MmpCurve; ageDays: number }[],
  halfLifeDays = 60,
): { curve: MmpCurve; companion: MmpCurve } {
  const curve: MmpCurve = {};
  const companion: MmpCurve = {};
  for (const entry of entries) {
    const w = Math.pow(0.5, Math.max(0, entry.ageDays) / halfLifeDays);
    for (const [k, v] of Object.entries(entry.curve)) {
      const adjusted = v * (0.85 + 0.15 * w); // pénalise doucement les vieilles perfs
      const prev = curve[k];
      if (prev !== undefined && adjusted <= prev) continue;
      curve[k] = adjusted;
      const c = entry.companion?.[k];
      if (c === undefined) delete companion[k];
      else companion[k] = c;
    }
  }
  return { curve, companion };
}

/** Rend la courbe monotone décroissante : une durée plus longue ne peut pas être plus rapide. */
export function monotonize(curve: MmpCurve): MmpCurve {
  const keys = Object.keys(curve)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const out: MmpCurve = {};
  let ceiling = Infinity;
  for (const k of keys) {
    const v = Math.min(curve[String(k)] as number, ceiling);
    out[String(k)] = v;
    ceiling = v;
  }
  return out;
}

/** Valeur de la courbe à une durée arbitraire, par interpolation log-linéaire. */
export function interpolateCurve(curve: MmpCurve, durationS: number): number | null {
  const keys = Object.keys(curve).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (keys.length === 0) return null;
  const first = keys[0] as number;
  const last = keys[keys.length - 1] as number;
  if (durationS <= first) return curve[String(first)] as number;
  if (durationS >= last) return curve[String(last)] as number;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i] as number;
    if (durationS <= b) {
      const a = keys[i - 1] as number;
      const va = curve[String(a)] as number;
      const vb = curve[String(b)] as number;
      const t = (Math.log(durationS) - Math.log(a)) / (Math.log(b) - Math.log(a));
      return va + (vb - va) * t;
    }
  }
  return curve[String(last)] as number;
}
