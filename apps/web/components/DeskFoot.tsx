'use client';
import { LAB_TEST_DATE } from '@/lib/athlete';
import { Version } from './Version';

/**
 * Le pied de page de l'ordinateur : qui, sur quel test d'effort, quelle
 * version. La barre latérale le portait ; la barre du haut n'a pas la place de
 * le dire, et la version — avec le refus d'une mise à jour — doit rester lisible.
 */
export function DeskFoot() {
  return (
    <footer className="desk-foot">
      <span>Pierre Chuzeville · test d&apos;effort du {LAB_TEST_DATE}</span>
      <Version />
    </footer>
  );
}
