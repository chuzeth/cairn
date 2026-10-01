import { describe, expect, it } from 'vitest';
import { sessionHeadline } from '../apps/web/lib/sessions';
import type { SessionRow } from '../apps/web/lib/api';

/**
 * Le titre de l'écran du matin : ce qu'on retient de la journée en un coup
 * d'œil. Il nomme ce qui s'y court, pas ce qui s'y ajoute.
 */

const row = (s: Pick<SessionRow, 'type' | 'title' | 'blocks'>) => s as SessionRow;

describe('Le titre du matin', () => {
  it('nomme un footing par son nom, pas par ses lignes droites', () => {
    // Le 01/10 : 45 min de footing et 6 × 20″ de lignes droites titrées « 6 × 20″ ».
    const footing = row({
      type: 'endurance',
      title: 'Footing — 58 min',
      blocks: [
        { label: 'Footing', zone: 'Z2', durationS: 2700 },
        { label: 'Lignes droites', zone: 'Z5', durationS: 20, repeat: 6, recovery: { durationS: 60, zone: 'Z1', active: false } },
        { label: 'Retour au calme', zone: 'Z1', durationS: 300 },
      ],
    });
    expect(sessionHeadline(footing)).toBe('Footing');
  });

  it('dit une séance de qualité par sa structure', () => {
    const allure = row({
      type: 'race_pace',
      title: 'Allure spécifique — 54 min',
      blocks: [
        { label: 'Échauffement', zone: 'Z2', durationS: 1200 },
        { label: 'Allure course', zone: 'Z3', durationS: 360, repeat: 3, recovery: { durationS: 120, zone: 'Z1', active: true } },
        { label: 'Retour au calme', zone: 'Z1', durationS: 600 },
      ],
    });
    expect(sessionHeadline(allure)).toBe('3 × 6′ à l\'allure course');
  });
});
