/**
 * Ce qu'il faut d'un bloc pour le ranger : sa nature, son circuit, son étendue.
 * Structurel, pour que l'écran — qui lit les blocs en JSON — partage la règle.
 */
interface AnnexBlock {
  kind?: string;
  circuit?: unknown;
  durationS?: number;
  repeat?: number;
  recovery?: { durationS: number };
}

/**
 * Ce qui, dans une séance, s'ajoute à la course.
 *
 * Un titre, une ligne de consigne, un sous-titre du matin doivent séparer ce
 * qui se court de ce qui s'ajoute : « Endurance fondamentale — 35 min » pour
 * quinze minutes de course et vingt de souplesse et de respiration disait une
 * séance que personne n'allait courir. Le planificateur, l'écran et la montre
 * lisent ici la même règle, sur les mêmes blocs.
 */

/** Un bloc qui ne se court pas : souplesse, respiration, activation, circuit de force. */
export const isAnnex = (b: AnnexBlock): boolean => Boolean(b.kind || b.circuit);

const span = (b: AnnexBlock) =>
  (b.repeat ?? 1) * ((b.durationS ?? 0) + (b.recovery?.durationS ?? 0));

/**
 * Le nom et la durée de ce qui s'ajoute, ou `null` quand la séance n'est que de
 * la course. L'activation n'ouvre qu'un renforcement : elle s'y range.
 */
export function annexOf(blocks: readonly AnnexBlock[]): { name: string; durationS: number } | null {
  const annex = blocks.filter(isAnnex);
  if (annex.length === 0) return null;
  const names = [
    ...(annex.some((b) => b.circuit || b.kind === 'activation') ? ['renforcement'] : []),
    ...(annex.some((b) => b.kind === 'mobility') ? ['souplesse'] : []),
    ...(annex.some((b) => b.kind === 'respiratory') ? ['respiration'] : []),
  ];
  const name = names.length > 1 ? `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}` : names[0]!;
  return { name, durationS: annex.reduce((a, b) => a + span(b), 0) };
}
