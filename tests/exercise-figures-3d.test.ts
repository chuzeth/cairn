import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { FIGURES } from '../apps/web/lib/exerciseFigures';
import { FURNITURE, SEG, between, parts, skeleton, type Panel, type Pose, type Prop } from '../apps/web/lib/figure';
import { FIGURES_3D, MODEL_URL } from '../apps/web/lib/figure3d/model';
import { muscleMask } from '../apps/web/lib/figure3d/muscles';
import { depthOf } from '../apps/web/lib/figure3d/props';
import { Rig, armSides, sideOf } from '../apps/web/lib/figure3d/rig';

/**
 * Les garanties des schémas, vérifiées sur le mannequin 3D posé.
 *
 * `exercise-figures.test.ts` vérifie le dessin : longueurs de Winter, appuis
 * où ils sont dits, rien sous le sol. Ici, la même chose sur la peau du
 * mannequin, sommet par sommet, pour chaque schéma et à plusieurs instants du
 * geste : les articulations 3D, dans la vue du dessin, tombent sur les
 * siennes ; les segments gardent leur longueur ; la peau touche les appuis ;
 * rien ne passe sous le sol, ni dans un meuble ou un mur.
 */

const MODEL = new URL(`../apps/web/public${MODEL_URL}`, import.meta.url);
let rig: Rig;

beforeAll(async () => {
  const buf = readFileSync(MODEL);
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  rig = new Rig(gltf.scene);
});

const panels = [...FIGURES_3D].flatMap((key) => FIGURES[key as keyof typeof FIGURES]!.panels.map((p, i) => ({ key, i, p })));
/** Les instants vérifiés : le départ, le milieu, la position dessinée. */
const instants = (p: Panel) => (p.ghost ? [0, 0.5, 1] : [1]);
const poseAt = (p: Panel, t: number): Pose => (p.ghost ? between(p.ghost, p.pose, t) : p.pose);

/** Les sommets dont le poids sur les os `test` dépasse `min`. */
function vertsOf(test: (bone: string) => boolean, min = 0.5): number[] {
  const d = rig.restData();
  const out: number[] = [];
  for (let i = 0; i < d.pos.length / 3; i++) if (d.weightOf(i, test) >= min) out.push(i);
  return out;
}

/** Le corps posé, tous ses sommets dans le monde. */
function skin(): THREE.Vector3[] {
  const n = rig.body.geometry.attributes.position!.count;
  return Array.from({ length: n }, (_, i) => rig.vertex(i));
}

/** Les solides d'un meuble, en boîtes (x, y, z) ; une marche par boîte. */
function solids(prop: Prop, key: string): [number, number, number, number, number, number][] {
  const d = depthOf(key, prop.kind);
  const z0 = d.z - d.width / 2, z1 = d.z + d.width / 2;
  const span = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;
  switch (prop.kind) {
    case 'box': { const [a, b] = span(prop.x, prop.x - prop.face * prop.depth); return [[a, b, 0, prop.h, z0, z1]]; }
    case 'bench': return [[prop.from, prop.to, prop.h - 2.6, prop.h, z0, z1]];
    case 'stool': { const [a, b] = span(prop.x, prop.x - prop.face * FURNITURE.stool.depth); return [[a, b, FURNITURE.stool.seat - 3, FURNITURE.stool.seat, z0, z1]]; }
    case 'chair': { const [a, b] = span(prop.x, prop.x - prop.face * FURNITURE.chair.depth); return [[a, b, FURNITURE.chair.seat - 2, FURNITURE.chair.seat, z0, z1]]; }
    case 'sofa': { const [a, b] = span(prop.x, prop.x - prop.face * FURNITURE.sofa.depth); return [[a, b, 3, FURNITURE.sofa.seat, z0, z1]]; }
    case 'wall': { const [a, b] = span(prop.x, prop.x - prop.face * 4); return [[a, b, 0, 200, z0, z1]]; }
    case 'stairs': {
      const { rise, run } = FURNITURE.stair;
      return Array.from({ length: prop.n }, (_, i) => [prop.x + i * run, prop.x + prop.n * run + 6, i * rise, (i + 1) * rise, z0, z1] as [number, number, number, number, number, number]);
    }
    default: return [];
  }
}

/**
 * Les recouvrements que le dessin a déjà et que la 3D rend visibles, à reprendre dans les poses
 * (`lib/exerciseFigures`) : à mi-geste, les poses 2D ne sont pas vérifiées par `exercise-figures.test.ts`.
 */
