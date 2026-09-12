/**
 * Les formats que plusieurs surfaces écrivent du même chiffre.
 *
 * Une durée de séance s'affiche sur l'écran du matin, se dit dans la phrase qui
 * justifie un allègement et se relit dans le plan. Trois écritures, un seul
 * nombre : dès qu'elles ne partagent pas la règle d'arrondi, l'une annonce
 * 31 min pendant que l'autre en affiche 30, et l'athlète n'a aucun moyen de
 * savoir laquelle croire.
 */

/**
 * Durée d'une séance, telle que l'athlète la lit : « 45 min », « 1 h 30 ».
 *
 * Tronquée à la minute, jamais arrondie au supérieur. Une séance stockée à
 * 1 840 s dure 30 min et des poussières ; l'annoncer à 31 min promet une minute
 * que la prescription ne contient pas.
 */
export function sessionDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}
