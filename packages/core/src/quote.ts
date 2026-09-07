/**
 * Extraits littéraux d'un document du dossier.
 *
 * Une prescription médicale datée ne se recopie pas : recopiée, elle existe en
 * deux exemplaires qui divergeront, et l'athlète n'a plus aucun moyen de savoir
 * lequel des deux son plan honore. Les directives citent donc le texte source
 * en le tranchant, jamais en le réécrivant — si l'ancre disparaît du document,
 * la construction échoue au lieu de laisser vivre une citation orpheline.
 */

/** Tranche le texte source entre deux ancres, bornes comprises. */
export function verbatim(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = start < 0 ? -1 : source.indexOf(to, start + from.length);
  if (start < 0 || end < 0) {
    throw new Error(`Extrait introuvable dans le document source : « ${from} … ${to} ».`);
  }
  return source.slice(start, end + to.length);
}

/** Retrouve, dans une liste de remarques, celle qui contient l'ancre — entière. */
export function verbatimNote(notes: readonly string[] | undefined, anchor: string): string {
  const found = notes?.find((n) => n.includes(anchor));
  if (!found) throw new Error(`Remarque introuvable dans le dossier : « ${anchor} ».`);
  return found;
}
