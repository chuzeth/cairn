'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { BUILD, reportError } from '@/lib/version';

/**
 * Ce qu'un écran affiche quand son rendu échoue.
 *
 * Une phrase, et la version : une capture suffit à dire quel code a cassé.
 * L'erreur part au Mac, qui la journalise. La navigation est au-dessus de cette
 * frontière : elle reste, et l'écran suivant repart de zéro.
 */
export default function ScreenError({ error }: { error: Error & { digest?: string } }) {
  const screen = usePathname();
  useEffect(() => reportError(error, screen), [error, screen]);
  return (
    <div className="broken">
      <p>Cet écran n&apos;a pas pu s&apos;afficher.</p>
      <p className="broken-version">version {BUILD ?? 'de développement'}</p>
    </div>
  );
}
