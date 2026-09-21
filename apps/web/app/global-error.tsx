'use client';
import { useEffect } from 'react';
import { BUILD, reportError } from '@/lib/version';

/**
 * La même frontière pour la mise en page : si la navigation casse, aucun écran
 * ne tient. Next remplace alors le document entier, feuille de style comprise —
 * d'où les couleurs écrites ici.
 */
export default function LayoutError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => reportError(error, window.location.pathname), [error]);
  return (
    <html lang="fr">
      <body
        style={{
          margin: 0, minHeight: '100vh', background: '#0e1316', color: '#ece8df',
          font: '17px/1.5 -apple-system, system-ui, sans-serif',
          padding: 'calc(env(safe-area-inset-top) + 48px) 20px',
        }}
      >
        <p style={{ margin: 0 }}>Cairn n&apos;a pas pu s&apos;afficher.</p>
        <p style={{ margin: '8px 0 0', fontSize: 13, color: '#5d6663', fontFamily: 'ui-monospace, monospace' }}>
          version {BUILD ?? 'de développement'}
        </p>
      </body>
    </html>
  );
}
