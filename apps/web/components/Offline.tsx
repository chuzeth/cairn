'use client';
import { useEffect } from 'react';
import { boot } from '@/lib/offline';

/**
 * Ce qui fait que Cairn existe quand le Mac dort.
 *
 * Rien à l'écran : l'enregistrement du service worker et la reprise de la file
 * d'écritures. Placé dans la mise en page, il vaut pour les sept écrans — le
 * point du jour ouvert directement depuis l'écran d'accueil comme le matin.
 */
export function Offline() {
  useEffect(boot, []);
  return null;
}
