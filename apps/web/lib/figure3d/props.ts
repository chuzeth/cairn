/**
 * Le décor en 3D, aux mesures de `FURNITURE` : une chaise de 46 cm, un canapé
 * de 42, un tabouret de 40, une marche de 17.
 *
 * Le dessin dit où est chaque meuble et sa hauteur ; sa largeur et sa place
 * dans l'axe de la caméra, il ne les voit pas. Par défaut, un meuble est
 * centré sous le corps ; `DEPTH` dit les exceptions, chacune pour une raison
 * que la vue cache : dans la montée sur un banc, une caisse centrée était
 * traversée par la jambe restée au sol.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { FURNITURE, doorHook, type Prop } from '../figure';

/** La largeur d'un meuble (z) et son milieu, en unités ; le corps est centré sur z = 0, sa droite vers nous. */
export interface Depth {
  width: number;
  z: number;
}

const DEFAULT: Partial<Record<Prop['kind'], Depth>> = {
  wall: { width: 140, z: 0 },
  // Ce que la main tient sans que le corps s'y appuie — le chambranle, la porte, le bâti d'une
  // machine — passe derrière le corps : de profil, la main s'y pose, et rien ne le traverse.
  jamb: { width: 16, z: -12 },
  door: { width: 44, z: -28 },
  backdrop: { width: 1, z: -40 },
  // Un rembourré dessiné point par point (siège, dossier, plateau) : sous le corps, sur sa largeur.
  shape: { width: 26, z: 0 },
  circle: { width: 24, z: 0 },
  chair: { width: 24, z: 0 },
  sofa: { width: 60, z: 0 },
  stool: { width: 17, z: 0 },
  box: { width: 30, z: 0 },
  bench: { width: 17, z: 0 },
  stairs: { width: 42, z: 0 },
  mat: { width: 34, z: 0 },
  towel: { width: 22, z: 0 },
};

/** Les exceptions, par exercice et par genre de meuble. */
export const DEPTH: Record<string, Partial<Record<Prop['kind'], Depth>>> = {
  // La caisse sous le pied d'appui, décalée de son côté : la jambe arrière passe à côté, pas au travers.
  'step-up': { box: { width: 30, z: 13.5 } },
  // Le banc sous le pied arrière, 30 cm de large.
  'split-squat-bulgare': { bench: { width: 17, z: -5.5 } },
  // Le coussin serré entre les genoux : un rond de 20 cm, pas un rouleau.
  'adducteurs-coussin': { circle: { width: 10, z: 0 } },
};

/** Le bâti d'une machine, ses montants et ses barres : derrière le corps. */
const FRAME_Z = -12;

export function depthOf(exercise: string, kind: Prop['kind']): Depth {
  return DEPTH[exercise]?.[kind] ?? DEFAULT[kind] ?? { width: 30, z: 0 };
}

export interface PropMaterials {
  pad: THREE.Material;
  metal: THREE.Material;
  mat: THREE.Material;
  towel: THREE.Material;
  plate: THREE.Material;
  /** L'accroche de porte et sa sangle, dans le vert des élastiques. */
  band: THREE.Material;
  /** Un fond, un ton sous le papier. */
  backdrop: THREE.Material;
}

/** Un pavé arrondi de `x0` à `x1`, de `y0` à `y1`, sur la profondeur `d`. */
function slab(x0: number, x1: number, y0: number, y1: number, d: Depth, material: THREE.Material, radius = 0.5): THREE.Mesh {
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  const r = Math.min(radius, w / 2.2, h / 2.2, d.width / 2.2);
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d.width, 2, r), material);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, d.z);
  return m;
}

/** Un pied de meuble, de `a` à `b`. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r: number, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 14), material);
  const v = b.clone().sub(a);
  m.position.copy(a).addScaledVector(v, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize());
  m.scale.y = v.length();
  return m;
}

/** Un haltère : la poignée selon y, deux disques. */
export function dumbbell(material: { handle: THREE.Material; plate: THREE.Material }): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 9.6, 24), material.handle));
  const profile = [[0, -1.15], [2.9, -1.15], [3.2, -0.85], [3.2, 0.85], [2.9, 1.15], [0, 1.15]].map(([x, y]) => new THREE.Vector2(x, y));
  const disc = new THREE.LatheGeometry(profile, 48);
  for (const y of [-3.75, 3.75]) {
    const p = new THREE.Mesh(disc, material.plate);
    p.position.y = y;
    g.add(p);
  }
  return g;
}

