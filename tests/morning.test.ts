import { describe, expect, it } from 'vitest';
import { blockTargets, sessionHeadline } from '../apps/web/lib/sessions';
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

describe('Les cibles d’un bloc', () => {
  /** Le 02/10 : 3 × 6 min à l'effort de course sur les sentiers de la Sarra. */
  const sarra: SessionRow['blocks'][number] = {
    label: 'Allure course en vallonné', zone: 'Z3', durationS: 360, repeat: 3, hrRange: [152, 157],
    paceRange: ['4:25', '5:37'], elevationGainM: 35, elevationLossM: 35,
    terrain: 'trail', provenance: { hr: 'default', speed: 'blended' },
    recovery: { durationS: 120, zone: 'Z2', active: true, paceRange: ['5:37', '6:51'] },
  };

  it('ne donne aucune allure à suivre sur un sentier : la FC guide', () => {
    // La consigne disait « pas d'allure à suivre », et le pli juste au-dessus
    // affichait « 4:25–5:37/km ».
    expect(blockTargets(sarra)).not.toContain('/km');
  });

  it('garde l’allure à plat, où elle se suit', () => {
    const plat = { ...sarra, terrain: undefined, elevationGainM: undefined, elevationLossM: undefined };
    expect(blockTargets(plat)).toContain('4:25–5:37/km');
    expect(blockTargets(plat)).toContain('récup 5:37–6:51/km');
  });
});
