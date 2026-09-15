import type { Metadata, Viewport } from 'next';
import { Nav } from '@/components/Nav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cairn — Performance trail',
  description:
    "Coaching trail personnalisé : modèle physiologique individuel alimenté par Strava, planification adaptative et analyse de séance.",
  // Ouvert depuis l'écran d'accueil : un nom court sous l'icône, et une barre
  // d'état noire au-dessus d'une application noire.
  appleWebApp: { capable: true, title: 'Cairn', statusBarStyle: 'black' },
};

export const viewport: Viewport = {
  themeColor: '#08090d',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <div className="app">
          <Nav />
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
