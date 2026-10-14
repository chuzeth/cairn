'use client';
import { useEffect } from 'react';
import { boot } from '@/lib/offline';
import { watchLive } from '@/lib/live';
import { watchVersion } from '@/lib/version';

/**
 * Ce qui fait que Cairn existe quand le Mac dort, qu'il soit la version en
 * service quand le Mac répond, et qu'il suive le Mac tant qu'il est ouvert.
 *
 * Rien à l'écran : l'enregistrement du service worker, la reprise de la file
 * d'écritures, la comparaison de la page au commit du Mac, le pouls. Placé dans la mise en
 * page, il vaut pour les sept écrans — le point du jour ouvert directement
 * depuis l'écran d'accueil comme le matin.
 */
export function Offline() {
  useEffect(() => {
    boot();
    watchVersion();
    watchLive();
  }, []);
  return null;
}
