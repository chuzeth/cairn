import { describe, expect, it } from 'vitest';
import { EXERCISE_KEYS } from '@cairn/core';
import { FIGURES } from '../apps/web/lib/exerciseFigures';
import { EXERCISE_GROUPS } from '../apps/web/lib/exerciseGroups';
import { FURNITURE, angleAt, dist, parts, resolve, type Pose } from '../apps/web/lib/figure';

/**
 * Les schémas d'exercices disent ce que les fiches demandent, et le disent juste.
 *
 * Le 05/10, Pierre veut « des schémas très précis ». Les premiers étaient posés
 * point par point : un tibia plus long que l'autre, un « angle droit » qui n'en
 * était pas un. Ici, chaque segment garde sa longueur, chaque appui est où il
 * est dit, rien ne passe sous le sol, un angle écrit est celui du dessin, et les
 * consignes qui se mesurent — le tibia vertical, la ligne épaule-hanche-genou —
 * se mesurent sur le dessin.
 */

const panels = Object.entries(FIGURES).flatMap(([key, spec]) => spec!.panels.map((p, i) => ({ key, i, p })));
const poses = panels.flatMap(({ key, i, p }) => [
  { name: `${key} n° ${i + 1}`, pose: p.pose, contacts: p.contacts ?? [] },
  ...(p.ghost ? [{ name: `${key} n° ${i + 1}, départ`, pose: p.ghost, contacts: p.ghostContacts ?? [] }] : []),
]);
const joints = (pose: Pose) => parts(pose).skeleton.joints;
const figure = (key: keyof typeof FIGURES, panel = 0) => FIGURES[key]!.panels[panel]!;

describe('Les schémas d’exercices', () => {
  it('dessinent chaque exercice', () => {
    expect(EXERCISE_KEYS.filter((k) => !FIGURES[k])).toEqual([]);
  });

  it('rangent chaque fiche une fois sur la page : son ancre est unique', () => {
    const listed = EXERCISE_GROUPS.flatMap((g) => g.keys);
    expect([...listed].sort()).toEqual([...EXERCISE_KEYS].sort());
  });

  it('gardent la longueur de chaque segment, et chaque appui à portée de jambe ou de bras', () => {
    for (const { name, pose } of poses) {
      const { skeleton: k } = parts(pose);
      expect(k.reach, name).toBe(true);
      for (const [a, b, l] of k.rigid) {
        expect(dist(k.joints[a]!, k.joints[b]!), `${name} : ${a} – ${b}`).toBeCloseTo(l, 1);
      }
    }
  });

  it('posent chaque appui là où il est dit, et rien ne passe sous le sol', () => {
    for (const { name, pose, contacts } of poses) {
      const { skeleton: k, parts: list } = parts(pose);
      for (const c of contacts) {
        const y = c.ref
          ? resolve(c.ref, k)[1]
          : Math.min(...list.filter((p) => p.name === c.part).flatMap((p) => p.pts.map((q) => q[1])));
        expect(Math.abs(y - c.y), `${name} : ${c.ref ?? c.part} à ${y.toFixed(2)} pour ${c.y}`).toBeLessThanOrEqual(c.tol ?? 0.6);
      }
      if (pose.view === 'top') continue;
      const lowest = Math.min(...list.flatMap((p) => p.pts.map((q) => q[1])));
      expect(lowest, `${name} : le corps descend à ${lowest.toFixed(2)}`).toBeGreaterThanOrEqual(-0.8);
    }
  });

  it('écrivent l’angle que fait le dessin', () => {
    for (const { key, p } of panels) {
      const k = parts(p.pose).skeleton;
      for (const a of p.angles ?? []) {
        if (!a.label) continue;
        const deg = angleAt(resolve(a.a, k), resolve(a.at, k), resolve(a.b, k));
        const exact = /^(\d+)°$/.exec(a.label);
        const bent = /fléchi de (\d+)°/.exec(a.label);
        if (exact) expect(Math.abs(deg - Number(exact[1])), key).toBeLessThanOrEqual(1);
        if (bent) expect(Math.abs(180 - deg - Number(bent[1])), key).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe('Les consignes, mesurées sur le dessin', () => {
  it('fente bulgare : en bas, le genou avant à angle droit et au-dessus de la cheville', () => {
    const j = joints(figure('split-squat-maison').pose);
    expect(angleAt(j['near.hip']!, j['near.knee']!, j['near.ankle']!)).toBeCloseTo(90, 0);
    // Le tibia vertical, à 6 cm près : le genou ne file pas devant.
    expect(Math.abs(j['near.knee']![0] - j['near.ankle']![0])).toBeLessThan(3.5);
    // Le genou arrière « à une main du sol » : moins de 15 cm.
    expect(j['far.knee']![1] - 3).toBeLessThan(8.5);
  });

  it('chaise : les cuisses parallèles au sol, les genoux au-dessus des chevilles', () => {
    const j = joints(figure('chaise').pose);
    expect(Math.abs(j['near.knee']![1] - j.hip![1])).toBeLessThan(1);
    expect(Math.abs(j['near.knee']![0] - j['near.ankle']![0])).toBeLessThan(1);
  });

  it('pont : en haut, épaule, hanche et genou sur une ligne, genou à angle droit', () => {
    const j = joints(figure('pont-une-jambe').pose);
    expect(angleAt(j.shoulder!, j.hip!, j['near.knee']!)).toBeGreaterThan(175);
    expect(angleAt(j['near.hip']!, j['near.knee']!, j['near.ankle']!)).toBeCloseTo(90, 0);
  });

  it('soulevé sur une jambe : du crâne au talon, une seule ligne', () => {
    const j = joints(figure('souleve-une-jambe').pose);
    expect(angleAt(j.head!, j.hip!, j['far.heel']!)).toBeGreaterThan(168);
    expect(angleAt(j['near.hip']!, j['near.knee']!, j['near.ankle']!)).toBeGreaterThan(130);
  });

  it('mollets : le talon passe sous la marche en bas, au-dessus en haut', () => {
    const p = figure('mollets-excentriques');
    expect(joints(p.pose)['near.heel']![1]).toBeLessThan(FURNITURE.stair.rise - 2);
    expect(joints(p.ghost!)['near.heel']![1]).toBeGreaterThan(FURNITURE.stair.rise + 2);
  });

  it('relevés de pointe : la pointe monte, le talon reste au sol', () => {
    const j = joints(figure('releves-pointe').pose);
    expect(j['near.toe']![1] - j['near.heel']![1]).toBeGreaterThan(5);
  });

  it('descente de marche : le talon libre effleure la marche du dessous', () => {
    const j = joints(figure('descente-marche').pose);
    expect(j['far.heel']![1]).toBeCloseTo(FURNITURE.stair.rise, 0);
  });
});
