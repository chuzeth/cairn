import { describe, expect, it } from 'vitest';
import { compensationDay } from '@cairn/coach';
import { blockTargets, planName, sessionHeadline } from '../apps/web/lib/sessions';
import type { SessionRow } from '../apps/web/lib/api';
import { PIERRE_MODEL } from './fixtures/pierre.js';

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

describe('Le programme sans course (coude cassé, 03/10)', () => {
  const day = (i: number) => {
    const t = compensationDay(PIERRE_MODEL, i);
    return row({ type: t.type, title: t.title, blocks: t.blocks as SessionRow['blocks'] });
  };

  it('nomme une séance de force par son nom, pas par la première série venue', () => {
    // Chaque exercice s'y fait en séries : « 6 tours de 30″ » titrait les maintiens d'anti-rotation.
    expect(sessionHeadline(day(1))).toBe('Force A, jambes');
    expect(sessionHeadline(day(4))).toBe('Force B, appuis');
  });

  it('dit le fractionné sans impact par sa structure et son intensité', () => {
    expect(sessionHeadline(day(3))).toBe('4 × 5′ en tempo');
    expect(sessionHeadline(day(9))).toBe('5 × 5′ au seuil');
    expect(sessionHeadline(day(16))).toBe('6 × 3′ en PMA');
  });

  it('nomme chaque séance dans le plan, plutôt que « Cross-training » cinq fois', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => planName(day(i)))).toEqual([
      'Remise en route', 'Force A, jambes', 'Marche en côte sur tapis', 'Intervalles en tempo',
      'Force B, appuis', 'Marche en côte dehors', 'Récupération active',
    ]);
    // Une séance de course garde le nom de son type.
    expect(planName(row({ type: 'endurance', title: 'Footing — 58 min', blocks: [] }))).toBe('Endurance');
  });

  it('ne compte pas l’activation d’une séance de force comme du renforcement ajouté', () => {
    expect(day(1).title).not.toContain('renforcement');
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
