import type { AthleteProfile, LabTest } from './types.js';

const KMH = (kmh: number) => kmh / 3.6;

/**
 * Test d'effort du 24/07/2025 — Centre de Médecine du Sport de Lyon Gerland.
 * Préparateur physique : Mickaël Reynaud · Médecin : Dr Sophie Doix.
 *
 * Ces valeurs sont l'ancre « gold standard » du modèle. Elles ne sont jamais
 * écrasées : le moteur les fait vieillir et les mélange aux estimations terrain
 * (cf. `packages/physiology/src/thresholds.ts`).
 */
export const LAB_TEST_2025_07_24: LabTest = {
  id: 'chup0725',
  date: '2025-07-24',
  lab: 'Centre de Médecine du Sport de Lyon Gerland — Le Parc',
  protocol:
    "Test triangulaire sur tapis roulant, départ 8 km/h, paliers d'1 min, incrémentation 0,8 km/h, pente 0 %",
  ergometer: 'treadmill',

  bodyMassKg: 68.6,
  heightCm: 171.5,
  bodyFatPct: 10.8,
  leanMassKg: 61.2,

  vmaMs: KMH(20.0),
  vo2maxRel: 64.6,
  vo2maxAbs: 4.43,
  vo2RestRel: 8.94,
  rerMax: 1.19,

  hrMax: 187,
  hrRestLab: 87,
  hrRecovery4min: 109,

  vt1: { hr: 155, speedMs: KMH(13.2), vo2Abs: 3.22 },
  vt2: { hr: 171, speedMs: KMH(16.8), vo2Abs: 3.89 },

  vitalCapacityL: 5.7,
  veMaxLMin: 164.1,
  respRateMax: 60,
  tidalVolumeMaxL: 2.73,
  pulmonaryUseCoefPct: 48,

  cadenceMeanSpm: 168,
  cadenceMaxSpm: 186,

  sitAndReachCm: -1.0,

  practitionerNotes: [
    'Très bonne puissance aérobie, à conserver.',
    "Bonne consommation d'O2, stabiliser à 65 ml/kg/min.",
    "VO2 de repos à 8,94 ml/kg/min (réf. < 5) : légère fatigue ou stress le jour du test.",
    'FC de repos 87 bpm mesurée debout avec masque — valeur un peu haute, non représentative du repos réel.',
    'Bonne mobilisation de la filière anaérobie (QR max 1,19).',
    'Seuil 2 très bien situé (91 % FCmax, 84 % VMA) — bonne oxygénation musculaire à l\'effort.',
    "Bon débit ventilatoire (VE > 160 l/min) mais essoufflement au max (Fr 60 cycles/min, CUP 48 % pour une réf. > 55 %).",
    'Bonne composition corporelle, stabiliser la MG à 10-11 %.',
    'Cadence de course 168 ppm — correcte, cible 170-180.',
    'Souplesse limite : flexion avant debout à -1 cm (réf. > 0). À entretenir.',
  ],
  interpretation:
    "Bon potentiel pour la course à pied, notamment pour les trails longs : profil complet et " +
    "bien équilibré entre endurance et puissance, VMA 20 km/h pour une VO2max à 65 ml/kg/min. " +
    "Les courbes d'échanges gazeux O2/CO2 sont bien espacées et le second seuil très bien situé, " +
    "signe d'une bonne oxygénation musculaire à l'effort. Recommandations : renforcer la qualité " +
    "foncière par des footings prolongés d'1h30 à 2h30 sur du roulant à 141-155 bpm (11-13 km/h), " +
    "en gardant l'aisance respiratoire et sans dérive cardiaque ; puis, de manière spécifique, sous " +
    "forme de rando-course en alternant marche et course selon le dénivelé sur 3 à 5 h. Conserver la " +
    "puissance par des séances intenses : résistance douce de type trail avec variation du dénivelé " +
    "(155-171 bpm), résistance dure en fractionné moyen 3-12 min à 171-175 bpm, PMA en fractionné " +
    "court 1'-1' ou 30\"-30\" — en se limitant à un fractionné par semaine, en alternant court et moyen.",
};

