import type { CourseProfile, CourseUnknown, LapFormat, RaceGoal } from './types.js';

/**
 * Les objectifs dont la distance n'est pas une donnée.
 *
 * Sur un format à boucle répétée, la distance est ce qu'on trouve à l'arrivée,
 * pas ce qu'on inscrit au départ. Ces fonctions tiennent les deux lectures
 * cohérentes : la boucle et l'ambition d'un côté — les seules choses qu'on
 * connaisse — et de l'autre le parcours dérivé, dont chaque surface a besoin
 * pour compter des kilomètres, mais qui ne vaut que pour l'ambition affichée.
 */

export function isLapCourse(course: CourseProfile): course is CourseProfile & { lap: LapFormat } {
  return course.lap != null && course.lap.lengthM > 0 && course.lap.intervalS > 0;
}

/** Vrai quand la valeur numérique du champ est un repli, pas une mesure. */
export function courseHasUnknown(course: CourseProfile, what: CourseUnknown): boolean {
  return course.unknowns?.includes(what) ?? false;
}

/**
 * Nombre de boucles qu'une ambition en heures désigne.
 *
 * Tenir dix heures sur une cloche horaire, c'est boucler dix fois : la dixième
 * boucle part à 9 h 00 et doit rentrer avant 10 h 00. L'arrondi est au plus
 * proche parce qu'une ambition en heures est déjà ronde ; une demi-boucle n'a
 * pas d'existence sur ce format.
 */
export function lapsForHours(intervalS: number, hours: number): number {
  return Math.max(1, Math.round((hours * 3600) / Math.max(1, intervalS)));
}

/**
 * Parcours dérivé d'une boucle et d'une ambition.
 *
 * Le dénivelé inconnu vaut zéro ici, et `unknowns` dit que ce zéro n'est pas un
 * plat : c'est le seul endroit du système où ce repli est écrit, et il ne sort
 * jamais sans son étiquette.
 */
export function courseFromLapFormat(
  lap: LapFormat,
  laps: number,
  extra: Partial<Omit<CourseProfile, 'lap' | 'distanceM' | 'elevationGainM' | 'elevationLossM'>> = {},
  unknowns: CourseUnknown[] = [],
): CourseProfile {
  const n = Math.max(1, Math.round(laps));
  const all = new Set<CourseUnknown>(unknowns);
  if (lap.elevationGainM == null) all.add('elevation');
  return {
    technicality: extra.technicality ?? 3,
    ...extra,
    distanceM: lap.lengthM * n,
    elevationGainM: (lap.elevationGainM ?? 0) * n,
    elevationLossM: (lap.elevationLossM ?? lap.elevationGainM ?? 0) * n,
    lap,
    ...(all.size > 0 ? { unknowns: [...all] } : {}),
  };
}

/**
 * Ambition en boucles portée par un objectif, si le format en est un.
 * `null` quand l'objectif est en boucles mais que le nombre n'a pas été dit —
 * un cas qui se signale au lieu de se remplacer par un défaut.
 */
export function targetLaps(goal: RaceGoal): number | null {
  if (!isLapCourse(goal.course)) return null;
  const laps = goal.target?.laps;
  return laps != null && laps > 0 ? Math.round(laps) : null;
}

/** Le format, en une ligne lisible : « 6,706 km relancés toutes les 60 min ». */
export function describeLapFormat(lap: LapFormat): string {
  const km = (lap.lengthM / 1000).toFixed(3).replace(/\.?0+$/, '').replace('.', ',');
  const min = Math.round(lap.intervalS / 60);
  const vert =
    lap.elevationGainM == null
      ? 'D+ par boucle inconnu'
      : `${Math.round(lap.elevationGainM)} m D+ par boucle`;
  return `boucle de ${km} km relancée toutes les ${min} min · ${vert}`;
}
