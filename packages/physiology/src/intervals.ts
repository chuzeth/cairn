import type { IntervalDetection, ZoneDefinition, ZoneKey } from '@cairn/core';
import { gradeAdjustedSpeed } from './grade.js';
import { zoneForGradedSpeed } from './zones.js';
import { mean, movingAverage, quantile } from './units.js';

/**
 * Détection automatique de la structure d'une séance.
 *
 * L'athlète ne décrit jamais sa séance à la montre. Le moteur doit donc
 * retrouver seul les blocs d'effort — répétitions, côtes, tempo — pour pouvoir
 * dire « ta troisième répétition a lâché de 4 % » plutôt que de se contenter
 * d'une moyenne de séance, qui ne veut rien dire sur un fractionné.
 */

export interface IntervalSample {
  t: number;
  speedMs: number;
  grade: number;
  hr: number | null;
  cadence: number | null;
}

const MIN_INTERVAL_S = 25;
const MERGE_GAP_S = 12;

export function detectIntervals(
  samples: readonly IntervalSample[],
  zones: ZoneDefinition[],
): IntervalDetection[] {
  if (samples.length < 120) return [];

  const gap = samples.map((s) => gradeAdjustedSpeed(s.speedMs, s.grade));
  const smooth = movingAverage(gap, 9);
  const moving = smooth.filter((v) => v > 0.8);
  if (moving.length < 60) return [];

  // Seuil adaptatif : à mi-chemin entre la médiane (le « fond » de la séance) et
  // le 90ᵉ centile (l'intensité de travail). Robuste aux séances très diverses.
  const median = quantile(moving, 0.5);
  const p90 = quantile(moving, 0.9);
  const spread = p90 - median;
  // Sans écart marqué, la séance est continue : aucun bloc à extraire.
  if (spread < 0.35) return [];
  const threshold = median + spread * 0.5;

  // Segmentation avec hystérésis, pour éviter le hachage sur le bruit.
  const enter = threshold * 1.02;
  const exit = threshold * 0.94;
  const raw: { start: number; end: number }[] = [];
  let inBlock = false;
  let start = 0;

  for (let i = 0; i < smooth.length; i++) {
    const v = smooth[i] as number;
    if (!inBlock && v >= enter) {
      inBlock = true;
      start = i;
    } else if (inBlock && v < exit) {
      inBlock = false;
      raw.push({ start, end: i });
    }
  }
  if (inBlock) raw.push({ start, end: smooth.length - 1 });

  // Fusion des blocs séparés par un creux trop court pour être une récupération.
  const merged: { start: number; end: number }[] = [];
  for (const b of raw) {
    const last = merged[merged.length - 1];
    if (last && b.start - last.end <= MERGE_GAP_S) last.end = b.end;
    else merged.push({ ...b });
  }

  const blocks = merged.filter((b) => b.end - b.start >= MIN_INTERVAL_S);
  if (blocks.length === 0) return [];

  return blocks.map((b, index) => {
    const slice = samples.slice(b.start, b.end + 1);
    const durationS = slice.length;
    const distanceM = slice.reduce((a, s) => a + s.speedMs, 0);
    const hrs = slice.map((s) => s.hr).filter((h): h is number => h != null && h > 0);
    const cads = slice.map((s) => s.cadence).filter((c): c is number => c != null && c > 0);
    const avgGraded = mean(slice.map((s) => gradeAdjustedSpeed(s.speedMs, s.grade))) ?? 0;
    const avgGrade = mean(slice.map((s) => s.grade)) ?? 0;

    return {
      index: index + 1,
      startS: slice[0]!.t,
      endS: slice[slice.length - 1]!.t,
      durationS,
      distanceM: Math.round(distanceM),
      avgSpeedMs: Math.round((distanceM / durationS) * 1000) / 1000,
      avgGradedSpeedMs: Math.round(avgGraded * 1000) / 1000,
      avgGrade: Math.round(avgGrade * 10000) / 10000,
      avgHr: hrs.length ? Math.round(mean(hrs) as number) : null,
      maxHr: hrs.length ? Math.max(...hrs) : null,
      avgCadence: cads.length ? Math.round(mean(cads) as number) : null,
      zone: zoneForGradedSpeed(avgGraded, zones) as ZoneKey,
    } satisfies IntervalDetection;
  });
}

/**
 * Qualité d'exécution d'une série : est-ce que l'athlète a tenu, dérivé, ou
 * explosé ? C'est le diagnostic qui distingue un fractionné réussi d'un
 * fractionné parti trop vite.
 */
