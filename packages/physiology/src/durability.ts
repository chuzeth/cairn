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
  /**
   * Perte de rendement en % par 1 000 m de D+ cumulé, à temps écoulé égal.
   * `null` quand la séance ne la sépare pas du temps (`MAX_TIME_VERT_CORRELATION`).
   */
  pctPer1000mVert: number | null;
  /** Perte de rendement en % par heure d'effort. */
  pctPerHour: number | null;
  /** Rendement initial (référence de la régression). */
  baselineEf: number | null;
  windows: DurabilityWindow[];
  sampleQuality: 'good' | 'partial' | 'insufficient';
  /** Coefficient de détermination de la régression temporelle. */
  r2Time: number;
  /**
   * Corrélation entre temps écoulé et D+ cumulé sur les fenêtres. Absente ou
   * nulle, rien ne prouve que la pente verticale mesure autre chose que le temps.
   */
  timeVertCorrelation?: number | null;
}

const WINDOW_S = 600;
const STEP_S = 120;

/**
 * Ce qu'un effort doit contenir pour qu'on puisse y *mesurer* la durabilité.
 *
 * Ces bornes ne sont pas un avis d'entraîneur : elles se déduisent de la
 * fenêtre glissante ci-dessus. Un agrégat de qualité `good` réclame dix
 * fenêtres et plus d'une heure entre la première et la dernière — soit
 * 3 600 s d'écart entre centres, plus la largeur d'une fenêtre : 70 min
 * d'effort aérobie continu. La pente verticale, elle, exige plus de 350 m de
 * D+ accumulés entre ces deux centres ; 450 m sur la séance entière les
 * couvrent avec de la marge. C'est nécessaire, pas suffisant : un D+ qui
 * s'accumule au rythme du temps ne mesure que la perte horaire
 * (`MAX_TIME_VERT_CORRELATION`).
 *
 * Elles servent au planificateur : une préparation qui ne produit jamais un
 * effort de cette forme laisse la durabilité au repli de population, et la
 * prédiction de course avec elle.
 */
export const DURABILITY_MEASURABLE = {
  minDurationS: 70 * 60,
  minVertM: 450,
} as const;

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

