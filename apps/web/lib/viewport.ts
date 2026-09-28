'use client';
import { useEffect, useState } from 'react';

/**
 * Le point de bascule entre les deux formes de Cairn, en un seul endroit — le
 * même que `globals.css`.
 *
 * Au-dessus, l'ordinateur : la barre latérale et les consoles d'analyse. En
 * dessous, téléphone et tablette ouvrent les écrans du téléphone. Une tablette
 * à 768 px n'est pas un petit ordinateur : elle recevait les consoles, serrées
 * à côté d'une barre latérale qui prenait un tiers de l'écran.
 *
 * Cette bascule ne décide que de l'écran servi. La forme de ce qui est dessus
 * se décide sur la largeur de chaque composant, en CSS.
 */
export const DESK_QUERY = '(width >= 1100px)';

/**
 * `null` tant qu'on ne sait pas.
 *
 * Le rendu serveur n'a pas de largeur : répondre « bureau » en attendant ferait
 * clignoter une console d'analyse sur le chemin du matin, et l'écran du matin
 * sur le tableau de bord.
 */
export function useIsDesk(): boolean | null {
  const [desk, setDesk] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(DESK_QUERY);
    const read = () => setDesk(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);
  return desk;
}
