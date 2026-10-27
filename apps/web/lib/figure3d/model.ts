/**
 * Ce qui se dessine en 3D, et avec quel mannequin.
 *
 * Le 21/10, Pierre a vu la planche du prototype et dit oui à la 3D, par
 * étapes : d'abord les exercices de profil. Le 27/10, il demande que tout
 * passe en 3D — un schéma vectoriel à côté d'un schéma 3D se voit, et jure.
 * Toutes les vues y passent désormais, de profil, de face, de dos, de dessus,
 * dans un décor que la 3D sait bâtir ; le dessin vectoriel ne reste que si
 * WebGL manque, ou le temps que le mannequin arrive.
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
  'jamb', 'door', 'backdrop', 'shape', 'circle',
]);

/** Un schéma passe en 3D quand tout son décor est connu de la 3D. */
export function is3dSpec(spec: FigureSpec): boolean {
  return spec.panels.every((p) => p.props.every((q) => PROPS_3D.has(q.kind)));
}

export const FIGURES_3D: ReadonlySet<string> = new Set(
  Object.entries(FIGURES).filter(([, spec]) => spec && is3dSpec(spec)).map(([key]) => key),
);
