'use client';
import { useEffect } from 'react';
import { boot } from '@/lib/offline';
import { watchVersion } from '@/lib/version';

/**
 * Ce qui fait que Cairn existe quand le Mac dort, et qu'il soit la version en
 * service quand le Mac répond.
 *
 * Rien à l'écran : l'enregistrement du service worker, la reprise de la file
 * d'écritures, la comparaison de la page au commit du Mac. Placé dans la mise en
 * page, il vaut pour les sept écrans — le point du jour ouvert directement
 * depuis l'écran d'accueil comme le matin.
 */
export function Offline() {
  useEffect(() => {
    boot();
    watchVersion();
  }, []);
  return null;
}
