'use client';
import { useEffect, useState } from 'react';

/** Le point de bascule entre les deux façons d'ouvrir Cairn, en un seul endroit. */
export const PHONE_QUERY = '(max-width: 760px)';

/**
 * `null` tant qu'on ne sait pas.
 *
 * Le rendu serveur n'a pas de largeur : répondre « bureau » en attendant ferait
 * clignoter une console d'analyse sur le chemin du matin, et l'écran du matin
 * sur le tableau de bord.
 */
export function useIsPhone(): boolean | null {
  const [phone, setPhone] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const read = () => setPhone(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);
  return phone;
}
