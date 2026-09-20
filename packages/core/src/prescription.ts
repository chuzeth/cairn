import type { AthleteProfile, LabTest, TrainingDirective } from './types.js';
import { verbatim, verbatimNote } from './quote.js';
import { LAB_TEST_2025_07_24, PIERRE } from './athlete.js';

/**
 * La prescription du dossier, rendue exécutable.
 *
 * Le compte rendu du 24/07/2025 ne contient pas que quatre nombres. Il contient
 * dix remarques et une interprétation qui est une prescription d'entraînement
 * complète : des plages de durée, un critère de réussite, des fréquences, une
 * cible de cadence, une politique de fractionné. Ces phrases étaient lues par
 * le coach et affichées à l'athlète ; le planificateur, lui, ne les voyait pas,
 * et produisait des sorties de 94 minutes là où le praticien en demandait 90 à
 * 150, et zéro bloc respiratoire là où il relevait un déficit ventilatoire.
 *
 * Chaque directive est une lecture du texte, pas une réécriture : elle porte
 * l'extrait littéral qui la fonde, tranché dans le document (`verbatim`). Ce
 * qu'elle ajoute et que le document ne dit pas est nommé dans `derived`.
 *
 * Rien ici n'invente de valeur physiologique : les directives disent des durées,
 * des fréquences et des formats. Les allures et les fréquences cardiaques
 * restent produites par le modèle.
 */

const MIN = 60;

/**
 * Construit les directives portées par un compte rendu.
 *
 * Les ancres sont la lecture de *ce* document : si l'une d'elles disparaît, la
 * construction échoue au lieu de laisser vivre une consigne sans source.
 */
export function buildDirectives(lab: LabTest, athleteNotes?: readonly string[]): TrainingDirective[] {
  const text = lab.interpretation;
  if (!text) return [];

  const fromLab = (quote: string) => ({
    source: 'lab_test' as const,
    documentId: lab.id,
    date: lab.date,
    author: 'Mickaël Reynaud',
    quote,
  });
  const fromNotes = (quote: string) => ({
    source: 'athlete_notes' as const,
    date: lab.date,
    quote,
  });

  const out: TrainingDirective[] = [
    {
      id: 'foncier_duree',
      kind: 'session_duration',
      appliesTo: ['long_run'],
      minS: 90 * MIN,
      maxS: 150 * MIN,
      zone: 'Z2',
      origin: fromLab(verbatim(text, 'renforcer la qualité foncière', '(11-13 km/h)')),
    },
    {
      id: 'foncier_derive',
      kind: 'success_criterion',
      appliesTo: ['endurance', 'long_run', 'long_trail'],
      metric: 'hr_drift',
      origin: fromLab(verbatim(text, "en gardant l'aisance respiratoire", 'sans dérive cardiaque')),
      derived:
        "L'extrait vise les footings prolongés ; le critère est étendu à l'endurance de semaine et à " +
        'la rando-course, de même nature aérobie. La borne tolérée est celle du moteur, fonction de la durée.',
    },
    {
      id: 'rando_course_duree',
      kind: 'session_duration',
      appliesTo: ['long_trail'],
      minS: 180 * MIN,
      maxS: 300 * MIN,
      zone: 'Z2',
      origin: fromLab(verbatim(text, 'sous forme de rando-course', 'sur 3 à 5 h')),
    },
    {
      id: 'fractionne_hebdomadaire',
      kind: 'interval_policy',
      maxPerWeek: 1,
      alternate: ['short', 'medium'],
      // Les deux formats sont écrits dans la même phrase que la limite, avec
      // leurs durées de répétition et, pour le moyen, sa fenêtre de FC. Ce sont
      // des bornes, pas des exemples : une répétition de deux minutes n'est pas
      // un fractionné moyen abrégé, c'est un autre stimulus.
      formats: {
        medium: {
          appliesTo: ['threshold'],
          minWorkS: 3 * MIN,
          maxWorkS: 12 * MIN,
          hr: [171, 175],
          origin: fromLab(verbatim(text, 'résistance dure en fractionné moyen', '171-175 bpm')),
        },
        short: {
          appliesTo: ['vo2max'],
          minWorkS: 30,
          maxWorkS: 60,
          origin: fromLab(verbatim(text, 'PMA en fractionné court', '30\"-30\"')),
        },
      },
      origin: fromLab(
        verbatim(text, 'en se limitant à un fractionné par semaine', 'en alternant court et moyen'),
      ),
      derived:
        "La résistance douce — tempo, fartlek vallonné, descente, allure spécifique — n'est pas un " +
        'fractionné : elle reste disponible sur le second créneau de qualité.',
    },
  ];

  if (lab.practitionerNotes?.some((n) => n.includes('Cadence de course'))) {
    const quote = verbatimNote(lab.practitionerNotes, 'Cadence de course');
    out.push({
      id: 'cadence',
      kind: 'cadence_target',
      minSpm: 170,
      maxSpm: 180,
      origin: fromLab(quote),
    });
  }

  // Les deux fréquences hebdomadaires sont portées par les notes de l'athlète :
  // le praticien constate (souplesse à −1 cm, CUP à 48 %), les notes tranchent
  // ce qu'on en fait.
  if (athleteNotes?.some((n) => n.includes('mobilité chaîne postérieure'))) {
    out.push({
      id: 'souplesse',
      kind: 'weekly_frequency',
      block: 'mobility',
      timesPerWeek: 2,
      durationS: 10 * MIN,
      origin: fromNotes(verbatimNote(athleteNotes, 'mobilité chaîne postérieure')),
    });
  }

  if (athleteNotes?.some((n) => n.includes('travail respiratoire'))) {
    out.push({
      id: 'respiration',
      kind: 'weekly_frequency',
      block: 'respiratory',
      timesPerWeek: 2,
      durationS: 10 * MIN,
      origin: fromNotes(verbatimNote(athleteNotes, 'travail respiratoire')),
      derived:
        "Le dossier constate le déficit — CUP à 48 % pour une référence supérieure à 55 % — et juge le " +
        'travail rentable, sans en fixer ni la fréquence ni la durée : les deux blocs de dix minutes par ' +
        'semaine sont une décision du planificateur, pas une prescription du praticien.',
    });
  }

  return out;
}

/**
 * Directives applicables à un athlète.
 *
 * Seul le compte rendu effectivement lu produit des directives : un test dont
 * personne n'a dépouillé la prose n'en porte aucune, et le plan retombe sur ses
 * quatre nombres — ce qui est faux, mais visible.
 */
export function directivesFor(profile: AthleteProfile): TrainingDirective[] {
  const lab = profile.labTests.find((t) => t.id === LAB_TEST_2025_07_24.id);
  return lab ? buildDirectives(lab, profile.constraints.notes) : [];
}

/** Les directives du dossier de Pierre, construites une fois. */
export const LAB_DIRECTIVES_2025_07_24 = buildDirectives(
  LAB_TEST_2025_07_24,
  PIERRE.constraints.notes,
);