/** Le décor d'une vignette ; `top` est le haut du cadre, jusqu'où monte un mur. */
export function buildProps(props: readonly Prop[], exercise: string, m: PropMaterials, top: number): THREE.Group {
  const g = new THREE.Group();
  for (const prop of props) {
    const d = depthOf(exercise, prop.kind);
    switch (prop.kind) {
      case 'wall':
        g.add(slab(prop.x, prop.x - prop.face * 4, 0, top + 10, d, m.pad, 0.3));
        break;
      case 'chair': {
        const { seat, depth, back } = FURNITURE.chair;
        const f = prop.face;
        const b = prop.x - f * depth;
        g.add(slab(prop.x, b, seat - 2, seat, d, m.pad, 0.6));
        for (const x of [prop.x - f * 1.5, b + f * 1.5]) {
          for (const z of [d.z - d.width / 2 + 1.5, d.z + d.width / 2 - 1.5]) g.add(rod(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, seat - 2, z), 0.6, m.metal));
        }
        if (prop.back !== false) {
          for (const z of [d.z - d.width / 2 + 1.5, d.z + d.width / 2 - 1.5]) g.add(rod(new THREE.Vector3(b + f * 1.5, seat, z), new THREE.Vector3(b - f * 0.5, back, z), 0.6, m.metal));
          const panel = slab(b - f * 1.2, b + f * 0.6, back - 11, back, { width: d.width - 2, z: d.z }, m.pad, 0.5);
          panel.rotation.z = f * 0.1;
          g.add(panel);
        }
        break;
      }
      case 'sofa': {
        const { seat, depth, back } = FURNITURE.sofa;
        const f = prop.face;
        const b = prop.x - f * depth;
        g.add(slab(prop.x, b, 3, seat - 6, d, m.pad, 1));
        g.add(slab(prop.x, b + f * 6, seat - 6, seat, d, m.pad, 1.6));
        g.add(slab(b, b + f * 6.5, seat - 6, back, d, m.pad, 1.6));
        for (const x of [prop.x - f * 2, b + f * 2]) {
          for (const z of [d.z - d.width / 2 + 3, d.z + d.width / 2 - 3]) g.add(rod(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 3, z), 0.8, m.metal));
        }
        break;
      }
      case 'stool': {
        const { seat, depth } = FURNITURE.stool;
        const f = prop.face;
        const b = prop.x - f * depth;
        g.add(slab(prop.x, b, seat - 3, seat, d, m.pad, 0.6));
        for (const [xt, xb] of [[prop.x - f * 3, prop.x - f * 1.2], [b + f * 3, b + f * 1.2]] as const) {
          for (const s of [-1, 1]) {
            const zt = d.z + s * (d.width / 2 - 3);
            const zb = d.z + s * (d.width / 2 - 1.2);
            g.add(rod(new THREE.Vector3(xt, seat - 3, zt), new THREE.Vector3(xb, 0, zb), 0.75, m.pad));
          }
        }
        break;
      }
      case 'box':
        g.add(slab(prop.x, prop.x - prop.face * prop.depth, 0, prop.h, d, m.pad, 0.7));
        break;
      case 'bench':
        g.add(slab(prop.from, prop.to, prop.h - 2.6, prop.h, d, m.pad, 0.6));
        for (const x of [prop.from + 3, prop.to - 3]) g.add(slab(x - 0.7, x + 0.7, 0, prop.h - 2.6, { width: d.width - 3, z: d.z }, m.metal, 0.2));
        break;
      case 'stairs': {
        const { rise, run } = FURNITURE.stair;
        const end = prop.x + prop.n * run + 6;
        g.add(slab(prop.x - 6, end, -0.01, 0, d, m.pad, 0));
        for (let i = 1; i <= prop.n; i++) g.add(slab(prop.x + (i - 1) * run, end, (i - 1) * rise, i * rise, d, m.pad, 0.3));
        if (prop.rail) {
          // La rampe : à 90 cm au-dessus des nez de marche, du côté de la main libre.
          const railY = (x: number) => 50 + rise + ((x - prop.x) / run) * rise;
          const z = 14;
          const x0 = prop.x - 3;
          const x1 = prop.x + prop.n * run + 3;
          g.add(rod(new THREE.Vector3(x0, railY(x0), z), new THREE.Vector3(x1, railY(x1), z), 0.7, m.metal));
          g.add(rod(new THREE.Vector3(prop.x + 1, rise, z), new THREE.Vector3(prop.x + 1, railY(prop.x + 1), z), 0.5, m.metal));
          g.add(rod(new THREE.Vector3(x1 - 5, prop.n * rise, z), new THREE.Vector3(x1 - 5, railY(x1 - 5), z), 0.5, m.metal));
        }
        break;
      }
      case 'mat':
        g.add(slab(prop.from, prop.to, 0, FURNITURE.mat, d, m.mat, 0.25));
        break;
      case 'towel':
        g.add(slab(prop.x - prop.w / 2, prop.x + prop.w / 2, 0, 0.8, d, m.towel, 0.3));
        break;
      case 'jamb':
        // Le chambranle, vu de profil : un montant de 4 cm, de la hauteur du cadre.
        g.add(slab(prop.x - 1.2, prop.x + 1.2, 0, top + 10, d, m.pad, 0.4));
        break;
      case 'door': {
        // La porte vue par la tranche ; l'accroche : le cylindre de l'autre côté, la sangle sous la
        // porte, le crochet de notre côté, là où l'élastique se prend (`doorHook`).
        const face = prop.face ?? -1;
        g.add(slab(prop.x, prop.x + 2.2, 0, top + 10, d, m.pad, 0.3));
        const front = d.z + d.width / 2;
        const block = face === -1 ? prop.x + 2.4 : prop.x - 2.8;
        g.add(slab(block, block + 2.6, prop.anchor - 1.8, prop.anchor + 1.8, { width: 3.2, z: front - 2 }, m.band, 0.9));
        const hook = doorHook(prop.x, prop.anchor, face);
        const toward = face === -1 ? 1.2 : -1.2;
        const from = face === -1 ? block : block + 2.6;
        g.add(slab(Math.min(from, hook[0] + toward), Math.max(from, hook[0] + toward), prop.anchor - 0.35, prop.anchor + 0.35, { width: 1.6, z: front - 2 }, m.band, 0.15));
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.28, 10, 28), m.band);
        ring.position.set(hook[0] + toward, prop.anchor, front - 2);
        g.add(ring);
        break;
      }
      case 'backdrop':
        // Un fond : le mur derrière, d'un ton sous le papier.
        g.add(slab(prop.from, prop.to, 0, prop.top, d, m.backdrop, 0));
        break;
      case 'shape': {
        const tone = prop.tone ?? 'metal';
        const material = tone === 'pad' ? m.pad : m.metal;
        if (prop.closed && prop.pts.length >= 3) {
          // Un rembourré : la forme du dessin, prise dans l'épaisseur, les arêtes adoucies.
          const shape = new THREE.Shape(prop.pts.map(([x, y]) => new THREE.Vector2(x, y)));
          const bevel = 0.45;
          const geo = new THREE.ExtrudeGeometry(shape, {
            depth: Math.max(0.2, d.width - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 4,
          });
          geo.translate(0, 0, d.z - d.width / 2 + bevel);
          g.add(new THREE.Mesh(geo, material));
        } else {
          // Un tracé ouvert : le bâti en tubes, derrière le corps ; un rembourré à deux points, un plateau.
          for (let i = 1; i < prop.pts.length; i++) {
            const [a, b] = [prop.pts[i - 1]!, prop.pts[i]!];
            if (tone === 'pad') {
              const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
              const bar = new THREE.Mesh(new RoundedBoxGeometry(len, 2.4, d.width, 2, 0.6), material);
              bar.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d.z);
              bar.rotation.z = Math.atan2(b[1] - a[1], b[0] - a[0]);
              g.add(bar);
            } else {
              const r = tone === 'line' ? 0.4 : 0.75;
              g.add(rod(new THREE.Vector3(a[0], a[1], FRAME_Z), new THREE.Vector3(b[0], b[1], FRAME_Z), r, material));
            }
          }
        }
        break;
      }
      case 'circle': {
        const tone = prop.tone ?? 'metal';
        // Un coussin, un rouleau : un cylindre dans la profondeur. Un volant, une poulie : un disque, derrière.
        const width = tone === 'pad' ? d.width : tone === 'line' ? 1.4 : 3;
        const z = tone === 'pad' ? d.z : FRAME_Z;
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(prop.r, prop.r, width, 48, 1), tone === 'pad' ? m.pad : m.metal);
        cyl.rotation.x = Math.PI / 2;
        cyl.position.set(prop.c[0], prop.c[1], z);
        g.add(cyl);
        break;
      }
      case 'dumbbell': {
        const db = dumbbell({ handle: m.metal, plate: m.plate });
        db.position.set(prop.at[0], prop.at[1], 0);
        db.rotation.z = Math.PI / 2 + ((prop.deg ?? 0) * Math.PI) / 180;
        g.add(db);
        break;
      }
      default:
        break;
    }
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return g;
}
