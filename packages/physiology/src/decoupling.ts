import type { DecouplingResult } from '@cairn/core';
import { gradeAdjustedSpeed } from './grade.js';
import { mean, movingAverage } from './units.js';

/**
 * Découplage aérobie (Pa:HR) et facteur d'efficience.
 *
 * On compare le rendement — vitesse corrigée de la pente par battement — entre
 * la première et la seconde moitié d'un effort aérobie prolongé. Une dérive
 * inférieure à 5 % signe une base aérobie solide pour la durée considérée ;
 * au-delà de 8-10 %, l'athlète travaille au-dessus de ce que son endurance
 * fondamentale peut soutenir, quelle que soit son aisance ressentie.
 *
 * C'est l'indicateur qui répond concrètement à la consigne du laboratoire :
 * « footings d'1h30 à 2h30 à 141-155 bpm, sans dérive cardiaque ».
 */

export interface DecouplingSample {
  t: number;
  speedMs: number;
  grade: number;
  hr: number | null;
  zoneOk: boolean; // échantillon dans une plage aérobie exploitable
}

const MIN_DURATION_S = 1500; // 25 min
const MIN_HR_COVERAGE = 0.85;

export function computeDecoupling(samples: readonly DecouplingSample[]): DecouplingResult {
  const usable = samples.filter((s) => s.zoneOk && s.hr != null && s.hr > 60 && s.speedMs > 0.5);

  if (usable.length < MIN_DURATION_S) {
    return {
      pctDrift: null,
      efficiencyFactor: null,
      efFirstHalf: null,
      efSecondHalf: null,
      valid: false,
      reason: `Effort aérobie continu trop court (${Math.round(usable.length / 60)} min, minimum 25 min).`,
    };
  }

  const coverage = samples.length > 0 ? usable.length / samples.length : 0;
  if (coverage < MIN_HR_COVERAGE * 0.5) {
    return {
      pctDrift: null,
      efficiencyFactor: null,
      efFirstHalf: null,
      efSecondHalf: null,
      valid: false,
      reason: "L'effort est trop fractionné ou trop intense pour une mesure de dérive fiable.",
    };
  }

  const mid = Math.floor(usable.length / 2);
  const ef = (slice: readonly DecouplingSample[]): number | null => {
    const gap = slice.map((s) => gradeAdjustedSpeed(s.speedMs, s.grade));
    const hr = slice.map((s) => s.hr as number);
    const mGap = mean(gap);
    const mHr = mean(hr);
    return mGap != null && mHr != null && mHr > 0 ? mGap / mHr : null;
  };

  const first = ef(usable.slice(0, mid));
  const second = ef(usable.slice(mid));
  const overall = ef(usable);

  if (first == null || second == null || first <= 0) {
    return {
      pctDrift: null,
      efficiencyFactor: overall,
      efFirstHalf: first,
      efSecondHalf: second,
      valid: false,
      reason: 'Données de fréquence cardiaque insuffisantes.',
    };
  }

  return {
    pctDrift: Math.round(((first - second) / first) * 1000) / 10,
    efficiencyFactor: overall != null ? Math.round(overall * 10000) / 10000 : null,
    efFirstHalf: Math.round(first * 10000) / 10000,
    efSecondHalf: Math.round(second * 10000) / 10000,
    valid: true,
  };
}

/** Lecture qualitative de la dérive. */
export function interpretDecoupling(pctDrift: number, durationS: number): {
  verdict: 'excellent' | 'good' | 'acceptable' | 'poor';
  message: string;
} {
  const h = durationS / 3600;
  // On tolère naturellement plus de dérive sur un effort plus long.
  const tolerance = 3 + h * 1.8;
  if (pctDrift < tolerance * 0.6)
    return { verdict: 'excellent', message: `Dérive de ${pctDrift.toFixed(1)} % : base aérobie très solide sur cette durée.` };
  if (pctDrift < tolerance)
    return { verdict: 'good', message: `Dérive de ${pctDrift.toFixed(1)} % : dans les clous pour ${h.toFixed(1)} h d'effort.` };
  if (pctDrift < tolerance * 1.6)
    return { verdict: 'acceptable', message: `Dérive de ${pctDrift.toFixed(1)} % : un peu haute, l'allure était au plafond de l'endurance.` };
  return {
    verdict: 'poor',
    message: `Dérive de ${pctDrift.toFixed(1)} % : effort au-dessus de la capacité aérobie du moment (chaleur, déficit de récupération ou allure trop rapide).`,
  };
}

/** Fréquence cardiaque lissée, pour supprimer les artefacts de capteur optique. */
export function cleanHeartRate(hr: readonly (number | null)[], hrMax: number): (number | null)[] {
  const numeric = hr.map((h) => (h != null && h > 30 && h < hrMax + 15 ? h : NaN));
  const smoothed = movingAverage(
    numeric.map((v) => (Number.isFinite(v) ? v : 0)),
    5,
  );
  return numeric.map((v, i) => (Number.isFinite(v) ? Math.round(smoothed[i] as number) : null));
}

/**
 * Réserve chronotrope à l'effort : décalage entre la FC attendue pour une
 * intensité donnée et la FC observée. Un décalage négatif persistant (FC plus
 * basse que prévu à allure égale) signale une fatigue autonome ou un
 * surentraînement ; un décalage positif signale une fatigue aiguë ou de la chaleur.
 */
export function hrIntensityOffset(
  observedHr: number,
  gradedSpeedMs: number,
  vt1: { hr: number; speedMs: number },
  vt2: { hr: number; speedMs: number },
): number {
  const span = vt2.speedMs - vt1.speedMs;
  if (span <= 0) return 0;
  const t = (gradedSpeedMs - vt1.speedMs) / span;
  const expected = vt1.hr + (vt2.hr - vt1.hr) * t;
  return Math.round((observedHr - expected) * 10) / 10;
}
