import type { PhysiologyModel, ZoneDefinition, ZoneDistribution, ZoneKey } from '@cairn/core';
import { clamp, msToKmh } from './units.js';

export const ZONE_KEYS: ZoneKey[] = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];

const ZONE_META: Record<ZoneKey, { label: string; purpose: string }> = {
  Z1: {
    label: 'Récupération active',
    purpose:
      "Accélérer la clairance métabolique sans ajouter de contrainte. Circulation, aisance, rien d'autre.",
  },
  Z2: {
    label: 'Endurance aérobie',
    purpose:
      'Densité capillaire, masse mitochondriale, oxydation des lipides. La zone qui construit le moteur des trails longs.',
  },
  Z3: {
    label: 'Résistance douce (tempo)',
    purpose:
      "Zone transitionnelle entre les deux seuils : sollicitation mixte aérobie/anaérobie, allure spécifique des trails courts et moyens.",
  },
  Z4: {
    label: 'Résistance dure (seuil)',
    purpose:
      'Repousser le seuil anaérobie : améliorer la vitesse maximale soutenable en repoussant l\'accumulation de lactate.',
  },
  Z5: {
    label: 'Puissance maximale aérobie',
    purpose:
      "Solliciter VO2max et la vitesse maximale aérobie. Le plafond du système : peu de volume, forte spécificité.",
  },
};

/**
 * Construit les cinq zones à partir des seuils mesurés.
 *
 * Les coefficients sont calibrés pour reproduire exactement la prescription du
 * Centre de Médecine du Sport (Z1/Z2 à 0,91 × FC_SV1 et 0,82 × v_SV1 ;
 * Z4 à 1,023 × FC_SV2) : l'athlète retrouve dans l'app les chiffres de son
 * compte rendu, et le moteur les fait évoluer avec lui.
 */
export function buildZones(model: PhysiologyModel): ZoneDefinition[] {
  const { vt1, vt2, hrMax, vmaMs } = model;
  const z1HiHr = Math.round(0.91 * vt1.hr);
  const z1HiV = 0.82 * vt1.speedMs;
  const z4HiHr = Math.round(1.023 * vt2.hr);
  // Bornes hautes de Z4 en vitesse : on prend la VMA comme frontière de Z5.
  const z4HiV = vmaMs;

  const bands: Array<[ZoneKey, number, number, number, number]> = [
    ['Z1', 0, z1HiHr, 0, z1HiV],
    ['Z2', z1HiHr, vt1.hr, z1HiV, vt1.speedMs],
    ['Z3', vt1.hr, vt2.hr, vt1.speedMs, vt2.speedMs],
    ['Z4', vt2.hr, z4HiHr, vt2.speedMs, z4HiV],
    ['Z5', z4HiHr, hrMax, z4HiV, vmaMs * 1.3],
  ];

  return bands.map(([key, hrMin, hrMaxB, sMin, sMax]) => ({
    key,
    label: ZONE_META[key].label,
    purpose: ZONE_META[key].purpose,
    hrMin,
    hrMax: hrMaxB,
    speedMinMs: sMin,
    speedMaxMs: sMax,
  }));
}

/** Zone correspondant à une fréquence cardiaque. */
export function zoneForHr(hr: number, zones: ZoneDefinition[]): ZoneKey {
  for (const z of zones) if (hr < z.hrMax) return z.key;
  return 'Z5';
}

/** Zone correspondant à une vitesse corrigée de la pente. */
export function zoneForGradedSpeed(speedMs: number, zones: ZoneDefinition[]): ZoneKey {
  for (const z of zones) if (speedMs < z.speedMaxMs) return z.key;
  return 'Z5';
}

/**
 * Répartition du temps par zone.
 *
 * La FC est préférée quand elle est disponible et l'effort assez long : elle
 * intègre la contrainte réelle. Sur les efforts courts et intenses, la FC est
 * en retard sur l'effort — on bascule alors sur la vitesse corrigée de la pente.
 */
