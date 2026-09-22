/**
 * L'arithmétique d'un bloc répété : combien de fois sa récupération a lieu.
 *
 * Une récupération suit chaque répétition — sauf celle qui sépare les
 * répétitions sans suivre la dernière. Le planificateur, la montre et l'écran
 * lisent la règle ici, sur les mêmes blocs : comptée deux fois différemment,
 * c'est la même séance qui annonce deux dénivelés et deux durées.
 */

interface RepeatedBlock {
  repeat?: number;
  recovery?: { betweenReps?: boolean } | null;
}

/** Combien de fois la récupération d'un bloc a lieu. */
export const recoveryTimes = (b: RepeatedBlock): number =>
  Math.max(0, Math.max(1, b.repeat ?? 1) - (b.recovery?.betweenReps ? 1 : 0));
