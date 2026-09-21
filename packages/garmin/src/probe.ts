import { prescribe, type WatchWorkout } from './workout.js';

/**
 * La séance jetable de `npm run garmin -- test`.
 *
 * Elle passe par le même chemin que les vraies — `prescribe`, puis l'encodage —
 * et couvre chaque forme que Cairn écrit : fin à la durée, à la distance, au
 * bouton ; cible cardiaque, plafond cardiaque seul, allure, aucune ; répétition
 * avec récupération ; circuit ; bloc annexe ; notes longues et typographie
 * française. Ce que Garmin en garde dit ce qu'il gardera des autres.
 */
export const PROBE_NAME = 'Cairn — test de liaison';

const Z1: { hrRange: [number, number]; speedRangeMs: [number, number] } = { hrRange: [0, 141], speedRangeMs: [0, 2.4518] };

export function probeWorkout(): WatchWorkout {
  const p = prescribe({
    type: 'threshold',
    title: 'Test de liaison',
    intent:
      "Séance jetable : créée, relue, comparée puis supprimée par `npm run garmin -- test`. " +
      "Elle n'est jamais planifiée, et ton calendrier n'est pas touché.",
    blocks: [
      {
        label: 'Échauffement', zone: 'Z2', durationS: 600, hrRange: [141, 155], speedRangeMs: [2.4518, 2.99],
        cadenceTargetSpm: 172,
        notes: 'Typographie : « guillemets », tiret —, moins −, fois ×, point médian ·, prime ′ et seconde ″, apostrophe ’, 13,6 km/h.',
      },
      {
        label: 'Série 30″-30″', zone: 'Z5', durationS: 30, repeat: 3, hrRange: [179, 191], speedRangeMs: [5.33, 5.66],
        recovery: { durationS: 30, zone: 'Z1', active: true, ...Z1 },
      },
      {
        label: 'Seuil à la distance', zone: 'Z4', distanceM: 2000, durationS: 540, hrRange: [171, 175],
        speedRangeMs: [3.64, 3.85], cadenceTargetSpm: 178,
        notes:
          'Effort maximal régulier à plat, départ lancé. Pars sur la fourchette basse, tiens, ne lâche que sur les trois ' +
          'dernières minutes. Chiffre à battre : 13,6 km/h — ta meilleure moyenne sur 20 min, avec récupérations. La FC ' +
          'doit dépasser 171 et finir vers 180-185 : c’est ce qui en fait une preuve maximale. Disponibilité encore rouge ' +
          'ce matin-là : pas de test, 40 min en Z2, on le repose. Cette note est volontairement longue : elle mesure ce que ' +
          'Garmin garde d’une consigne détaillée, pour que rien ne se perde en silence sur les vraies séances.',
      },
      {
        label: 'Côte', zone: 'Z4', durationS: 90, elevationGainM: 20, vamTargetMh: 800, hrRange: [171, 181],
        speedRangeMs: [3.5, 3.9], recovery: { durationS: 90, zone: 'Z1', active: true, elevationLossM: 20, ...Z1 },
      },
      {
        label: 'Circuit force', zone: 'Z2', durationS: 600,
        circuit: { rounds: 2, exercises: [{ movement: 'split_squat', reps: 8 }, { movement: 'isometric', reps: 45 }] },
        notes: 'La charge se prend en freinant, jamais en poussant.',
      },
      { label: 'Souplesse', zone: 'Z1', durationS: 300, kind: 'mobility', notes: 'Ischio-jambiers et mollets, maintiens de 45 s.' },
      { label: 'Retour au calme', zone: 'Z1', durationS: 300, ...Z1 },
    ],
  });
  if (!p.sendable) throw new Error(`Séance de test non envoyable : ${p.reason}`);
  return { ...p.workout, name: PROBE_NAME };
}
