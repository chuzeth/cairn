import { gradeAdjustedSpeed } from './grade.js';
import { clamp, mean } from './units.js';

/**
 * Durabilité — la résistance à la fatigue.
 *
 * Deux athlètes peuvent partager la même VO2max et la même vitesse critique et
 * finir un 50 km à une heure d'écart. Ce qui les sépare n'est pas leur plafond
 * mais la vitesse à laquelle ce plafond s'effondre au fil de l'effort.
 * La littérature récente (Maunder, Jones, Muniz-Pumares) en a fait la troisième
 * dimension de la performance d'endurance, après VO2max et économie.
 *
 * Cairn mesure la durabilité de deux façons complémentaires :
 *  · en **intra-séance** : dégradation du rendement (vitesse par battement) au
 *    fil du temps et du dénivelé accumulé ;
 *  · en **inter-séances** : agrégation robuste de ces pentes sur l'historique.
 *
 * C'est cette mesure qui pilote la prédiction de course : sans elle, un modèle
 * de vitesse critique surestime systématiquement les temps sur ultra.
 */

export interface DurabilitySample {
  t: number;
  dt: number;
  speedMs: number;
  grade: number;
  hr: number | null;
  /** Dénivelé positif cumulé jusqu'à cet instant, m. */
  cumulativeVertM: number;
}

export interface DurabilityWindow {
  centerT: number;
  cumulativeVertM: number;
  efficiencyFactor: number;
  avgHr: number;
  avgGradedSpeedMs: number;
}

export interface DurabilityResult {
  /** Perte de rendement en % par 1 000 m de D+ cumulé. */
  pctPer1000mVert: number | null;
  /** Perte de rendement en % par heure d'effort. */
  pctPerHour: number | null;
  /** Rendement initial (référence de la régression). */
  baselineEf: number | null;
  windows: DurabilityWindow[];
  sampleQuality: 'good' | 'partial' | 'insufficient';
  /** Coefficient de détermination de la régression temporelle. */
  r2Time: number;
}

const WINDOW_S = 600;
const STEP_S = 120;

/**
 * Extrait les fenêtres de 10 min exploitables : effort aérobie continu, FC
 * disponible, vitesse crédible. Les fenêtres contenant des arrêts ou du travail
 * supra-seuil sont écartées — elles feraient dire n'importe quoi à la régression.
 */
export function extractDurabilityWindows(
  samples: readonly DurabilitySample[],
  bounds: { hrMin: number; hrMax: number },
): DurabilityWindow[] {
  const out: DurabilityWindow[] = [];
  if (samples.length < WINDOW_S) return out;

  for (let start = 0; start + WINDOW_S <= samples.length; start += STEP_S) {
    const slice = samples.slice(start, start + WINDOW_S);
    const hrs = slice.map((s) => s.hr).filter((h): h is number => h != null && h > 60);
    if (hrs.length < WINDOW_S * 0.9) continue;

    const avgHr = mean(hrs) as number;
    if (avgHr < bounds.hrMin || avgHr > bounds.hrMax) continue;

    const moving = slice.filter((s) => s.speedMs > 0.6);
    if (moving.length < WINDOW_S * 0.9) continue;

    const gap = mean(moving.map((s) => gradeAdjustedSpeed(s.speedMs, s.grade)));
    if (gap == null || gap <= 0) continue;

    out.push({
      centerT: slice[Math.floor(slice.length / 2)]!.t,
      cumulativeVertM: slice[Math.floor(slice.length / 2)]!.cumulativeVertM,
      efficiencyFactor: gap / avgHr,
      avgHr,
      avgGradedSpeedMs: gap,
    });
  }
  return out;
}

/** Régression linéaire simple. Renvoie pente, ordonnée à l'origine et R². */
function linreg(xs: readonly number[], ys: readonly number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 3) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - mx;
    const dy = (ys[i] as number) - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-12) return { slope: 0, intercept: my, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept: my - slope * mx, r2 };
}

