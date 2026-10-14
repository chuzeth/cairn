import { ViewTransition } from 'react';

/**
 * Le passage d'un écran à l'autre.
 *
 * Le 14/10, Pierre : « il n'y a pas trop d'animation quand on passe d'une page
 * à l'autre ». Un modèle (`template`) se recrée à chaque navigation, là où la
 * mise en page persiste : c'est ici que l'écran qui part et celui qui arrive se
 * passent la main. Un onglet : l'ancien s'efface vite, le nouveau monte de dix
 * pixels. Plus profond — ouvrir la séance — ou retour : il glisse de côté.
 * Les barres de navigation ne bougent pas (`globals.css`, `view-transition-name`).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return (
    <ViewTransition
      enter={{ 'nav-forward': 'slide-forward', 'nav-back': 'slide-back', default: 'page-enter' }}
      exit={{ 'nav-forward': 'slide-forward', 'nav-back': 'slide-back', default: 'page-exit' }}
      default="none"
    >
      {children}
    </ViewTransition>
  );
}
