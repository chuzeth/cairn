import { LAB_TEST_2025_07_24, type PhysiologyModel, type PlannedSession, type SessionBlock } from '@cairn/core';
import { modelFromLabOnly } from '@cairn/physiology';

const LAB_ONLY = modelFromLabOnly(LAB_TEST_2025_07_24, '2026-09-12');

/**
 * Pierre au 12/09/2026 : paramètres du modèle enregistré, courbes de montée et
 * de descente relevées sur ses 54 séances. La descente est celle que le
 * reanalyze du 13/09 a enregistrée, et la provenance celle du modèle : la
 * durabilité horaire est mesurée, sa part par 1 000 m est un repli. Le rythme
 * vertical des séances de la perte horaire, 328 m/h, est celui que le même
 * historique donne relu par le moteur 1.3.0.
 */
export const PIERRE_MODEL: PhysiologyModel = {
  ...LAB_ONLY,
  bodyMassKg: 68.6, hrMax: 191, hrRest: 55, hrReserve: 136,
  criticalSpeedMs: 3.82, dPrimeM: 260, vmaMs: 4.994, vo2maxRel: 58.1,
  vt1: { hr: 155, speedMs: 2.942 }, vt2: { hr: 171, speedMs: 3.745 },
  durabilityPctPerHour: 5.7, durabilityPctPer1000mVert: 4, durabilityVertRateMh: 328,
  vamCurve: {
    '60': 1823, '120': 1515, '180': 1431, '300': 1290, '420': 1246, '600': 1193, '900': 1176,
    '1200': 1173, '1800': 948, '2700': 860, '3600': 812, '5400': 778, '7200': 738,
  },
  descentVamCurve: {
    '60': 3705, '120': 2672, '180': 2597, '300': 2351, '420': 2176, '600': 2022, '900': 1981,
    '1200': 1830, '1800': 1782, '2700': 1694, '3600': 1485, '5400': 1072, '7200': 816, '10800': 546,
  },
  provenance: {
    ...LAB_ONLY.provenance,
    durabilityPctPerHour: 'field', durabilityPctPer1000mVert: 'default', durabilityVertRateMh: 'field',
    vamCurve: 'field', descentVamCurve: 'field',
  },
};

/** La rando-course du 03/10 telle qu'enregistrée : 1 384 m montés en 55 min, et une descente qu'aucun bloc ne porte. */
export const STORED_RANDO_0310: PlannedSession = {
  id: 'ses_nd7mrjevy6y', athleteId: 'pierre', date: '2026-10-03', type: 'long_trail',
  title: 'Rando-course 3.0 h · 1384 m D+', intent: '', priority: 'key', status: 'planned',
  blocks: [
    { label: 'Approche en endurance', zone: 'Z2', durationS: 1901, cadenceTargetSpm: 172 },
    {
      label: 'Montées — marche active ou course selon la pente', zone: 'Z2', durationS: 3320,
      elevationGainM: 1384, vamTargetMh: 854,
    },
    { label: 'Descentes — travail technique', zone: 'Z2', durationS: 2582, cadenceTargetSpm: 180 },
    { label: 'Retour roulant', zone: 'Z2', durationS: 1475 },
    { label: 'Retour au calme', zone: 'Z1', durationS: 1521 },
  ],
  plannedLoad: 136, plannedMechanicalLoad: 67, plannedDurationS: 10800, plannedElevationGainM: 1384,
};

/**
 * Les trois séances que le plan en place conservait le 21/09/2026, telles
 * qu'enregistrées — consignes d'exécution et motifs abrégés : le test maximal
 * du mardi, et les deux rando-courses ramenées sous le seuil mécanique par le
 * coach. C'est la configuration où une reconstruction écrivait 11,9 h, une
 * seconde rando-course la veille de celle du 27/09, et un footing prolongé la
 * veille du test.
 */
const Z2: Pick<SessionBlock, 'zone' | 'hrRange' | 'speedRangeMs' | 'paceRange'> = {
  zone: 'Z2', hrRange: [141, 155], speedRangeMs: [2.45672, 2.996], paceRange: ['5:34', '6:47'],
};
const Z1: Pick<SessionBlock, 'zone' | 'hrRange' | 'speedRangeMs' | 'paceRange'> = {
  zone: 'Z1', hrRange: [0, 141], speedRangeMs: [0, 2.45672], paceRange: ['6:47', '—'],
};

export const DECIDED_ON_2026_09_21: PlannedSession[] = [
  {
    id: 'ses_71f8in6f1gy', athleteId: 'pierre', date: '2026-09-22', type: 'threshold',
    title: 'Contre-la-montre 20 min — test maximal', intent: '', priority: 'key', status: 'planned',
    blocks: [
      { label: 'Échauffement progressif', ...Z2, durationS: 1200, cadenceTargetSpm: 172 },
      { label: 'Gammes et mises en action', ...Z2, durationS: 300 },
      {
        label: 'Contre-la-montre 20 min', zone: 'Z5', durationS: 1200, hrRange: [171, 185],
        speedRangeMs: [3.84, 3.99], paceRange: ['4:11', '4:20'], cadenceTargetSpm: 175,
      },
      { label: 'Retour au calme', ...Z1, durationS: 900 },
    ],
    plannedLoad: 59, plannedMechanicalLoad: 4, plannedDurationS: 3600, plannedDistanceM: 9893,
    plannedElevationGainM: 0,
    decision: { at: '2026-09-18T17:46:03.751Z', by: 'coach', summary: 'Je reprends la décision du 18/09 matin…' },
  },
  {
    id: 'ses_il7lrctf1gz', athleteId: 'pierre', date: '2026-09-27', type: 'long_trail',
    title: 'Rando-course 3 h · 680 m D+', intent: '', priority: 'key', status: 'planned',
    blocks: [
      { label: 'Approche en endurance', ...Z2, durationS: 2400 },
      { label: 'Montées — marche active ou course selon la pente', ...Z2, durationS: 3720, elevationGainM: 680 },
      { label: 'Descentes — travail technique', ...Z2, durationS: 3360, elevationLossM: 680 },
      { label: 'Retour au calme', ...Z1, durationS: 1320 },
    ],
    plannedLoad: 138, plannedMechanicalLoad: 39, plannedDurationS: 10800, plannedDistanceM: 27467,
    plannedElevationGainM: 680,
    decision: {
      at: '2026-09-18T17:47:59.066Z', by: 'coach',
      summary: 'Second pas sur la même décision : la première coupe a ramené le ratio mécanique du 27/09 de 1,76 à 1,65…',
    },
  },
  {
    id: 'ses_gm3qpe5f1h4', athleteId: 'pierre', date: '2026-10-03', type: 'long_trail',
    title: 'Rando-course 3 h · 900 m D+', intent: '', priority: 'key', status: 'planned',
    blocks: [
      { label: 'Approche en endurance', ...Z2, durationS: 1500 },
      { label: 'Montées — marche active ou course selon la pente', ...Z2, durationS: 5040, elevationGainM: 900 },
      { label: 'Descentes — allure de course', ...Z2, durationS: 3120, elevationLossM: 900 },
      { label: 'Retour au calme', ...Z1, durationS: 1140 },
    ],
    plannedLoad: 140, plannedMechanicalLoad: 48, plannedDurationS: 10800, plannedDistanceM: 27737,
    plannedElevationGainM: 900,
    decision: {
      at: '2026-09-18T17:48:49.295Z', by: 'coach',
      summary: "Correction de ce que j'ai écrit au pas précédent : j'y annonçais que le 03/10 pouvait rester à 1 014 m…",
    },
  },
];
