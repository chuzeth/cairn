'use client';
import { frStamp } from '@/lib/api';
import { BUILD, describeVersion, useVersion } from '@/lib/version';

/**
 * La version que l'écran a sous les yeux : la réponse à « est-ce que je vois la
 * dernière version vérifiée ? », sans avoir à la demander à personne.
 */
export function Version() {
  const lines = describeVersion(useVersion(), BUILD, frStamp);
  return (
    <>
      {lines.map((line) => (
        <div key={line.text} className="version" data-warn={line.warn}>{line.text}</div>
      ))}
    </>
  );
}
