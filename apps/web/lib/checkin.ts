/**
 * Les questions du point du jour, et le sens de leurs réponses.
 *
 * Partagées par la page /point et par l'écran du matin, qui pose la première
 * question directement. Une échelle recopiée, c'est une échelle qu'on finit par
 * inverser d'un côté : « vidé » enregistré à 1 ici et à 5 là empoisonne la ligne
 * de base sans qu'aucun écran ne paraisse faux.
 */
import type { CheckIn } from './api';

export interface Option { value: number; label: string }

/** Le sommeil se déclare par tranche : à sept heures du matin, on ne sait pas mieux. */
export const SLEEP: Option[] = [
  { value: 5.0, label: '< 6 h' },
  { value: 6.5, label: '6–7 h' },
  { value: 7.5, label: '7–8 h' },
  { value: 8.5, label: '8–9 h' },
  { value: 9.5, label: '9 h +' },
];

/**
 * Une échelle 1–5, toujours rangée du pire au meilleur de gauche à droite.
 *
 * Certains champs comptent à l'envers — `soreness` vaut 5 quand ça fait mal.
 * Laisser cette inversion remonter jusqu'aux boutons, c'est demander à l'athlète
 * de changer de sens d'une rangée à l'autre : la faute de saisie qui suit est
 * indiscernable d'une vraie mauvaise journée, et elle empoisonne la ligne de
 * base. Le sens de lecture est donc constant, et c'est la valeur enregistrée
 * qui s'adapte. Les libellés remplacent les chiffres pour la même raison : « 4 »
 * ne veut rien dire sans le sens de l'échelle, « légères » se passe du sens.
 */
const scale = (labels: readonly [string, string, string, string, string], highIsWorst = false): Option[] =>
  labels.map((label, i) => ({ value: highIsWorst ? 5 - i : i + 1, label }));

export const QUESTIONS = [
  { key: 'fatigue', title: 'Fatigue', options: scale(['vidé', 'lourd', 'moyen', 'en forme', 'frais'], true) },
  { key: 'sleepHours', title: 'Sommeil', options: SLEEP },
  { key: 'sleepQuality', title: 'Qualité du sommeil', options: scale(['haché', 'léger', 'correct', 'bon', 'profond']) },
  { key: 'soreness', title: 'Courbatures', options: scale(['sévères', 'fortes', 'nettes', 'légères', 'aucune'], true) },
  { key: 'stress', title: 'Stress', options: scale(['sous l’eau', 'tendu', 'moyen', 'calme', 'serein'], true) },
  { key: 'motivation', title: 'Motivation', options: scale(['à plat', 'mou', 'moyen', 'motivé', 'mordant']) },
] as const;

export type AnswerKey = (typeof QUESTIONS)[number]['key'];
export type Answers = Partial<Record<AnswerKey, number>>;

export const EXTRAS = [
  { key: 'restingHr', label: 'FC de repos', unit: 'bpm' },
  { key: 'hrvRmssd', label: 'rMSSD', unit: 'ms' },
  { key: 'bodyMassKg', label: 'Masse', unit: 'kg' },
] as const;

export type ExtraKey = (typeof EXTRAS)[number]['key'];
export type Extras = Partial<Record<ExtraKey, string>>;

/** Retrouve la tranche déclarée — on ne réinvente pas une précision qu'on n'avait pas. */
export function answersOf(c: CheckIn): Answers {
  const a: Answers = {};
  const h = c.sleepHours;
  if (h != null) {
    a.sleepHours = SLEEP.reduce((best, o) => (Math.abs(o.value - h) < Math.abs(best.value - h) ? o : best)).value;
  }
  if (c.fatigue != null) a.fatigue = c.fatigue;
  if (c.sleepQuality != null) a.sleepQuality = c.sleepQuality;
  if (c.soreness != null) a.soreness = c.soreness;
  if (c.stress != null) a.stress = c.stress;
  if (c.motivation != null) a.motivation = c.motivation;
  return a;
}

export function extrasOf(c: CheckIn): Extras {
  const x: Extras = {};
  if (c.restingHr != null) x.restingHr = String(c.restingHr);
  if (c.hrvRmssd != null) x.hrvRmssd = String(c.hrvRmssd);
  if (c.bodyMassKg != null) x.bodyMassKg = String(c.bodyMassKg);
  return x;
}
