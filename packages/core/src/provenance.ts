import type { ParameterProvenance } from './types.js';

/**
 * Ce que vaut une provenance, et comment elle se lit.
 *
 * Un paramètre physiologique porte sa provenance ; un nombre calculé depuis
 * plusieurs en porte une aussi, et c'est la plus faible des leurs — une mesure
 * corrigée par une valeur de population n'est plus une mesure. Cette règle
 * valait pour les bornes verticales, elle vaut pour les bornes de zone et pour
 * les cibles d'un bloc : elle vit donc ici, à côté du type, et non dans celui
 * des modules qui l'a écrite en premier.
 */

export const PROVENANCE_FR: Record<ParameterProvenance, string> = {
  lab: 'laboratoire',
  field: 'terrain',
  blended: 'mixte',
  default: 'valeur par défaut',
};

const PROVENANCE_STRENGTH: Record<ParameterProvenance, number> = {
  default: 0,
  blended: 1,
  lab: 2,
  field: 2,
};

/** Provenance d'un nombre calculé depuis d'autres : celle du plus faible. */
export function weakestProvenance(
  first: ParameterProvenance,
  ...others: (ParameterProvenance | null | undefined)[]
): ParameterProvenance {
  return others.reduce<ParameterProvenance>(
    (weakest, p) => (p != null && PROVENANCE_STRENGTH[p] < PROVENANCE_STRENGTH[weakest] ? p : weakest),
    first,
  );
}
