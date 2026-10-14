import { describe, expect, it } from 'vitest';
import { FIGURES } from '../apps/web/lib/exerciseFigures';
import { between, dist, parts } from '../apps/web/lib/figure';
import { DEFAULT_CYCLE, cycleMs, cycleOf, phaseAt } from '../apps/web/lib/motion';

/**
 * Les schémas qui bougent (Pierre, le 14/10 : « quitte à permettre au système
 * d'être un petit peu animé »). Le corps passe de la position de départ à la
 * position dessinée au tempo de la séance, sans jamais se casser en chemin.
 */

describe('Le rythme d’un schéma', () => {
  it('suit le tempo écrit : l’aller, le maintien, le retour', () => {
    expect(cycleOf('3 s pour descendre, 1 s en bas, 1 s pour monter')).toEqual({ go: 3, hold: 1, back: 1, rest: 0.8 });
    expect(cycleOf('1 s pour monter, 2 s pour redescendre')).toEqual({ go: 1, hold: 0.5, back: 2, rest: 0.8 });
    expect(cycleOf('2 s pour tendre, 3 s tenu, 2 s pour revenir')).toEqual({ go: 2, hold: 3, back: 2, rest: 0.8 });
    expect(cycleOf('1 s pour monter, 2 s serrées en haut')).toEqual({ go: 1, hold: 2, back: 0.8, rest: 0.8 });
    expect(cycleOf('Monte le plus vite possible sans sauter, redescends en 3 s')).toEqual({ go: 0.5, hold: 0.5, back: 3, rest: 0.8 });
    expect(cycleOf('2 s au mur, puis tu reviens')).toEqual({ go: 1.4, hold: 2, back: 1.4, rest: 0.8 });
    expect(cycleOf('4 s pour faire glisser les talons').go).toBe(4);
  });

  it('prend un geste posé sans tempo écrit', () => {
    expect(cycleOf(undefined)).toEqual(DEFAULT_CYCLE);
    expect(cycleOf('en alternant')).toEqual(DEFAULT_CYCLE);
  });

  it('part du départ, tient la position dessinée, revient, et recommence', () => {
    const c = cycleOf('3 s pour descendre, 1 s en bas, 1 s pour monter');
    expect(phaseAt(c, 0)).toBe(0);
    expect(phaseAt(c, 1500)).toBeCloseTo(0.5, 5);
    expect(phaseAt(c, 3000)).toBe(1);
    expect(phaseAt(c, 3900)).toBe(1);
    expect(phaseAt(c, 4500)).toBeCloseTo(0.5, 5);
    expect(phaseAt(c, 5500)).toBe(0);
    expect(phaseAt(c, cycleMs(c) + 1500)).toBeCloseTo(0.5, 5);
  });
});

describe('Le corps en mouvement', () => {
  const moving = Object.entries(FIGURES).flatMap(([key, spec]) =>
    spec!.panels.flatMap((p, i) => (p.ghost ? [{ name: `${key} n° ${i + 1}`, from: p.ghost, to: p.pose }] : [])),
  );

  it('part de la position de départ et finit sur la position dessinée', () => {
    expect(moving.length).toBeGreaterThan(20);
    for (const { from, to } of moving) {
      expect(between(from, to, 0)).toBe(from);
      expect(between(from, to, 1)).toBe(to);
    }
  });

  it('garde la longueur de chaque segment à chaque instant', () => {
    for (const { name, from, to } of moving) {
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const { skeleton: k } = parts(between(from, to, t));
        for (const [a, b, l] of k.rigid) {
          expect(dist(k.joints[a]!, k.joints[b]!), `${name} à ${t} : ${a} – ${b}`).toBeCloseTo(l, 1);
        }
      }
    }
  });

  it('ne fait rien passer sous le sol en chemin', () => {
    // Une jambe qui balance, tendue, frôle le sol au plus bas de son arc : deux millimètres de plus
    // que le trait du contour — invisible, et ce qu'un vrai pied fait en pliant à peine le genou.
    for (const { name, from, to } of moving) {
      if (to.view === 'top') continue;
      for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const lowest = Math.min(...parts(between(from, to, t)).parts.flatMap((p) => p.pts.map((q) => q[1])));
        expect(lowest, `${name} à ${t} : ${lowest.toFixed(2)}`).toBeGreaterThanOrEqual(-1);
      }
    }
  });
});
