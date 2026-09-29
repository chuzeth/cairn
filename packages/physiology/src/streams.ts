import type { Activity, ActivityStreams, GpsQuality } from '@cairn/core';
import { computeGrade, smoothAltitude } from './grade.js';
import { clamp, movingAverage } from './units.js';

/**
 * Normalisation des flux.
 *
 * Les flux Strava arrivent avec un pas de temps irrégulier (enregistrement
 * « intelligent » des montres), des trous de GPS, du bruit barométrique et des
 * cadences exprimées en cycles plutôt qu'en pas. Tout le moteur en aval suppose
 * un échantillonnage propre à 1 Hz : ce module est le seul endroit où l'on
 * tolère des données sales.
 */

export interface RawStreams {
  time?: number[];
  distance?: number[];
  altitude?: number[];
  velocity_smooth?: number[];
  heartrate?: number[];
  cadence?: number[];
  watts?: number[];
  temp?: number[];
  latlng?: [number, number][];
  moving?: boolean[];
  grade_smooth?: number[];
}

/** Ré-échantillonne un signal sur une grille de temps régulière (maintien de la dernière valeur). */
function resample<T>(
  source: readonly T[] | undefined,
  sourceTime: readonly number[],
  targetTime: readonly number[],
  interpolate: ((a: T, b: T, t: number) => T) | null,
): T[] | undefined {
  if (!source || source.length === 0) return undefined;
  const out = new Array<T>(targetTime.length);
  let j = 0;
  for (let i = 0; i < targetTime.length; i++) {
    const t = targetTime[i] as number;
    while (j < sourceTime.length - 1 && (sourceTime[j + 1] as number) <= t) j++;
    const a = source[Math.min(j, source.length - 1)] as T;
    if (interpolate && j < sourceTime.length - 1 && j + 1 < source.length) {
      const t0 = sourceTime[j] as number;
      const t1 = sourceTime[j + 1] as number;
      const span = t1 - t0;
      const frac = span > 0 ? clamp((t - t0) / span, 0, 1) : 0;
      out[i] = interpolate(a, source[j + 1] as T, frac);
    } else {
      out[i] = a;
    }
  }
  return out;
}

const lerpNum = (a: number, b: number, t: number) => a + (b - a) * t;

export interface NormalizeOptions {
  /** Le seuil sous lequel on considère l'athlète à l'arrêt, m/s. */
  stoppedSpeedMs?: number;
  /** Fenêtre de calcul de la pente, en mètres de distance parcourue. */
  gradeWindowM?: number;
}

export interface NormalizedResult {
  streams: ActivityStreams;
  /** Qualité du signal GPS, jugée sur les coordonnées (`gpsQualityOf`). */
  gpsQuality: GpsQuality;
  /** Part d'échantillons portant une FC exploitable. */
  hrCoverage: number;
  /** Durée réellement en mouvement, s. */
  movingTimeS: number;
  warnings: string[];
}

export function normalizeStreams(raw: RawStreams, opts: NormalizeOptions = {}): NormalizedResult {
  const warnings: string[] = [];
  const stoppedSpeed = opts.stoppedSpeedMs ?? 0.5;

  const srcTime = raw.time && raw.time.length > 1 ? raw.time : null;
  if (!srcTime) {
    return {
      streams: emptyStreams(),
      gpsQuality: 'none',
      hrCoverage: 0,
      movingTimeS: 0,
      warnings: ['Flux temporel absent : activité non analysable finement.'],
    };
  }

  // Grille cible à 1 Hz.
  const duration = Math.round((srcTime[srcTime.length - 1] as number) - (srcTime[0] as number));
  if (duration <= 0) {
    return { streams: emptyStreams(), gpsQuality: 'none', hrCoverage: 0, movingTimeS: 0, warnings: ['Durée nulle.'] };
  }
  if (duration > 172_800) warnings.push('Activité de plus de 48 h : flux tronqué à 48 h.');
  const n = Math.min(duration, 172_800) + 1;
  const t0 = srcTime[0] as number;
  const time = Array.from({ length: n }, (_, i) => i);
  const absTime = time.map((t) => t + t0);

  // ── Distance ───────────────────────────────────────────────────────────────
  let distance = resample(raw.distance, srcTime, absTime, lerpNum) ?? [];
  if (distance.length === 0) {
    warnings.push('Flux de distance absent : reconstruction depuis la vitesse.');
    const v = resample(raw.velocity_smooth, srcTime, absTime, lerpNum) ?? new Array(n).fill(0);
    distance = [0];
    for (let i = 1; i < n; i++) distance.push((distance[i - 1] as number) + (v[i] as number));
  }
  distance = enforceMonotonic(distance);

  // ── Altitude ───────────────────────────────────────────────────────────────
  const rawAlt = resample(raw.altitude, srcTime, absTime, lerpNum);
  const altitude = rawAlt ? smoothAltitude(rawAlt) : new Array<number>(n).fill(0);
  if (!rawAlt) warnings.push("Flux d'altitude absent : analyse verticale indisponible.");

  // ── Vitesse ────────────────────────────────────────────────────────────────
  // On dérive la vitesse de la distance plutôt que de faire confiance à
  // `velocity_smooth`, dont le lissage Strava masque les vraies variations.
  const velocity = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    velocity[i] = clamp((distance[i] as number) - (distance[i - 1] as number), 0, 12);
  }
  velocity[0] = velocity[1] ?? 0;
  const velocitySmooth = movingAverage(velocity, 5);

  // ── Pente ──────────────────────────────────────────────────────────────────
  const grade = rawAlt
    ? computeGrade(distance, altitude, opts.gradeWindowM ?? 30)
    : new Array<number>(n).fill(0);

  // ── FC, cadence, puissance, température ────────────────────────────────────
  const hrRaw = resample(raw.heartrate, srcTime, absTime, lerpNum);
  const heartrate = hrRaw ? hrRaw.map((h) => (h > 30 && h < 235 ? Math.round(h) : null)) : undefined;

  const cadRaw = resample(raw.cadence, srcTime, absTime, lerpNum);
  // Strava renvoie la cadence de course en cycles/min (une jambe) : ×2 pour des pas/min.
  const cadence = cadRaw
    ? cadRaw.map((c) => (c > 20 && c < 130 ? Math.round(c * 2) : c >= 130 && c < 250 ? Math.round(c) : null))
    : undefined;

  const wattsRaw = resample(raw.watts, srcTime, absTime, lerpNum);
  const watts = wattsRaw ? wattsRaw.map((w) => (w >= 0 && w < 2000 ? Math.round(w) : null)) : undefined;

  const tempRaw = resample(raw.temp, srcTime, absTime, lerpNum);
  const temperature = tempRaw ? tempRaw.map((c) => (c > -40 && c < 60 ? c : null)) : undefined;

  const latlng = resample<[number, number]>(
    raw.latlng,
    srcTime,
    absTime,
    null,
  );

  const moving = velocitySmooth.map((v) => v >= stoppedSpeed);
  const movingTimeS = moving.filter(Boolean).length;

  // ── Diagnostic de qualité ──────────────────────────────────────────────────
  const gpsQuality = gpsQualityOf({ time, latlng });

  const hrCoverage = heartrate ? heartrate.filter((h) => h != null).length / n : 0;

  const streams: ActivityStreams = {
    time,
    distance,
    altitude,
    velocity: velocitySmooth,
    grade,
    moving,
  };
  if (heartrate) streams.heartrate = heartrate;
  if (cadence) streams.cadence = cadence;
  if (watts) streams.watts = watts;
  if (temperature) streams.temperature = temperature;
  if (latlng) streams.latlng = latlng;

  return { streams, gpsQuality, hrCoverage, movingTimeS, warnings };
}