export function computeZoneDistribution(
  zones: ZoneDefinition[],
  samples: { gradedSpeedMs: number; hr: number | null; dt: number }[],
  model: PhysiologyModel,
): ZoneDistribution {
  const seconds: Record<ZoneKey, number> = { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0 };
  let total = 0;

  const hrCoverage =
    samples.length === 0
      ? 0
      : samples.filter((s) => s.hr != null && s.hr > 0).length / samples.length;
  const useHr = hrCoverage > 0.7;

  for (const s of samples) {
    const dt = s.dt > 0 ? s.dt : 1;
    const key =
      useHr && s.hr != null && s.hr > 0
        ? zoneForHr(s.hr, zones)
        : zoneForGradedSpeed(s.gradedSpeedMs, zones);
    seconds[key] += dt;
    total += dt;
  }

  const fraction: Record<ZoneKey, number> = { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0 };
  for (const k of ZONE_KEYS) fraction[k] = total > 0 ? seconds[k] / total : 0;

  // Modèle trois zones ancré sur les seuils ventilatoires — la grille de lecture
  // de la littérature sur la distribution d'intensité.
  const low = fraction.Z1 + fraction.Z2;
  const moderate = fraction.Z3;
  const high = fraction.Z4 + fraction.Z5;

  return {
    seconds,
    fraction,
    threeZone: { low, moderate, high },
    polarizationIndex: polarizationIndex(low, moderate, high),
  };
}

/**
 * Indice de polarisation (Treff et al., 2019).
 * PI = log10(Z_low / Z_mod × Z_high × 100). Un PI > 2,00 signe une distribution
 * réellement polarisée ; en dessous, la distribution est pyramidale ou seuillée.
 */
export function polarizationIndex(low: number, moderate: number, high: number): number {
  if (low <= 0 || moderate <= 0 || high <= 0) return 0;
  if (high >= low) return 0;
  const value = Math.log10((low / moderate) * high * 100);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Représentation lisible d'une zone, telle qu'affichée à l'athlète. */
export function describeZone(z: ZoneDefinition): string {
  const kmh = (ms: number) => `${msToKmh(ms).toFixed(1)} km/h`;
  const hr = z.hrMin <= 0 ? `< ${Math.round(z.hrMax)} bpm` : `${Math.round(z.hrMin)}-${Math.round(z.hrMax)} bpm`;
  const speed = z.speedMinMs <= 0 ? `< ${kmh(z.speedMaxMs)}` : `${kmh(z.speedMinMs)} - ${kmh(z.speedMaxMs)}`;
  return `${z.key} · ${z.label} — ${hr} · ${speed}`;
}

/**
 * Cible de distribution d'intensité selon la phase de préparation.
 * Base = polarisé strict ; spécifique = pyramidal (le volume à allure course
 * augmente) ; affûtage = retour au polarisé avec volume réduit.
 */
export function targetDistribution(
  phase: 'transition' | 'base' | 'build' | 'specific' | 'peak' | 'taper' | 'race' | 'recovery',
): { low: number; moderate: number; high: number } {
  switch (phase) {
    case 'transition':
    case 'recovery':
      return { low: 0.95, moderate: 0.04, high: 0.01 };
    case 'base':
      return { low: 0.86, moderate: 0.07, high: 0.07 };
    case 'build':
      return { low: 0.8, moderate: 0.11, high: 0.09 };
    case 'specific':
      return { low: 0.75, moderate: 0.17, high: 0.08 };
    case 'peak':
      return { low: 0.78, moderate: 0.13, high: 0.09 };
    case 'taper':
      return { low: 0.82, moderate: 0.11, high: 0.07 };
    case 'race':
      return { low: 0.6, moderate: 0.3, high: 0.1 };
  }
}

/** Écart entre distribution réalisée et distribution cible, en points de %. */
export function distributionGap(
  actual: { low: number; moderate: number; high: number },
  target: { low: number; moderate: number; high: number },
): { low: number; moderate: number; high: number; worst: 'low' | 'moderate' | 'high' } {
  const d = {
    low: (actual.low - target.low) * 100,
    moderate: (actual.moderate - target.moderate) * 100,
    high: (actual.high - target.high) * 100,
  };
  const worst = (['low', 'moderate', 'high'] as const).reduce((a, b) =>
    Math.abs(d[a]) >= Math.abs(d[b]) ? a : b,
  );
  return { ...d, worst };
}

/** Borne une FC cible dans les limites physiologiques de l'athlète. */
export const clampHr = (hr: number, model: PhysiologyModel): number =>
  clamp(Math.round(hr), model.hrRest + 10, model.hrMax);
