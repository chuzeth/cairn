/**
 * Ce qui se dessine en 3D, et avec quel mannequin.
 *
 * Le 21/10, Pierre a vu la planche du prototype et dit oui à la 3D, par
 * étapes. La première : les exercices entièrement de profil, au décor que la
 * 3D sait bâtir. Les vues de face et de dessus, les machines dessinées point
 * par point, la porte et son accroche restent en vecteur.
 *
 * Rien ici n'importe three : le service worker, les tests et les pages le
 * lisent sans charger le moteur.
 */
import { FIGURES } from '../exerciseFigures';
import type { FigureSpec, Prop } from '../figure';

/**
 * Le mannequin, nommé par son empreinte (`scripts/build-mannequin.mjs`). Le
 * service worker le range dès l'installation : les deux noms doivent rester
 * les mêmes, `tests/exercise-figures-3d.test.ts` le vérifie.
 */
export const MODEL_URL = '/figures/mannequin-603f2975.glb';

/** Le décor que la 3D sait bâtir. */
export const PROPS_3D: ReadonlySet<Prop['kind']> = new Set([
  'floor', 'wall', 'chair', 'sofa', 'stool', 'box', 'bench', 'stairs', 'mat', 'towel', 'dumbbell',
]);

/** Un schéma passe en 3D quand toutes ses vignettes sont de profil, dans un décor connu. */
export function is3dSpec(spec: FigureSpec): boolean {
  return spec.panels.every(
    (p) => p.pose.view === 'side' && (!p.ghost || p.ghost.view === 'side') && p.props.every((q) => PROPS_3D.has(q.kind)),
  );
}

export const FIGURES_3D: ReadonlySet<string> = new Set(
  Object.entries(FIGURES).filter(([, spec]) => spec && is3dSpec(spec)).map(([key]) => key),
);
