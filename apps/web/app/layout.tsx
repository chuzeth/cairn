import type { Metadata, Viewport } from 'next';
import { Bodoni_Moda, Inter_Tight } from 'next/font/google';
import { DeskFoot } from '@/components/DeskFoot';
import { Lock } from '@/components/Lock';
import { Nav } from '@/components/Nav';
import { Offline } from '@/components/Offline';
import { TermSheet } from '@/components/Term';
import { THEME_BG, THEME_SCRIPT } from '@/lib/theme';
import './globals.css';

/**
 * Bodoni Moda pour les titres et les grands nombres, Inter Tight pour le reste
 * — la refonte du 21/10, inspirée de Zara : le papier chaud, l'encre, un filet,
 * une seule couleur d'accent.
 *
 * `next/font` télécharge les polices à la construction et les sert depuis le
 * site : l'application installée s'ouvre sans un seul appel vers Google, y
 * compris hors réseau.
 */
const sans = Inter_Tight({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});
const serif = Bodoni_Moda({
  subsets: ['latin'],
  axes: ['opsz'],
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'Cairn — Performance trail',
  description:
    "Coaching trail personnalisé : modèle physiologique individuel alimenté par Strava, planification adaptative et analyse de séance.",
  // Ouvert depuis l'écran d'accueil : un nom court sous l'icône, et une barre
  // d'état claire au-dessus d'une application de papier.
  appleWebApp: { capable: true, title: 'Cairn', statusBarStyle: 'default' },
  // Le commit de cette construction, que le service worker relit avant de
  // ranger une coquille neuve (`public/sw.js`).
  ...(process.env.CAIRN_COMMIT ? { other: { 'cairn-commit': process.env.CAIRN_COMMIT } } : {}),
};

export const viewport: Viewport = {
  themeColor: THEME_BG.light,
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-theme` est posé par le script du `<head>`, avant hydratation : React
    // ne doit pas s'en étonner.
    <html lang="fr" className={`${sans.variable} ${serif.variable}`} data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Offline />
        {/* Face ID à chaque ouverture : rien de l'app avant lui (`components/Lock.tsx`). */}
        <Lock>
          <div className="app">
            <Nav />
            <main className="main">{children}</main>
            <DeskFoot />
          </div>
          <TermSheet />
        </Lock>
      </body>
    </html>
  );
}
