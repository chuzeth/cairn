import type { TerrainPoint, TerrainStretch } from './types.js';

/**
 * Le terrain d'une séance, tel qu'on le lit : d'où à où, et où ouvrir la carte.
 *
 * Partagé par l'écran, la montre et le coach : trois écritures d'un même
 * tronçon, c'est trois façons de le mal décrire.
 */

/**
 * Le lien qui ouvre un point sur une carte, par ses coordonnées.
 *
 * Plans d'Apple : sur le téléphone de l'athlète, il ouvre l'application, une
 * épingle posée au point et nommée par son rôle — de quoi s'y rendre.
 */
export function mapUrl(p: TerrainPoint): string {
  const [lat, lng] = p.at;
  return `https://maps.apple.com/?ll=${lat.toFixed(6)},${lng.toFixed(6)}&q=${encodeURIComponent(p.role)}`;
}

const pct = (grade: number) => `${Math.round(grade * 100)} %`;
const metres = (m: number) => `${Math.round(m)} m`;

/** « du haut au demi-tour, 405 m à 19 % » — les trois rôles sont masculins, l'article se contracte. */
export function stretchSpan(w: TerrainStretch): string {
  return `du ${w.from.role} au ${w.to.role}, ${metres(w.lengthM)} à ${pct(w.grade)}`;
}

/** Des coordonnées qu'on peut recopier dans une carte — sur la montre, qui n'ouvre pas de lien. */
export const coordinates = (p: TerrainPoint): string => `${p.at[0].toFixed(6)}, ${p.at[1].toFixed(6)}`;

/**
 * Une récupération qui remonte. Elle se marche, et se termine en haut : sa
 * durée est ce que la marche y prend, pas un temps après lequel repartir.
 */
export const climbsBack = (r?: { elevationGainM?: number } | null): boolean => (r?.elevationGainM ?? 0) > 0;
