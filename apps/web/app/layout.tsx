import type { Metadata, Viewport } from 'next';
import { Archivo } from 'next/font/google';
import { Nav } from '@/components/Nav';
import { Offline } from '@/components/Offline';
import { TermSheet } from '@/components/Term';
import './globals.css';

/**
 * Archivo, axe de largeur compris.
 *
 * `next/font` télécharge la police à la construction et la sert depuis le site :
 * l'application installée s'ouvre sans un seul appel vers Google, y compris hors
 * réseau. L'axe `wdth` est demandé explicitement — sans lui, le titre étroit du
 * matin (`font-stretch: 70%`) retomberait silencieusement sur la largeur
 * normale, et la direction retenue tiendrait à une police qui n'est pas là.
 */
const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  display: 'swap',
  variable: '--font-archivo',
});

export const metadata: Metadata = {
  title: 'Cairn — Performance trail',
  description:
    "Coaching trail personnalisé : modèle physiologique individuel alimenté par Strava, planification adaptative et analyse de séance.",
  // Ouvert depuis l'écran d'accueil : un nom court sous l'icône, et une barre
  // d'état ardoise au-dessus d'une application ardoise.
  appleWebApp: { capable: true, title: 'Cairn', statusBarStyle: 'black' },
  // Le commit de cette construction, que le service worker relit avant de
  // ranger une coquille neuve (`public/sw.js`).
  ...(process.env.CAIRN_COMMIT ? { other: { 'cairn-commit': process.env.CAIRN_COMMIT } } : {}),
};

export const viewport: Viewport = {
  themeColor: '#0e1316',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={archivo.variable}>
      <body>
        <Offline />
        <div className="app">
          <Nav />
          <main className="main">{children}</main>
        </div>
        <TermSheet />
      </body>
    </html>
  );
}
