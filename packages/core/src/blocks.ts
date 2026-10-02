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

/**
 * Une allure à plat se suit-elle pendant ce bloc ? Pas sur un sentier : la pente
 * y change l'allure à chaque pas, et c'est la FC qui guide. L'allure reste dans
 * le bloc — elle sert, après coup, à juger la sortie sur sa vitesse corrigée du
 * relief —, mais ni l'écran ni la montre ne la donnent à suivre.
 */
export const followsPace = (b: { terrain?: string }): boolean => b.terrain !== 'trail';