/**
 * Part des secondes que les coordonnées doivent couvrir : en deçà de la moitié,
 * la distance de la sortie est surtout celle de l'accéléromètre ; en deçà de
 * 90 %, elle l'est par endroits.
 */
const GPS_COVERAGE = { none: 0.5, poor: 0.9 } as const;

/**
 * La qualité GPS d'une sortie, jugée sur ses coordonnées.
 *
 * La distance ne dit rien du GPS : sans coordonnées, la montre la compte à
 * l'accéléromètre. Le 26/09, 54 min sur tapis ont fait 11,9 km au poignet pour
 * 8,0 au compteur — et une sortie « GPS bon », tant que la qualité se lisait
 * sur la distance.
 */
export function gpsQualityOf(streams: Pick<ActivityStreams, 'time' | 'latlng'>): GpsQuality {
  const n = streams.time.length;
  if (!streams.latlng || n === 0) return 'none';
  const fixes = streams.latlng.filter((p) => p != null && Number.isFinite(p[0]) && Number.isFinite(p[1])).length;
  const coverage = fixes / n;
  return coverage < GPS_COVERAGE.none ? 'none' : coverage < GPS_COVERAGE.poor ? 'poor' : 'good';
}

/**
 * Une sortie mesure-t-elle sa vitesse au sol ?
 *
 * Ni sur tapis — Strava la marque `trainer` —, ni sans coordonnées : sa vitesse
 * y est celle de l'accéléromètre, et elle ne prouve rien — ni vitesse critique,
 * ni VMA, ni allure facile, ni effort maximal. Sa FC, elle, reste une mesure.
 * Une qualité GPS inconnue — une analyse antérieure au moteur 1.4.0 — ne dit
 * rien contre la sortie.
 */
export function measuresGroundSpeed(activity: Pick<Activity, 'trainer'>, gpsQuality?: GpsQuality): boolean {
  return !activity.trainer && gpsQuality !== 'none';
}

/** La distance cumulée ne peut pas décroître : corrige les reculs de GPS. */
function enforceMonotonic(values: number[]): number[] {
  const out = values.slice();
  for (let i = 1; i < out.length; i++) {
    if ((out[i] as number) < (out[i - 1] as number)) out[i] = out[i - 1] as number;
  }
  return out;
}

function emptyStreams(): ActivityStreams {
  return { time: [], distance: [], altitude: [], velocity: [], grade: [] };
}

/** Dénivelé positif cumulé, échantillon par échantillon — requis par l'analyse de durabilité. */
export function cumulativeVertical(streams: ActivityStreams): number[] {
  const { altitude } = streams;
  const out = new Array<number>(altitude.length).fill(0);
  let acc = 0;
  let anchor = altitude[0] ?? 0;
  for (let i = 1; i < altitude.length; i++) {
    const z = altitude[i] as number;
    const delta = z - anchor;
    if (delta >= 1) { acc += delta; anchor = z; }
    else if (delta <= -1) { anchor = z; }
    out[i] = acc;
  }
  return out;
}

/**
 * Les échantillons où l'athlète est en mouvement.
 *
 * Une pause de 8 min à un ravitaillement ne doit ni diluer les moyennes ni
 * compter comme de la zone 1. L'analyse d'une sortie et ce que le modèle lit de
 * ses sorties passées partagent cette règle : deux lectures du même flux
 * jugeraient la même FC sur deux durées différentes.
 */
export function movingIndices(streams: ActivityStreams): number[] {
  const out: number[] = [];
  for (let i = 0; i < streams.time.length; i++) {
    if (streams.moving ? streams.moving[i] : (streams.velocity[i] ?? 0) > 0.5) out.push(i);
  }
  return out;
}
