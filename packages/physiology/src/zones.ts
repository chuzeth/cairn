import type {
  ParameterProvenance, PhysiologyModel, ZoneBoundProvenance, ZoneDefinition, ZoneDistribution, ZoneKey,
} from '@cairn/core';
import { PROVENANCE_FR, weakestProvenance } from '@cairn/core';
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
 * Les coefficients sont calibrés pour reproduire la prescription du Centre de
 * Médecine du Sport (Z1/Z2 à 0,91 × FC_SV1 et 0,82 × v_SV1 ; Z4 à
 * 1,023 × FC_SV2) : l'athlète retrouve dans l'app les chiffres de son compte
 * rendu, et le moteur les fait évoluer avec lui.
 *
 * Chaque borne porte la provenance du paramètre dont elle est tirée. Deux
 * conséquences, qui ne sont pas cosmétiques.
 *
 * Z5 n'a plus de plafond de vitesse. Il valait 1,3 × VMA, c'est-à-dire
 * 23,44 km/h pour une VMA estimée à 18,03 : un nombre que ni le laboratoire ni
 * le terrain n'ont jamais produit, et qui bornait pourtant le classement des
 * séances. Une zone dont rien de mesuré ne ferme le haut se lit « au-delà de la
 * VMA » ; la lecture est moins précise, elle est vraie.
 *
 * Le plancher de la résistance dure, lui, reste le SV2 : c'est la grille du
 * compte rendu, et la déplacer priverait l'athlète des chiffres qu'il y
 * retrouve. Mais le moteur tire le SV2 de la vitesse critique en la divisant
 * par 1,02 : ce plancher est donc, par construction, sous l'asymptote au-dessus
 * de laquelle un effort cesse d'avoir un état stable. Il ne mesure pas le début
 * du domaine sévère, et sa provenance est celle des deux paramètres, la plus
 * faible — tant qu'elle disait « mixte » sans rien de plus, la séance de seuil
 * s'y calait et prescrivait 13,55-14,03 km/h autour d'une vitesse critique à
 * 13,98 (cf. `threshold` dans `sessionLibrary.ts`).
 */
export function buildZones(model: PhysiologyModel): ZoneDefinition[] {
  const { vt1, vt2, hrMax, vmaMs, criticalSpeedMs } = model;
  const p = (key: string): ParameterProvenance => model.provenance?.[key] ?? 'default';
  const z1HiHr = Math.round(0.91 * vt1.hr);
  const z1HiV = 0.82 * vt1.speedMs;
  const z4HiHr = Math.round(1.023 * vt2.hr);
  // Frontière Z3/Z4 : le SV2, comme au compte rendu. Quand il passe sous la
  // vitesse critique — ce que la construction du modèle produit toujours —, la
  // borne ne situe plus le début du domaine sévère, et elle ne vaut pas mieux
  // que le plus faible des deux paramètres qui se contredisent.
  const vt2Speed = vt2.speedMs;
  const vt2SpeedProvenance =
    vt2Speed < criticalSpeedMs
      ? weakestProvenance(p('vt2.speedMs'), p('criticalSpeedMs'))
      : p('vt2.speedMs');

  const bands: Array<{
    key: ZoneKey;
    hrMin: number;
    hrMax: number;
    speedMinMs: number;
    speedMaxMs: number | null;
    provenance: ZoneBoundProvenance;
  }> = [
    {
      key: 'Z1', hrMin: 0, hrMax: z1HiHr, speedMinMs: 0, speedMaxMs: z1HiV,
      provenance: { hrMax: p('vt1.hr'), speedMax: p('vt1.speedMs') },
    },
    {
      key: 'Z2', hrMin: z1HiHr, hrMax: vt1.hr, speedMinMs: z1HiV, speedMaxMs: vt1.speedMs,
      provenance: {
        hrMin: p('vt1.hr'), hrMax: p('vt1.hr'),
        speedMin: p('vt1.speedMs'), speedMax: p('vt1.speedMs'),
      },
    },
    {
      key: 'Z3', hrMin: vt1.hr, hrMax: vt2.hr, speedMinMs: vt1.speedMs, speedMaxMs: vt2Speed,
      provenance: {
        hrMin: p('vt1.hr'), hrMax: p('vt2.hr'),
        speedMin: p('vt1.speedMs'), speedMax: vt2SpeedProvenance,
      },
    },
    {
      key: 'Z4', hrMin: vt2.hr, hrMax: z4HiHr, speedMinMs: vt2Speed, speedMaxMs: vmaMs,
      provenance: {
        hrMin: p('vt2.hr'), hrMax: p('vt2.hr'),
        speedMin: vt2SpeedProvenance, speedMax: p('vmaMs'),
      },
    },
    {
      key: 'Z5', hrMin: z4HiHr, hrMax, speedMinMs: vmaMs, speedMaxMs: null,
      provenance: { hrMin: p('vt2.hr'), hrMax: p('hrMax'), speedMin: p('vmaMs') },
    },
  ];

  return bands.map((b) => ({
    ...b,
    label: ZONE_META[b.key].label,
    purpose: ZONE_META[b.key].purpose,
  }));
}

/** Provenance des deux bornes de vitesse d'une zone : la plus faible des deux. */
export function speedProvenanceOf(z: ZoneDefinition): ParameterProvenance {
  const { speedMin, speedMax } = z.provenance;
  return speedMin || speedMax
    ? weakestProvenance((speedMin ?? speedMax) as ParameterProvenance, speedMax)
    : 'default';
}

/** Provenance des deux bornes de FC d'une zone : la plus faible des deux. */
export function hrProvenanceOf(z: ZoneDefinition): ParameterProvenance {
  return weakestProvenance(z.provenance.hrMax, z.provenance.hrMin);
}

/** Zone correspondant à une fréquence cardiaque. */
export function zoneForHr(hr: number, zones: ZoneDefinition[]): ZoneKey {
  for (const z of zones) if (hr < z.hrMax) return z.key;
  return 'Z5';
}

/** Zone correspondant à une vitesse corrigée de la pente. */
export function zoneForGradedSpeed(speedMs: number, zones: ZoneDefinition[]): ZoneKey {
  // Une zone sans plafond ne recale rien : elle attrape tout ce qui tombe au-delà
  // de la dernière borne fermée, ce que fait déjà le repli.
  for (const z of zones) if (z.speedMaxMs != null && speedMs < z.speedMaxMs) return z.key;
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

/**
 * Représentation lisible d'une zone, telle qu'affichée à l'athlète.
 *
 * La provenance des bornes de vitesse y figure : c'est le seul endroit où le
 * chat et le serveur MCP lisent une zone, et une borne dont on ne sait pas si
 * elle est mesurée se croit mesurée.
 */
export function describeZone(z: ZoneDefinition): string {
  const kmh = (ms: number) => `${msToKmh(ms).toFixed(1)} km/h`;
  const hr = z.hrMin <= 0 ? `< ${Math.round(z.hrMax)} bpm` : `${Math.round(z.hrMin)}-${Math.round(z.hrMax)} bpm`;
  const speed =
    z.speedMaxMs == null
      ? `au-delà de ${kmh(z.speedMinMs)}`
      : z.speedMinMs <= 0
        ? `< ${kmh(z.speedMaxMs)}`
        : `${kmh(z.speedMinMs)} - ${kmh(z.speedMaxMs)}`;
  return `${z.key} · ${z.label} — ${hr} · ${speed} (${PROVENANCE_FR[speedProvenanceOf(z)]})`;
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