/** Mesure la durabilité sur une séance. */
export function analyzeDurability(
  samples: readonly DurabilitySample[],
  bounds: { hrMin: number; hrMax: number },
): DurabilityResult {
  const windows = extractDurabilityWindows(samples, bounds);

  if (windows.length < 4) {
    return {
      pctPer1000mVert: null,
      pctPerHour: null,
      baselineEf: windows[0]?.efficiencyFactor ?? null,
      windows,
      sampleQuality: 'insufficient',
      r2Time: 0,
    };
  }

  const efs = windows.map((w) => w.efficiencyFactor);
  const hours = windows.map((w) => w.centerT / 3600);
  const verts = windows.map((w) => w.cumulativeVertM / 1000);

  const timeFit = linreg(hours, efs);
  const baseline = timeFit.intercept > 0 ? timeFit.intercept : (efs[0] as number);

  const spanHours = (hours[hours.length - 1] as number) - (hours[0] as number);
  const spanVert = (verts[verts.length - 1] as number) - (verts[0] as number);

  const pctPerHour = baseline > 0 && spanHours > 0.4
    ? Math.round((-timeFit.slope / baseline) * 1000) / 10
    : null;

  let pctPer1000mVert: number | null = null;
  if (spanVert > 0.35) {
    const vertFit = linreg(verts, efs);
    const vBase = vertFit.intercept > 0 ? vertFit.intercept : (efs[0] as number);
    if (vBase > 0) pctPer1000mVert = Math.round((-vertFit.slope / vBase) * 1000) / 10;
  }

  const quality: DurabilityResult['sampleQuality'] =
    windows.length >= 10 && spanHours > 1 ? 'good' : windows.length >= 6 ? 'partial' : 'insufficient';

  return {
    pctPer1000mVert,
    pctPerHour,
    baselineEf: Math.round(baseline * 100000) / 100000,
    windows,
    sampleQuality: quality,
    r2Time: Math.round(timeFit.r2 * 1000) / 1000,
  };
}

/**
 * Bornes de plausibilité de l'agrégat, et valeurs de repli issues de la
 * littérature pour un coureur entraîné.
 *
 * Ces bornes sont un garde-fou, pas une échelle : un agrégat qui les atteint
 * signale que la régression n'a pas convergé sur un signal exploitable. Le
 * ramener à la borne produirait un nombre d'apparence mesurée qui contaminerait
 * la prédiction de course — on lui préfère explicitement le repli.
 */
const PER_HOUR_BOUNDS: readonly [number, number] = [0, 15];
const PER_VERT_BOUNDS: readonly [number, number] = [0, 20];
const DEFAULT_PCT_PER_HOUR = 3.0;
const DEFAULT_PCT_PER_1000M_VERT = 4.0;

export interface DurabilityAggregate {
  pctPer1000mVert: number;
  pctPerHour: number;
  confidence: number;
  n: number;
  /** Vrai quand la valeur retenue vient d'une mesure, faux quand elle vient du repli. */
  measured: { perHour: boolean; perVert: boolean };
  /** Agrégat brut avant repli — `null` si aucune séance ne l'a produit. */
  raw: { perHour: number | null; perVert: number | null };
}

/**
 * Retient l'agrégat brut s'il est strictement à l'intérieur des bornes ; sinon
 * bascule sur le repli en le disant.
 */
function resolveAggregate(
  raw: number | null,
  bounds: readonly [number, number],
  fallback: number,
): { value: number; measured: boolean } {
  if (raw == null || !Number.isFinite(raw)) return { value: fallback, measured: false };
  if (raw <= bounds[0] || raw >= bounds[1]) return { value: fallback, measured: false };
  return { value: raw, measured: true };
}

/**
 * Agrégation sur l'historique. On pondère par la qualité de l'échantillon, la
 * durée couverte et la fraîcheur, et on écarte les valeurs aberrantes (une
 * séance par 34 °C ne dit rien de la durabilité intrinsèque).
 */
