import { LAB_TEST_2025_07_24, type PhysiologyModel, type PlannedSession } from '@cairn/core';
import { modelFromLabOnly } from '@cairn/physiology';

const LAB_ONLY = modelFromLabOnly(LAB_TEST_2025_07_24, '2026-09-12');

/**
 * Pierre au 12/09/2026 : paramètres du modèle enregistré, courbes de montée et
 * de descente relevées sur ses 54 séances. La descente est celle que le
 * reanalyze du 13/09 a enregistrée, et la provenance celle du modèle : la
 * durabilité horaire est mesurée, sa part par 1 000 m est un repli.
 */
export const PIERRE_MODEL: PhysiologyModel = {
  ...LAB_ONLY,
  bodyMassKg: 68.6, hrMax: 191, hrRest: 55, hrReserve: 136,
  criticalSpeedMs: 3.82, dPrimeM: 260, vmaMs: 4.994, vo2maxRel: 58.1,
  vt1: { hr: 155, speedMs: 2.942 }, vt2: { hr: 171, speedMs: 3.745 },
  durabilityPctPerHour: 5.7, durabilityPctPer1000mVert: 4,
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
    durabilityPctPerHour: 'field', durabilityPctPer1000mVert: 'default', vamCurve: 'field', descentVamCurve: 'field',
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