const INHERITED: string[] = [
  'mollets-excentriques n° 1, t = 0 : box',
  'montee-tabouret n° 1, t = 0.5 : wall',
  'test-pont n° 1, t = 0.5 : stool',
  'test-pont n° 1, t = 1 : stool',
  'soleaire-assis n° 1, t = 0 : box',
  'soleaire-assis n° 1, t = 1 : box',
  'activation n° 1, t = 0.5 : sol',
  'mollets-machine n° 1, t = 1 : box',
  'marche-cote n° 1, t = 1 : stairs',
  'escalier-immeuble n° 1, t = 0 : stairs',
  'escalier-immeuble n° 1, t = 0.5 : stairs',
  'escalier-immeuble n° 1, t = 1 : stairs',
  'mollets-charges n° 1, t = 0 : box',
  'fente-arriere n° 1, t = 0.5 : sol',
];

describe('Les schémas en 3D', () => {
  it('passent tous en 3D, de profil, de face, de dos et de dessus', () => {
    // Le 27/10, Pierre : « que ce soit que de la modélisation 3D ». Un schéma resté en vecteur se verrait.
    const keys = Object.keys(FIGURES).filter((k) => FIGURES[k as keyof typeof FIGURES]);
    expect(keys.filter((k) => !FIGURES_3D.has(k))).toEqual([]);
    expect(FIGURES_3D.size).toBe(63);
  });

  it('chargent un mannequin que le service worker range dès l’installation', () => {
    expect(existsSync(MODEL)).toBe(true);
    const sw = readFileSync(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');
    expect(sw).toContain(`'${MODEL_URL}'`);
  });

  it('peignent chaque muscle que la fiche nomme', () => {
    const d = rig.restData();
    for (const { key, i, p } of panels) {
      for (const m of p.muscles ?? []) {
        const mask = muscleMask(d, [m], p.pose);
        const painted = mask.reduce((s, x) => s + x, 0);
        expect.soft(painted, `${key} n° ${i + 1} : ${m.muscle}`).toBeGreaterThan(40);
      }
    }
  });

  it('gardent les longueurs de Winter et posent hanches, genoux, chevilles et épaule sur le dessin', () => {
    for (const { key, i, p } of panels) {
      for (const t of instants(p)) {
        const pose = poseAt(p, t);
        const k = skeleton(pose);
        rig.pose(k, pose, { props: p.props, ...(p.hold ? { hold: p.hold } : {}) });
        const name = `${key} n° ${i + 1}, t = ${t}`;
        const L = rig.lengths();
        expect.soft(Math.abs(L.thigh - SEG.thigh), name).toBeLessThan(0.05);
        expect.soft(Math.abs(L.shank - SEG.shank), name).toBeLessThan(0.05);
        expect.soft(Math.abs(L.upperArm - SEG.upperArm), name).toBeLessThan(0.05);
        expect.soft(Math.abs(L.forearm - SEG.forearm), name).toBeLessThan(0.05);
        expect.soft(Math.abs(L.trunk - SEG.trunk), name).toBeLessThan(0.05);
        const { free } = armSides(pose);
        // De profil, les jambes et les genoux ; de face, les hanches et les chevilles (le genou s'y résout) ; de dessus, les épaules.
        const legs: [string, string][] = pose.view === 'side'
          ? [['upperleg01.R', 'near.hip'], ['lowerleg01.R', 'near.knee'], ['foot.R', 'near.ankle'], ['upperleg01.L', 'far.hip'], ['lowerleg01.L', 'far.knee'], ['foot.L', 'far.ankle']]
          : pose.view === 'front'
            ? (['left', 'right'] as const).flatMap((s): [string, string][] => [[`upperleg01.${sideOf(pose, s)}`, `${s}.hip`], [`foot.${sideOf(pose, s)}`, `${s}.ankle`]])
            : [];
        for (const [bone, joint] of [...legs, [`upperarm01.${free}`, 'free.shoulder']] as const) {
          const v = rig.head(bone);
          const q = k.joints[joint]!;
          expect.soft(Math.hypot(v.x - q[0], v.y - q[1]), `${name} : ${joint}`).toBeLessThan(0.1);
        }
        // Le bras libre : sur le dessin, à l'écart près qu'il prend s'il pend (7 à 9°). Une main dont la fiche dit
        // la profondeur y va exactement ; son coude se résout, et le coude du dessin n'est plus qu'un repère.
        const deep = pose.view !== 'side' && pose.free.depth != null;
        for (const [bone, joint] of [[`lowerarm01.${free}`, 'free.elbow'], [`wrist.${free}`, 'free.wrist']] as const) {
          if (deep && joint === 'free.elbow') continue;
          const v = rig.head(bone);
          const q = k.joints[joint]!;
          expect.soft(Math.hypot(v.x - q[0], v.y - q[1]), `${name} : ${joint}`).toBeLessThan(0.9);
        }
      }
    }
  });

  it('posent la peau sur les appuis dits, et rien sous le sol ni dans un meuble', () => {
    /** Ce que la 3D montre et que le dessin a déjà : chaque cas est nommé, un nouveau ne passe pas en silence. */
    const inherited: string[] = [];
    const feet = { R: vertsOf((b) => b === 'foot.R'), L: vertsOf((b) => b === 'foot.L') };
    const shank = { R: vertsOf((b) => /^lowerleg0[12]\.R$/.test(b)), L: vertsOf((b) => /^lowerleg0[12]\.L$/.test(b)) };
    // Le buste qui s'assoit ou se couche : MakeHuman rattache le bas des fesses au haut de la cuisse.
    const trunk = vertsOf((b) => /^(root|spine0\d|pelvis|upperleg01)/.test(b));
    const head = vertsOf((b) => /^(head|neck0[23])$/.test(b));
    const hand = { R: vertsOf((b) => /^(wrist|metacarpal|finger).*\.R$/.test(b)), L: vertsOf((b) => /^(wrist|metacarpal|finger).*\.L$/.test(b)) };
    const BONE: Record<string, string> = { shoulder: 'upperarm01', elbow: 'lowerarm01', wrist: 'wrist' };
    const d = rig.restData();
    // Les points du pied que le dessin désigne, pris sur la semelle au repos : le talon (3,8 derrière la
    // cheville, le coin de semelle — la chaussure dépasse derrière, comme celle du dessin), l'avant du pied
    // (8 devant, sous les métatarses), la pointe (11,4 devant, 0,8 au-dessus de la semelle).
    const region = (s: 'R' | 'L', point: string) => {
      const ankle = d.head(`foot.${s}`)[0];
      const [lo, hi, top] = point === 'heel' ? [-4.6, -3.0, 1.2] : point === 'ball' ? [7, 9, 1] : [10.6, 12.4, 2];
      return feet[s].filter((i) => {
        const u = d.pos[i * 3]! - ankle;
        return u >= lo && u <= hi && d.pos[i * 3 + 1]! < top;
      });
    };
    for (const { key, i, p } of panels) {
      for (const t of instants(p)) {
        const pose = poseAt(p, t);
        rig.pose(skeleton(pose), pose, { props: p.props, ...(p.hold ? { hold: p.hold } : {}) });
        const name = `${key} n° ${i + 1}, t = ${t}`;
        const all = skin();
        const drawn = parts(pose).parts;
        const k = skeleton(pose);
        // Vu de dessus, y est l'avant, et il n'y a pas de sol.
        if (pose.view !== 'top') {
          const lowest = Math.min(...all.map((v) => v.y));
          const lowest2d = Math.min(...drawn.flatMap((q) => q.pts.map((pt) => pt[1])));
          if (lowest < -0.8 && lowest >= lowest2d - 0.6) inherited.push(`${name} : sol`);
          expect.soft(lowest, `${name} : le corps descend à ${lowest.toFixed(2)} (le dessin à ${lowest2d.toFixed(2)})`).toBeGreaterThanOrEqual(Math.min(-0.8, lowest2d - 0.6));
        }

        const contacts = t === 1 ? p.contacts ?? [] : t === 0 ? p.ghostContacts ?? [] : [];
        const { free, cast } = armSides(pose);
        for (const c of contacts) {
          let y: number;
          // Ce que le dessin met à la hauteur de l'appui : un point du squelette, ou le bas d'une partie du corps.
          const y2d = c.ref ? k.joints[c.ref]![1] : Math.min(...drawn.filter((q) => q.name === c.part).flatMap((q) => q.pts.map((pt) => pt[1])));
          const [side, point] = (c.ref ?? '').split('.') as [string, string];
          if (side === 'free' || side === 'cast') {
            const s = side === 'free' ? free : cast;
            if (point === 'tip') {
              // Le bout des doigts : le haut de la main sous un cadre, son bas sur un appui.
              const ys = hand[s].map((v) => all[v]!.y);
              y = c.y > k.joints[`${side}.wrist`]![1] ? Math.max(...ys) : Math.min(...ys);
            } else {
              y = rig.head(`${BONE[point]}.${s}`).y;
            }
          } else if (c.ref && pose.view === 'front') {
            // De face, une cheville au sol : la semelle à plat, sous elle de la hauteur de la cheville.
            const s = sideOf(pose, side as 'left' | 'right');
            y = Math.min(...feet[s].map((v) => all[v]!.y)) + SEG.ankle;
          } else {
            let list: number[];
            if (c.ref) {
              list = region(side === 'near' ? 'R' : 'L', point);
            } else {
              const [ps, part] = c.part!.includes('.') ? c.part!.split('.') : ['', c.part!];
              const s = ps === 'far' ? 'L' : 'R';
              list = part === 'trunk' ? trunk : part === 'head' ? head : part === 'shank' ? shank[s] : feet[s];
            }
            y = Math.min(...list.map((v) => all[v]!.y));
          }
          const label = `${name} : appui ${c.ref ?? c.part} à ${y.toFixed(2)} pour ${c.y.toFixed(2)} (le dessin à ${y2d.toFixed(2)})`;
          if (Math.abs(y - c.y) > (c.tol ?? 0.6)) expect.soft(Math.abs(y - y2d), label).toBeLessThanOrEqual(0.6);
          expect.soft(Math.abs(y - c.y), label).toBeLessThanOrEqual((c.tol ?? 0.6) + 0.6);
        }

        // Le décor : la peau n'entre ni dans un meuble ni dans un mur ; une assise qui porte le buste, de sa tolérance.
        const seated = Math.max(0.8, ...(contacts.filter((c) => c.part === 'trunk').map((c) => c.tol ?? 0.6)));
        for (const prop of p.props) {
          for (const [x0, x1, y0, y1, z0, z1] of solids(prop, key)) {
            let depth = 0;
            for (const v of all) {
              if (v.x <= x0 || v.x >= x1 || v.y <= y0 || v.y >= y1 || v.z <= z0 || v.z >= z1) continue;
              depth = Math.max(depth, Math.min(v.x - x0, x1 - v.x, v.y - y0, y1 - v.y, v.z - z0, z1 - v.z));
            }
            let depth2d = 0;
            for (const q of drawn) {
              for (const [x, y] of q.pts) if (x > x0 && x < x1 && y > y0 && y < y1) depth2d = Math.max(depth2d, Math.min(x - x0, x1 - x, y - y0, y1 - y));
            }
            const allowed = prop.kind === 'wall' ? 1 : ['chair', 'sofa', 'stool', 'bench'].includes(prop.kind) ? seated : 0.8;
            if (depth > allowed && depth <= depth2d + 0.6) inherited.push(`${name} : ${prop.kind}`);
            expect.soft(depth, `${name} : la peau entre de ${depth.toFixed(2)} dans ${prop.kind} (le dessin de ${depth2d.toFixed(2)})`).toBeLessThanOrEqual(Math.max(allowed, depth2d + 0.6));
          }
        }
      }
    }
    // Le dessin les a déjà, la 3D les rend visibles : la pointe qui plonge dans la caisse des mollets (le pied
    // est d'un bloc, le mannequin n'a pas d'orteils qui plient), le talon dans le tabouret du test du pont, la
    // cuisse qui frôle le mur et le pied arrière qui passe sous le sol à mi-geste, le pied dans la contremarche.
    expect(inherited).toEqual(INHERITED);
  }, 120_000);
});

/** Le dessin lui-même ne doit pas faire entrer une jambe dans un banc : ce que le profil cachait, la 3D l'a montré. */
describe('Le dessin, vu par la 3D', () => {
  it('fente bulgare : le tibia arrière reste au-dessus du bord du banc', () => {
    const p = FIGURES['split-squat-bulgare']!.panels[0]!;
    const bench = p.props.find((q) => q.kind === 'bench') as Extract<Prop, { kind: 'bench' }>;
    for (const t of [0, 0.5, 1]) {
      const { parts: list } = parts(between(p.ghost!, p.pose, t));
      let depth = 0;
      for (const part of list.filter((q) => q.name === 'far.shank')) {
        for (const [x, y] of part.pts) if (x > bench.from && x < bench.to && y < bench.h) depth = Math.max(depth, bench.h - y);
      }
      expect(depth, `t = ${t}`).toBeLessThanOrEqual(0.8);
    }
  });
});