/** Corrélation de Pearson ; `null` quand l'une des deux séries ne varie pas. */
function correlation(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
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
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Régression sur deux variables à la fois : la pente de chacune à l'autre
 * constante. `null` quand les deux se confondent.
 */
function linreg2(
  x1: readonly number[],
  x2: readonly number[],
  ys: readonly number[],
): { intercept: number; slope1: number; slope2: number } | null {
  const n = ys.length;
  if (n < 4) return null;
  const m1 = x1.reduce((a, b) => a + b, 0) / n;
  const m2 = x2.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let s11 = 0;
  let s22 = 0;
  let s12 = 0;
  let s1y = 0;
  let s2y = 0;
  for (let i = 0; i < n; i++) {
    const d1 = (x1[i] as number) - m1;
    const d2 = (x2[i] as number) - m2;
    const dy = (ys[i] as number) - my;
    s11 += d1 * d1;
    s22 += d2 * d2;
    s12 += d1 * d2;
    s1y += d1 * dy;
    s2y += d2 * dy;
  }
  const det = s11 * s22 - s12 * s12;
  if (!(det > 1e-12)) return null;
  const slope1 = (s1y * s22 - s2y * s12) / det;
  const slope2 = (s2y * s11 - s1y * s12) / det;
  return { intercept: my - slope1 * m1 - slope2 * m2, slope1, slope2 };
}

/**
 * Corrélation temps / D+ cumulé au-delà de laquelle une séance ne mesure pas le
 * dénivelé indépendamment du temps.
 *
 * Quand le D+ s'accumule au rythme du temps — une rando-course, une sortie
 * vallonnée régulière —, la pente par 1 000 m n'est que la perte horaire
 * réexprimée : la régression ne peut pas séparer les deux causes, et la variance
 * de la pente propre au dénivelé est multipliée par 1 / (1 − ρ²), plus de cinq
 * au-delà de ce seuil. Sur les 49 séances de Pierre analysées au 13/09/2026, ρ va
 * de 0,82 à 0,995, et ne descend jamais sous 0,90 sur celles qui franchissent
 * assez de D+ pour produire une pente : aucune ne mesure le dénivelé à part.
 */
export const MAX_TIME_VERT_CORRELATION = Math.sqrt(1 - 1 / 5);

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
      timeVertCorrelation: null,
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

  // La pente verticale est celle que le dénivelé a à temps écoulé constant, et
  // seulement quand la séance les sépare : une régression sur le seul D+
  // d'une sortie qui monte régulièrement redisait la perte horaire en d'autres
  // unités, et cette pente-là passait pour une mesure du dénivelé.
  const timeVertCorrelation = correlation(hours, verts);
  let pctPer1000mVert: number | null = null;
  if (
    spanVert > 0.35 &&
    timeVertCorrelation != null &&
    Math.abs(timeVertCorrelation) <= MAX_TIME_VERT_CORRELATION
  ) {
    const joint = linreg2(hours, verts, efs);
    const vBase = joint && joint.intercept > 0 ? joint.intercept : baseline;
    if (joint && vBase > 0) pctPer1000mVert = Math.round((-joint.slope2 / vBase) * 1000) / 10;
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
    timeVertCorrelation:
      timeVertCorrelation == null ? null : Math.round(timeVertCorrelation * 1000) / 1000,
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
  /**
   * D+ par heure des séances qui ont mesuré la perte horaire, m/h — ce que
   * cette perte contient déjà de dénivelé. `null` quand la perte horaire est un
   * repli, ou qu'aucune séance ne dit ce qu'elle a monté.
   */
  vertRateMh: number | null;
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

/** Une séance versée à l'agrégat. */
export interface DurabilityEntry {
  result: DurabilityResult;
  ageDays: number;
  durationS: number;
  /** D+ de la séance, m : situe la perte horaire qu'elle a mesurée. */
  vertM?: number;
}

/** Une pente verticale ne compte que si sa séance la sépare du temps, preuve à l'appui. */
const separatesVertFromTime = (r: DurabilityResult): boolean =>
  r.pctPer1000mVert != null &&
  r.timeVertCorrelation != null &&
  Math.abs(r.timeVertCorrelation) <= MAX_TIME_VERT_CORRELATION;

/**
 * Agrégation sur l'historique. On pondère par la qualité de l'échantillon, la
 * durée couverte et la fraîcheur, et on écarte les valeurs aberrantes (une
 * séance par 34 °C ne dit rien de la durabilité intrinsèque).
 *
 * La pente verticale ne s'agrège que sur les séances qui la séparent du temps.
 * Une analyse qui ne porte pas la corrélation — antérieure au moteur 1.3.0 — ne
 * le prouve pas : sa pente ne compte pas, plutôt que de faire passer la perte
 * horaire réexprimée pour une mesure du dénivelé.
 */
export function aggregateDurability(entries: readonly DurabilityEntry[]): DurabilityAggregate {
  const usable = entries.filter(
    (e) => e.result.sampleQuality !== 'insufficient' && e.result.pctPerHour != null,
  );

  if (usable.length === 0) {
    return {
      pctPer1000mVert: DEFAULT_PCT_PER_1000M_VERT,
      pctPerHour: DEFAULT_PCT_PER_HOUR,
      vertRateMh: null,
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

  const weightedMedian = (
    values: { v: number; w: number }[],
    plausible: (v: number) => boolean = (v) => Math.abs(v) < 40,
  ): number | null => {
    const clean = values.filter((x) => Number.isFinite(x.v) && plausible(x.v));
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
      .filter((e) => separatesVertFromTime(e.result))
      .map((e) => ({ v: e.result.pctPer1000mVert as number, w: weightOf(e) })),
  );
  const vertRate = weightedMedian(
    usable
      .filter((e) => e.vertM != null && Number.isFinite(e.vertM) && e.durationS > 0)
      .map((e) => ({ v: ((e.vertM as number) / e.durationS) * 3600, w: weightOf(e) })),
    (v) => v >= 0,
  );

  const totalWeight = usable.reduce((a, e) => a + weightOf(e), 0);
  const confidence = clamp(totalWeight / 8, 0.15, 0.95);

  const hour = resolveAggregate(perHour, PER_HOUR_BOUNDS, DEFAULT_PCT_PER_HOUR);
  const vert = resolveAggregate(perVert, PER_VERT_BOUNDS, DEFAULT_PCT_PER_1000M_VERT);

  return {
    pctPerHour: hour.value,
    pctPer1000mVert: vert.value,
    // Le rythme décrit les séances de la perte horaire : il n'a de sens que si
    // c'est elle qui est retenue, et non le repli.
    vertRateMh: hour.measured && vertRate != null ? Math.round(vertRate) : null,
    // La confiance décrit ce qu'on a mesuré : elle tombe au plancher si les deux
    // valeurs retenues sont des replis.
    confidence:
      hour.measured || vert.measured ? Math.round(confidence * 100) / 100 : 0.15,
    n: usable.length,
    measured: { perHour: hour.measured, perVert: vert.measured },
    raw: { perHour, perVert },
  };
}

/** Ce que la durabilité retient d'un modèle. */
export interface DurabilityTerms {
  pctPerHour: number;
  pctPer1000mVert: number;
  /** D+ par heure que la perte horaire contient déjà, m/h. Absent : aucun. */
  vertRateMh?: number;
}

/**
 * Dénivelé qui s'ajoute à la perte horaire, m.
 *
 * Une perte horaire mesurée sur des sorties qui montent à 300 m/h contient ce
 * que ces 300 m/h ont coûté. Sur un effort qui monte au même rythme, la perte
 * par 1 000 m n'en est que la réexpression : seul le dénivelé au-delà de ce
 * rythme est indépendant du temps. En deçà, rien n'est rendu — la part de la
 * perte horaire qui revient au dénivelé n'est mesurée nulle part, et une borne
 * ne se relâche pas sur une supposition.
 */
export function independentVertM(elapsedS: number, cumulativeVertM: number, vertRateMh = 0): number {
  const carried = (Math.max(0, vertRateMh) * Math.max(0, elapsedS)) / 3600;
  return Math.max(0, cumulativeVertM - carried);
}

/**
 * Part de la capacité fraîche qui reste à un instant donné de l'effort.
 *
 * Les deux pertes s'additionnent parce que chacune ne compte que ce qu'elle a
 * d'indépendant : la perte horaire tout le temps écoulé, la perte verticale le
 * seul dénivelé que la première ne contient pas. La racine quadratique qui
 * tenait lieu de recouvrement rendait, pour deux termes qui disent la même
 * perte, √3 fois cette perte.
 */
/**
 * Plancher de la décroissance : en deçà, le modèle linéaire n'a plus de sens.
 *
 * Il est exporté parce qu'une projection qui l'atteint doit le savoir. Une
 * estimation arrivée à sa borne de sécurité n'est pas une mesure : la traiter
 * comme telle propagerait silencieusement une droite devenue plate jusqu'à la
 * prédiction de course.
 */
export const DURABILITY_FLOOR = 0.45;

export function durabilityFactor(
  elapsedS: number,
  cumulativeVertM: number,
  model: DurabilityTerms,
): number {
  const timeDecay = (model.pctPerHour / 100) * (elapsedS / 3600);
  const vertDecay =
    (model.pctPer1000mVert / 100) *
    (independentVertM(elapsedS, cumulativeVertM, model.vertRateMh) / 1000);
  return clamp(1 - timeDecay - vertDecay, DURABILITY_FLOOR, 1);
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
  model: DurabilityTerms,
): number {
  return cs * durabilityFactor(elapsedS, cumulativeVertM, model);
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
