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
/**
 * Un nombre à la française : « 1,2 », « 16,9 ».
 *
 * Le point décimal est une convention de programmation ; Pierre lit une
 * virgule. Écrire « 1.2 » dans une phrase qui lui est adressée, c'est lui faire
 * relire le nombre pour vérifier qu'il n'a pas mal vu.
 */
export const decimal = (v: number, digits = 1): string =>
  Number.isFinite(v) ? v.toFixed(digits).replace('.', ',') : '—';

/**
 * Un chiffre qui se lit signé : « +10,8 » et « −10,8 » ne décrivent pas le même
 * jour. La décimale ne s'écrit que si elle existe — une cible entière s'écrit
 * « +12 », et « +12,0 » ferait croire à une précision qu'elle n'a pas.
 */
export const signedDecimal = (v: number, digits = 1): string =>
  `${v >= 0 ? '+' : '−'}${decimal(Math.abs(v), Number.isInteger(v) ? 0 : digits)}`;

export function sessionDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  // « 3 h », pas « 3 h 00 » : les zéros d'une heure ronde ne disent rien de plus.
  if (h > 0) return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')}`;
  return `${m} min`;
}
