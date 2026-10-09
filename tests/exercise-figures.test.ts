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

  it('mollets : le talon passe sous le step en bas, au-dessus en haut ; le soléaire, genou fléchi de 30°', () => {
    const p = figure('mollets-excentriques');
    const step = 20 / 1.8;
    expect(joints(p.pose)['near.heel']![1]).toBeLessThan(step - 2);
    expect(joints(p.ghost!)['near.heel']![1]).toBeGreaterThan(step + 2);
    const flechi = joints(figure('mollets-excentriques', 1).pose);
    expect(Math.abs(180 - angleAt(flechi['near.hip']!, flechi['near.knee']!, flechi['near.ankle']!) - 30)).toBeLessThanOrEqual(3);
  });

  it('mollets au sol : la montée se fait sur la pointe, le genou fléchi de 30° en séance B', () => {
    const tendu = figure('mollets-sol');
    expect(joints(tendu.pose)['near.heel']![1]).toBeGreaterThan(4);
    const flechi = joints(figure('mollets-sol', 1).pose);
    expect(180 - angleAt(flechi['near.hip']!, flechi['near.knee']!, flechi['near.ankle']!)).toBeCloseTo(30, -0.6);
  });

  it('montée sur le tabouret : on part le pied entier dessus, on redescend la jambe du haut fléchie', () => {
    const monte = figure('montee-tabouret');
    expect(joints(monte.ghost!)['near.heel']![1]).toBeCloseTo(FURNITURE.stool.seat, 0);
    const descend = joints(figure('montee-tabouret', 1).pose);
    expect(angleAt(descend['near.hip']!, descend['near.knee']!, descend['near.ankle']!)).toBeLessThan(100);
  });

  it('relevés de pointe : la pointe monte, le talon reste au sol', () => {
    const j = joints(figure('releves-pointe').pose);
    expect(j['near.toe']![1] - j['near.heel']![1]).toBeGreaterThan(5);
  });

  it('descente lente du step : le talon libre effleure le sol', () => {
    const j = joints(figure('descente-marche').pose);
    expect(j['far.heel']![1]).toBeCloseTo(0, 0);
  });

  it('bascule arrière : des genoux à la tête, une seule ligne, droite puis penchée', () => {
    const p = figure('reverse-nordic');
    for (const pose of [p.ghost!, p.pose]) {
      const j = joints(pose);
      expect(angleAt(j['near.knee']!, j.hip!, j.head!)).toBeGreaterThan(178);
    }
  });

  it('pont sur le canapé : en haut, épaule, hanche et genou alignés, genou à angle droit', () => {
    const j = joints(figure('hip-thrust').pose);
    expect(angleAt(j.shoulder!, j.hip!, j['near.knee']!)).toBeGreaterThan(175);
    expect(angleAt(j['near.hip']!, j['near.knee']!, j['near.ankle']!)).toBeCloseTo(90, 0);
  });

  it('Copenhague : la jambe du dessus dans le prolongement du tronc, son genou posé sur le step', () => {
    const j = joints(figure('copenhague').pose);
    // De face, la jambe du dessus est décalée de la largeur du bassin : elle prolonge le tronc, parallèle à lui.
    const trunk = [j.pelvis![0] - j.head![0], j.pelvis![1] - j.head![1]] as const;
    const thigh = [j['right.knee']![0] - j['right.hip']![0], j['right.knee']![1] - j['right.hip']![1]] as const;
    expect(angleAt([trunk[0], trunk[1]], [0, 0], [thigh[0], thigh[1]])).toBeLessThan(3);
    expect(j['right.knee']![1] - 3.1).toBeCloseTo(FURNITURE.stool.seat, 0);
  });

  it('mollet sous le cadre : le talon à mi-hauteur, pas tout en haut', () => {
    const j = joints(figure('mollets-iso').pose);
    expect(j['near.heel']![1]).toBeGreaterThan(3);
    expect(j['near.heel']![1]).toBeLessThan(6);
  });

  it('test du pont : le talon sur le step de 40 cm, l’autre jambe à la verticale', () => {
    const j = joints(figure('tests-maison', 1).pose);
    expect(j['near.heel']![1]).toBeCloseTo(FURNITURE.stool.seat, 0);
    expect(Math.abs(j['far.ankle']![0] - j['far.hip']![0])).toBeLessThan(1);
  });
});
