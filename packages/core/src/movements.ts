import type { EccentricMovement } from './types.js';

/**
 * Comment se nomment et comment s'exécutent les mouvements du renforcement.
 *
 * L'athlète vient du fractionné, de la pyramide et du footing. « Squats
 * bulgares 8/jambe » ne se fait pas : ça se cherche sur internet, ou ça ne se
 * fait pas du tout. Une séance demande un mouvement en disant comment
 * l'exécuter, ou ne le demande pas.
 *
 * Le texte vit ici et non dans `packages/physiology`, où la table des
 * mouvements porte les constantes biomécaniques : le téléphone affiche ces
 * phrases sans dépendre du moteur, et il les affichait depuis sa propre copie
 * des intitulés — deux tables pour une même liste, donc deux occasions de
 * diverger.
 */
export const ECCENTRIC_MOVEMENT_TEXT: Record<
  EccentricMovement,
  {
    label: string;
    /** Le mouvement en une phrase exécutable. */
    cue: string;
    /** Le mouvement se compte par côté : les répétitions prescrites sont doublées. */
    unilateral: boolean;
    /** Il se prescrit en secondes de maintien, pas en répétitions. */
    held: boolean;
  }
> = {
  split_squat: {
    label: 'squats bulgares',
    cue: 'pied arrière posé sur une chaise, descends le genou avant à 90° en trois secondes, remonte en une',
    unilateral: true, held: false,
  },
  step_down: {
    label: 'descentes lentes de marche',
    cue: "debout sur une marche, descends l'autre pied jusqu'à frôler le sol en trois secondes, sans t'y poser",
    unilateral: true, held: false,
  },
  single_leg_deadlift: {
    label: 'soulevés de terre unilatéraux',
    cue: "sur une jambe, penche le buste vers l'avant en tendant l'autre jambe derrière, dos plat, jusqu'à l'horizontale",
    unilateral: true, held: false,
  },
  eccentric_calf: {
    label: 'mollets excentriques',
    cue: 'avant-pied sur une marche, monte sur les deux pointes, redescends sur une seule en trois secondes, talon sous le niveau de la marche',
    unilateral: true, held: false,
  },
  nordic_curl: {
    label: 'nordic hamstring',
    cue: 'à genoux, chevilles bloquées, descends le buste vers le sol en retenant le plus longtemps possible, mains prêtes à amortir',
    unilateral: false, held: false,
  },
  drop_jump: {
    label: 'sauts en contrebas',
    cue: "descends d'une marche de 30 cm, amortis sur l'avant-pied genoux souples, et renchaîne aussitôt un saut vertical",
    unilateral: false, held: false,
  },
  isometric: {
    label: 'gainage',
    cue: "planche sur les avant-bras, bassin dans l'axe des épaules et des talons, sans creuser le dos",
    unilateral: false, held: true,
  },
};

/**
 * Un mouvement, sa dose et son exécution, en une ligne.
 *
 * Un mouvement absent de la table vient d'une séance écrite avant lui : on rend
 * ce qu'on a plutôt que de faire tomber l'écran du matin sur un exercice
 * retiré depuis.
 */
export function describeMovement(movement: EccentricMovement, reps: number): string {
  const m = ECCENTRIC_MOVEMENT_TEXT[movement];
  if (!m) return `${movement} ${reps}`;
  const dose = m.held ? `${reps} s` : `${reps}${m.unilateral ? '/jambe' : ''}`;
  return `${m.label} ${dose} — ${m.cue}`;
}