export interface SeriesQuality {
  count: number;
  /** Écart-type relatif des vitesses graduées entre répétitions, en %. */
  consistencyCv: number;
  /** Écart entre la dernière et la première répétition, en %. */
  fadePct: number;
  /** Dérive de FC entre première et dernière répétition, bpm. */
  hrDriftBpm: number | null;
  verdict: 'excellent' | 'solide' | 'départ_trop_rapide' | 'progressif' | 'décrochage';
  message: string;
}

export function assessSeries(intervals: readonly IntervalDetection[]): SeriesQuality | null {
  // On ne juge une série qu'à partir de trois répétitions de durée comparable.
  if (intervals.length < 3) return null;
  const durations = intervals.map((i) => i.durationS);
  const meanDur = mean(durations) as number;
  const homogeneous = durations.every((d) => Math.abs(d - meanDur) / meanDur < 0.35);
  if (!homogeneous) return null;

  const speeds = intervals.map((i) => i.avgGradedSpeedMs);
  const m = mean(speeds) as number;
  const sd = Math.sqrt(speeds.reduce((a, v) => a + (v - m) ** 2, 0) / (speeds.length - 1));
  const cv = m > 0 ? (sd / m) * 100 : 0;

  const first = speeds[0] as number;
  const last = speeds[speeds.length - 1] as number;
  const fade = first > 0 ? ((last - first) / first) * 100 : 0;

  const hrFirst = intervals[0]!.avgHr;
  const hrLast = intervals[intervals.length - 1]!.avgHr;
  const hrDrift = hrFirst != null && hrLast != null ? hrLast - hrFirst : null;

  let verdict: SeriesQuality['verdict'];
  let message: string;

  if (cv < 1.8 && Math.abs(fade) < 2) {
    verdict = 'excellent';
    message = `Série remarquablement régulière (CV ${cv.toFixed(1)} %). Allure parfaitement maîtrisée.`;
  } else if (fade > 1.5) {
    verdict = 'progressif';
    message = `Série négative : +${fade.toFixed(1)} % entre la première et la dernière. Gestion mature, tu avais de la marge au départ.`;
  } else if (fade < -6) {
    verdict = 'décrochage';
    message = `Décrochage de ${Math.abs(fade).toFixed(1)} % sur la série. Soit l'allure cible était trop ambitieuse, soit la fraîcheur manquait.`;
  } else if (fade < -2.5 && (speeds[0] as number) > m * 1.02) {
    verdict = 'départ_trop_rapide';
    message = `Première répétition ${(((speeds[0] as number) / m - 1) * 100).toFixed(1)} % au-dessus de la moyenne : départ trop rapide, la série s'est payée derrière.`;
  } else {
    verdict = 'solide';
    message = `Série solide (CV ${cv.toFixed(1)} %, écart début/fin ${fade.toFixed(1)} %).`;
  }

  return {
    count: intervals.length,
    consistencyCv: Math.round(cv * 10) / 10,
    fadePct: Math.round(fade * 10) / 10,
    hrDriftBpm: hrDrift,
    verdict,
    message,
  };
}

/** Devine le type de séance à partir de sa structure et de sa distribution. */
export function inferSessionShape(
  intervals: readonly IntervalDetection[],
  totalDurationS: number,
  highIntensityFraction: number,
  elevationGainM: number,
  distanceM: number,
): string {
  const vertPerKm = distanceM > 0 ? (elevationGainM / distanceM) * 1000 : 0;

  if (intervals.length >= 4) {
    const d = mean(intervals.map((i) => i.durationS)) as number;
    const uphill = intervals.filter((i) => i.avgGrade > 0.05).length / intervals.length;
    if (uphill > 0.6) return `côtes (${intervals.length} × ~${Math.round(d)} s)`;
    if (d < 90) return `fractionné court / PMA (${intervals.length} × ~${Math.round(d)} s)`;
    if (d < 400) return `fractionné moyen (${intervals.length} × ~${Math.round(d / 60)} min)`;
    return `fractionné long / seuil (${intervals.length} × ~${Math.round(d / 60)} min)`;
  }
  if (intervals.length >= 1 && (intervals[0]!.durationS ?? 0) > 900) return 'tempo continu / seuil prolongé';
  if (totalDurationS > 9000 && vertPerKm > 35) return 'sortie longue spécifique trail';
  if (totalDurationS > 5400) return 'sortie longue';
  if (highIntensityFraction < 0.03) return 'endurance fondamentale';
  return 'séance mixte / fartlek';
}