export function aggregateDurability(
  entries: readonly { result: DurabilityResult; ageDays: number; durationS: number }[],
): DurabilityAggregate {
  const usable = entries.filter(
    (e) => e.result.sampleQuality !== 'insufficient' && e.result.pctPerHour != null,
  );

  if (usable.length === 0) {
    return {
      pctPer1000mVert: DEFAULT_PCT_PER_1000M_VERT,
      pctPerHour: DEFAULT_PCT_PER_HOUR,
      confidence: 0.15,
      n: 0,
      measured: { perHour: false, perVert: false },
      raw: { perHour: null, perVert: null },
    };
  }

  const weightOf = (e: (typeof usable)[number]) =>
    Math.pow(0.5, e.ageDays / 90) *
    (e.result.sampleQuality === 'good' ? 1 : 0.5) *
    clamp(e.durationS / 5400, 0.3, 1.5);

  const weightedMedian = (values: { v: number; w: number }[]): number | null => {
    const clean = values.filter((x) => Number.isFinite(x.v) && Math.abs(x.v) < 40);
    if (clean.length === 0) return null;
    clean.sort((a, b) => a.v - b.v);
    const total = clean.reduce((a, x) => a + x.w, 0);
    let acc = 0;
    for (const x of clean) {
      acc += x.w;
      if (acc >= total / 2) return x.v;
    }
    return clean[clean.length - 1]!.v;
  };

  const perHour = weightedMedian(
    usable.map((e) => ({ v: e.result.pctPerHour as number, w: weightOf(e) })),
  );
  const perVert = weightedMedian(
    usable
      .filter((e) => e.result.pctPer1000mVert != null)
      .map((e) => ({ v: e.result.pctPer1000mVert as number, w: weightOf(e) })),
  );

  const totalWeight = usable.reduce((a, e) => a + weightOf(e), 0);
  const confidence = clamp(totalWeight / 8, 0.15, 0.95);

  const hour = resolveAggregate(perHour, PER_HOUR_BOUNDS, DEFAULT_PCT_PER_HOUR);
  const vert = resolveAggregate(perVert, PER_VERT_BOUNDS, DEFAULT_PCT_PER_1000M_VERT);

  return {
    pctPerHour: hour.value,
    pctPer1000mVert: vert.value,
    // La confiance décrit ce qu'on a mesuré : elle tombe au plancher si les deux
    // valeurs retenues sont des replis.
    confidence:
      hour.measured || vert.measured ? Math.round(confidence * 100) / 100 : 0.15,
    n: usable.length,
    measured: { perHour: hour.measured, perVert: vert.measured },
    raw: { perHour, perVert },
  };
}

/**
 * Vitesse critique corrigée de la durabilité à un instant donné de l'effort.
 * C'est le cœur de la prédiction sur trail long : la CS du kilomètre 60 n'est
 * pas celle du départ.
 */
export function durabilityAdjustedCs(
  cs: number,
  elapsedS: number,
  cumulativeVertM: number,
  model: { pctPerHour: number; pctPer1000mVert: number },
): number {
  const timeDecay = (model.pctPerHour / 100) * (elapsedS / 3600);
  const vertDecay = (model.pctPer1000mVert / 100) * (cumulativeVertM / 1000);
  // Les deux causes se recouvrent partiellement : on évite de double-compter en
  // prenant la racine quadratique de leur somme plutôt que la somme brute.
  const combined = Math.sqrt(timeDecay ** 2 + vertDecay ** 2 + timeDecay * vertDecay);
  return cs * clamp(1 - combined, 0.45, 1);
}

/** Lecture qualitative de la durabilité, comparée à des repères de terrain. */
export function interpretDurability(pctPerHour: number): {
  tier: 'elite' | 'strong' | 'moyen' | 'fragile';
  message: string;
} {
  if (pctPerHour < 1.5)
    return { tier: 'elite', message: 'Durabilité de niveau élite : le rendement tient remarquablement dans la durée.' };
  if (pctPerHour < 3)
    return { tier: 'strong', message: 'Bonne durabilité : profil adapté aux formats longs.' };
  if (pctPerHour < 5)
    return { tier: 'moyen', message: 'Durabilité moyenne : gisement de progression majeur pour les formats > 3 h.' };
  return {
    tier: 'fragile',
    message: 'Durabilité faible : le rendement chute vite. Priorité au volume aérobie et aux sorties longues spécifiques.',
  };
}