/**
 * Zones prescrites par le laboratoire, conservées telles quelles.
 * Le moteur produit ses propres zones (ré-estimées), mais celles-ci restent la
 * référence de contrôle : tout écart important doit être expliqué.
 */
export const LAB_PRESCRIBED_ZONES = [
  {
    key: 'Z1' as const,
    label: 'Récupération active',
    pctPma: '50-60 %',
    hr: [0, 141] as [number, number],
    speedKmh: [0, 10.8] as [number, number],
    objectives: [
      'Décrassage après compétition',
      'Début de reprise',
      'Échauffement et retour au calme',
      'Récupération entre les fractionnés',
    ],
  },
  {
    key: 'Z2' as const,
    label: 'Endurance aérobie',
    pctPma: '60-75 %',
    hr: [141, 155] as [number, number],
    speedKmh: [10.8, 13.2] as [number, number],
    objectives: [
      "Effort continu de 40' à 2 h sur du plat",
      'Rando-course avec dénivelé, en préparation spécifique aux trails longs',
      "Effort à jeun de 20 à 45' pour solliciter la lipolyse",
    ],
  },
  {
    key: 'Z3' as const,
    label: 'Résistance douce',
    pctPma: '75-90 %',
    hr: [155, 171] as [number, number],
    speedKmh: [13.2, 16.8] as [number, number],
    objectives: [
      "Effort continu de 30' à 1h15 sur du plat",
      'Fartlek avec variation du dénivelé',
      "Fractionné long de 10 à 20'",
    ],
  },
  {
    key: 'Z4' as const,
    label: 'Résistance dure',
    pctPma: '90-95 %',
    hr: [171, 175] as [number, number],
    speedKmh: [16.8, 18.0] as [number, number],
    objectives: [
      "Effort continu de 15 à 30'",
      "Fractionné moyen de 3 à 12' (800 m à 3000 m)",
      'Fractionné court en montée',
    ],
  },
  {
    key: 'Z5' as const,
    label: 'Puissance maximale aérobie',
    pctPma: '100-130 %',
    hr: [175, 187] as [number, number],
    speedKmh: [20.0, 26.0] as [number, number],
    objectives: [
      "1'-1' à 105 % VMA, récupération active",
      '30"-30" à 110 % VMA, récupération active',
      '15"-15" à 120 % VMA, récupération passive',
    ],
  },
];

/** Temps de référence donnés par le labo (base de calibration de la courbe d'endurance). */
export const LAB_REFERENCE_TIMES = [
  { distanceM: 5000, timeS: 16 * 60 + 40 },
  { distanceM: 10000, timeS: 35 * 60 + 42 },
  { distanceM: 21097.5, timeS: 1 * 3600 + 24 * 60 + 21 },
  { distanceM: 42195, timeS: 3 * 3600 + 11 * 60 + 42 },
];

export const PIERRE: AthleteProfile = {
  id: 'pierre',
  name: 'Pierre Chuzeville',
  birthDate: '1995-06-28',
  sex: 'M',
  stravaAthleteId: 95596908,
  labTests: [LAB_TEST_2025_07_24],
  constraints: {
    // Valeurs de départ raisonnables — ajustables depuis l'app ou par le chat.
    availableDays: [1, 2, 3, 4, 5, 6, 0],
    longRunDays: [6, 0],
    maxWeeklyHours: 9,
    maxQualitySessionsPerWeek: 2,
    accessibleVertPerSession: 800,
    hasTrackAccess: true,
    hasTreadmillAccess: true,
    notes: [
      'Basé à Lyon (69002) — accès Monts d\'Or, Croix-Rousse, parc de la Tête d\'Or, Pilat à ~1 h.',
      'Souplesse limite (flexion avant -1 cm) : mobilité chaîne postérieure à intégrer 2×/semaine.',
      'CUP à 48 % : travail respiratoire (respiration diaphragmatique, EMT) potentiellement rentable.',
    ],
  },
  preferences: { locale: 'fr', coachTone: 'direct', paceUnit: 'min_per_km' },
};
