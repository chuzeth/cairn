import { describe, expect, it } from 'vitest';
import { legsOf, sessionProfile } from '../apps/web/lib/profile';
import { prime, spelledDuration } from '../apps/web/lib/api';
import type { SessionRow } from '../apps/web/lib/api';

/**
 * Le profil du matin se calcule sur les blocs réels, jamais sur un tracé figé.
 * Ce qui se vérifie ici, ce sont les décisions de lecture : ce qui monte, ce qui
 * se dessine à plat, et ce qu'on écrit quand rien ne monte. Une erreur y fait
 * lire à l'athlète une séance qu'il n'a pas à faire.
 */

type Blocks = SessionRow['blocks'];
const of = (blocks: Blocks) => sessionProfile({ blocks });

/** Côtes du 15/09 : 20′ d'échauffement, 8 × 90″ à +26 m, 12′ de retour au calme. */
const cotes: Blocks = [
  { label: "Échauffement jusqu'au pied de la côte", zone: 'Z2', durationS: 1200 },
  {
    label: 'Répétitions en montée', zone: 'Z4', durationS: 90, repeat: 8, elevationGainM: 26,
    recovery: { durationS: 90, zone: 'Z1', active: true },
  },
  { label: 'Retour au calme', zone: 'Z1', durationS: 720 },
];

/** Rando-course : ce qui est monté est redescendu, et chacun porte son temps. */
const rando: Blocks = [
  { label: 'Approche en endurance', zone: 'Z2', durationS: 1500 },
  { label: 'Montées', zone: 'Z2', durationS: 5310, elevationGainM: 1010 },
  { label: 'Descentes', zone: 'Z2', durationS: 2790, elevationLossM: 1010 },
  { label: 'Retour au calme', zone: 'Z1', durationS: 1200 },
];

/** Seuil sur terrain plat : les 80 m sont dans l'échauffement, le travail n'en a pas. */
const seuil: Blocks = [
  { label: 'Échauffement', zone: 'Z2', durationS: 1200, elevationGainM: 80 },
  { label: 'Gammes', zone: 'Z2', durationS: 300 },
  {
    label: 'Répétitions au seuil', zone: 'Z4', durationS: 300, repeat: 3,
    recovery: { durationS: 105, zone: 'Z1', active: true },
  },
  { label: 'Retour au calme', zone: 'Z1', durationS: 720 },
];

describe('le dépliage des blocs', () => {
  it('rend la durée prévue de la séance, récupérations comprises', () => {
    expect(of(cotes).totalS).toBe(1200 + 8 * (90 + 90) + 720);
    expect(legsOf({ blocks: cotes })).toHaveLength(1 + 8 * 2 + 1);
  });

  it('ne compte pas de temps pour un bloc sans durée', () => {
    expect(of([{ label: 'Repos', zone: 'Z1' }]).segments).toHaveLength(0);
    expect(of([]).totalS).toBe(0);
  });
});

describe('le relief dessiné', () => {
  it('donne une dent par répétition, et rien d’autre en ocre', () => {
    const p = of(cotes);
    expect(p.segments.filter((s) => s.tone === 'climb')).toHaveLength(8);
  });

  it('referme chaque dent : une côte répétée ne dessine pas un escalier', () => {
    const p = of(cotes);
    const tops = p.segments.filter((s) => s.tone === 'climb');
    // Les huit dents partent du même point et montent à la même hauteur : sans
    // la redescente implicite de la récupération, chacune partirait plus haut.
    expect(new Set(tops.map((s) => s.y0.toFixed(4))).size).toBe(1);
    expect(new Set(tops.map((s) => s.y1.toFixed(4))).size).toBe(1);
  });

  it('dessine l’échauffement à plat sans perdre ses mètres', () => {
    const p = of(seuil);
    expect(p.gainM).toBe(80);
    expect(p.drawnGainM).toBe(0);
    expect(p.segments.some((s) => s.tone === 'climb')).toBe(false);
  });

  it('ne prend pas pour un échauffement le bloc qui porte la séance', () => {
    // Sortie longue : un bloc facile de 75 min qui porte les 460 m du jour,
    // suivi d'une progression. Dessiné à plat, il effacerait le dénivelé.
    const p = of([
      { label: 'Corps de sortie', zone: 'Z2', durationS: 4500, elevationGainM: 460 },
      { label: 'Progression finale', zone: 'Z3', durationS: 900 },
    ]);
    expect(p.drawnGainM).toBe(460);
  });

  it('donne une forme à une séance sans dénivelé, par l’intensité', () => {
    const p = of(seuil);
    const hi = Math.max(...p.segments.map((s) => s.y1));
    const lo = Math.min(...p.segments.map((s) => s.y0));
    expect(hi - lo).toBeGreaterThan(0.5);
    // Trois plateaux au point haut, un par répétition au seuil — les gammes et
    // l'échauffement restent plus bas, chacun à la hauteur de sa zone.
    const plateaus = p.segments.filter((s) => s.tone === 'work' && s.x1 > s.x0);
    expect(plateaus.filter((s) => s.y0 === hi && s.y1 === hi)).toHaveLength(3);
    expect(plateaus.length).toBeGreaterThan(3);
  });
});

describe('la légende', () => {
  it('dit la montée et son nombre', () => {
    expect(of(cotes).caption).toBe('+26\u00a0m, huit fois');
    expect(of(cotes).captionIsClimb).toBe(true);
  });

  it('dit l’aller-retour d’une rando-course', () => {
    const p = of(rando);
    expect(p.caption).toBe('+1\u00a0010\u00a0m puis −1\u00a0010\u00a0m');
    expect(p.drawnLossM).toBe(1010);
  });

  it('dit à quoi tient la hauteur quand rien ne monte', () => {
    expect(of(seuil).caption).toContain("la hauteur est l'intensité");
    expect(of(seuil).captionIsClimb).toBe(false);
  });

  it('ne promet pas d’intensité là où il n’y en a pas non plus', () => {
    const p = of([
      { label: 'Footing très souple', zone: 'Z1', durationS: 2400 },
      { label: 'Souplesse', zone: 'Z1', durationS: 600, kind: 'mobility' },
    ]);
    expect(p.caption).toBe('à plat, d’un bout à l’autre');
  });

  it('nomme la descente quand c’est elle qu’on répète', () => {
    const p = of([
      { label: 'Échauffement', zone: 'Z2', durationS: 1200 },
      {
        label: 'Descentes contrôlées', zone: 'Z3', durationS: 150, repeat: 6, elevationLossM: 90,
        recovery: { durationS: 210, zone: 'Z2', active: true, elevationGainM: 90 },
      },
      { label: 'Retour au calme', zone: 'Z1', durationS: 600 },
    ]);
    expect(p.caption).toBe('−90\u00a0m, six fois');
    expect(p.captionIsClimb).toBe(false);
  });
});

describe('les repères du temps', () => {
  it('borne l’abscisse au corps de séance', () => {
    expect(of(cotes).marks.map((m) => m.seconds)).toEqual([0, 1200, 2640, 3360]);
  });

  it('écrit les minutes et les secondes comme le compte rendu d’effort', () => {
    expect(prime(90)).toBe('90″');
    expect(prime(150)).toBe('2′30″');
    expect(prime(1200)).toBe('20′');
    expect(prime(10800)).toBe('3\u00a0h');
    expect(prime(5400)).toBe('1\u00a0h\u00a030');
    expect(spelledDuration(3360)).toBe('56 minutes');
  });
});
