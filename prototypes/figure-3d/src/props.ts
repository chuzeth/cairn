/**
 * Le décor en profondeur. Le dessin de profil dit où sont le banc et la caisse
 * et leur hauteur ; leur largeur, il ne la voit pas. La voici.
 */

/** La caisse du step-up : 54 cm de large, du milieu du corps vers le côté du pied d'appui — la jambe arrière passe à côté. */
export const BOX = { width: 30, z: 13.5 } as const;
/** Le banc de la fente bulgare : 30 cm de large, sous le pied arrière. */
export const BENCH = { width: 17, z: -5.5 } as const;
