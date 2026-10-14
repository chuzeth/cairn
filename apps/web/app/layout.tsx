import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, Instrument_Serif } from 'next/font/google';
import { Lock } from '@/components/Lock';
import { Nav } from '@/components/Nav';
import { Offline } from '@/components/Offline';
import { TermSheet } from '@/components/Term';
import './globals.css';

/**
 * Instrument Serif pour les titres et les grands nombres, Instrument Sans pour
 * le reste — la direction « Altitude », choisie par Pierre le 14/10.
 *
 * `next/font` télécharge les polices à la construction et les sert depuis le
 * site : l'application installée s'ouvre sans un seul appel vers Google, y
 * compris hors réseau.
 */
const sans = Instrument_Sans({
  subsets: ['latin'],
  axes: ['wdth'],
  display: 'swap',
  variable: '--font-instrument-sans',
});
const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: ['normal', 'italic'],
  display: 'swap',
  variable: '--font-instrument-serif',
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
  themeColor: '#F4F2EE',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${sans.variable} ${serif.variable}`}>
      <body>
        <Offline />
        {/* Face ID à chaque ouverture : rien de l'app avant lui (`components/Lock.tsx`). */}
        <Lock>
          <div className="app">
            <Nav />
            <main className="main">{children}</main>
          </div>
          <TermSheet />
        </Lock>
      </body>
    </html>
  );
}
