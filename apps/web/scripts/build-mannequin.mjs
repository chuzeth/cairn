/**
 * Le mannequin des schémas 3D : le maillage de base de MakeHuman, son squelette
 * par défaut et ses poids, réunis en un glTF riggé aux coordonnées des schémas,
 * chaussé de chaussures de course.
 *
 * Source : https://github.com/makehumancommunity/makehuman (branche master),
 * `makehuman/data/3dobjs/base.obj`, `data/rigs/default.mhskel`,
 * `data/rigs/default_weights.mhw`, `data/targets/macrodetails/…`. Licence :
 * CC0 1.0 — `LICENSE.md` §C (« These assets have been released under CC0 1.0
 * Universal ») et `LICENSE.ASSETS.md` ; chaque fichier le redit dans son
 * en-tête (`"license": "CC0"`, « explicitly released as CC0 in september
 * 2020 »). MakeHuman ne publie pas de chaussures sous une licence qu'on puisse
 * lire à la source : elles sont faites ici, à partir du pied.
 *
 * Usage : node apps/web/scripts/build-mannequin.mjs <dossier des fichiers MakeHuman>
 * Le fichier sort dans `public/figures/`, nommé par son empreinte : changer le
 * mannequin, c'est changer `MODEL_URL` (`lib/figure3d/model.ts`) et la liste du
 * service worker — `tests/exercise-figures-3d.test.ts` le vérifie.
 *
 * Le corps est celui d'un homme jeune, musclé et sec (les cibles macro de
 * MakeHuman, mélangées comme le fait son curseur). Repère des schémas : x vers
 * l'avant, y vers le haut, z vers nous — le côté droit du corps, celui qu'on
 * voit de profil. Unité : 1 = 1/100 de la taille, le sol à 0.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, quantize, reorder, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const src = process.argv[2];
if (!src) throw new Error('Usage : node build-mannequin.mjs <dossier MakeHuman>');
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');
const out = path.join(import.meta.dirname, '../public/figures');
fs.mkdirSync(out, { recursive: true });

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ── Le maillage ─────────────────────────────────────────────────────────────
const verts = [];
const faces = {};
let group = null;
for (const line of read('base.obj').split('\n')) {
  if (line.startsWith('v ')) verts.push(line.split(/\s+/).slice(1, 4).map(Number));
  else if (line.startsWith('g ')) group = line.slice(2).trim();
  else if (line.startsWith('f ')) (faces[group] ??= []).push(line.split(/\s+/).slice(1).filter(Boolean).map((t) => Number(t.split('/')[0]) - 1));
}

// ── Les cibles : homme jeune, muscle 0,8, poids 0,3, proportions idéales ────
// Le curseur de MakeHuman : 0,5 la moyenne, 1 le maximum. Muscle 0,8 → 60 %
// « max », 40 % « average » ; poids 0,3 → 40 % « min », 60 % « average ».
const MUSCLE = { averagemuscle: 0.4, maxmuscle: 0.6 };
const WEIGHT = { minweight: 0.4, averageweight: 0.6 };
for (const [m, wm] of Object.entries(MUSCLE)) {
  for (const [w, ww] of Object.entries(WEIGHT)) {
    for (const file of [`universal-male-young-${m}-${w}.target`, `male-young-${m}-${w}-idealproportions.target`]) {
      for (const line of read(file).split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const [i, dx, dy, dz] = line.trim().split(/\s+/).map(Number);
        const v = verts[i];
        v[0] += dx * wm * ww; v[1] += dy * wm * ww; v[2] += dz * wm * ww;
      }
    }
  }
}

// ── Le repère des schémas ───────────────────────────────────────────────────
// MakeHuman regarde vers +z, sa droite en −x : x' = z, z' = −x (un quart de
// tour autour de y). Mis à l'échelle de 100 unités, la plante des pieds à 0.
const body = new Set(faces.body.flat());
const ys = [...body].map((i) => verts[i][1]);
const floor = Math.min(...ys);
const scale = 100 / (Math.max(...ys) - floor);
const world = verts.map(([x, y, z]) => [z * scale, (y - floor) * scale, -x * scale]);

// ── Le squelette ────────────────────────────────────────────────────────────
const skel = JSON.parse(read('default.mhskel'));
const joint = (name) => {
  const ids = skel.joints[name];
  const p = [0, 0, 0];
  for (const i of ids) for (let k = 0; k < 3; k++) p[k] += world[i][k] / ids.length;
  return p;
};
/** Les os gardés : le tronc, les membres, les doigts. Le visage, les orteils, la langue vont à leur ancêtre gardé. */
const KEEP = /^(root|spine0[1-5]|neck0[1-3]|head|pelvis|upperleg|lowerleg|foot|clavicle|shoulder01|upperarm|lowerarm|wrist|metacarpal|finger)/;
const kept = Object.keys(skel.bones).filter((n) => KEEP.test(n));
const keptOf = (n) => {
  while (n && !kept.includes(n)) n = skel.bones[n].parent;
  return n;
};
const order = [];
const visit = (n) => {
  if (order.includes(n)) return;
  const p = skel.bones[n].parent;
  if (p) visit(p);
  order.push(n);
};
kept.forEach(visit);
const index = new Map(order.map((n, i) => [n, i]));
const heads = order.map((n) => joint(skel.bones[n].head));
const tails = order.map((n) => joint(skel.bones[n].tail));

// ── Les poids : quatre os par sommet, au plus ───────────────────────────────
const mhw = JSON.parse(read('default_weights.mhw')).weights;
const per = world.map(() => new Map());
for (const [bone, list] of Object.entries(mhw)) {
  const b = index.get(keptOf(bone));
  for (const [v, w] of list) per[v].set(b, (per[v].get(b) ?? 0) + w);
}

// ── Le buste, recentré sur l'axe du dessin ──────────────────────────────────
// Le buste de MakeHuman est porté plus en avant de l'axe hanches → épaules que
// le contour du dessin (de 1 à 3 unités) : couché sur le dos, il flottait au-dessus
// du sol que le dessin touche. Il est recentré, hauteur par hauteur, sur le milieu
// du contour 2D (`sideParts` de `lib/figure`), sans changer son épaisseur ; les
// articulations ne bougent pas.
{
  const FRONT2D = [[-5.6, 1.2], [-3.2, 4.4], [1.5, 5.2], [7.5, 5.0], [12.5, 5.0], [17.5, 5.9], [21, 6.1], [25, 5.0], [28.6, 3.4], [31.4, 0.8]];
  const BACK2D = [[-3.6, -6.2], [0.4, -7.0], [4, -5.6], [8.5, -4.7], [13, -5.2], [18.5, -6.3], [25, -6.4], [28.8, -6.2], [31.5, -4.7], [32.4, -2.0]];
  const at = (pts, h) => {
    if (h <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) if (h <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (h - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
    return pts[pts.length - 1][1];
  };
  const mid = (a, b) => heads[index.get(a)].map((x, k) => (x + heads[index.get(b)][k]) / 2);
  const hip = mid('upperleg01.R', 'upperleg01.L');
  const sh = mid('upperarm01.R', 'upperarm01.L');
  const len = Math.hypot(sh[0] - hip[0], sh[1] - hip[1]);
  const up = [(sh[0] - hip[0]) / len, (sh[1] - hip[1]) / len];
  const front = [up[1], -up[0]];
  const isTrunk = order.map((n) => /^(root|spine0[1-5]|pelvis|clavicle|neck01)/.test(n));
  const isArm = order.map((n) => /^(upperarm|lowerarm|wrist|metacarpal|finger)/.test(n));
  const weightOn = (v, mask) => [...per[v].entries()].reduce((s, [b, w]) => s + (mask[b] ? w : 0), 0);
  const frame = (v) => {
    const r = [world[v][0] - hip[0], world[v][1] - hip[1]];
    return { h: ((r[0] * up[0] + r[1] * up[1]) * 28.8) / len, f: r[0] * front[0] + r[1] * front[1] };
  };
  const trunkVerts = [...body].map((v) => ({ v, w: weightOn(v, isTrunk), arm: weightOn(v, isArm), ...frame(v) }));
  const raw = [];
  for (let h = -4; h <= 31; h++) {
    let f3 = -Infinity, b3 = Infinity;
    for (const t of trunkVerts) {
      if (t.w < 0.5 || Math.abs(t.h - h) > 0.6) continue;
      if (Math.abs(world[t.v][2]) < 4) f3 = Math.max(f3, t.f);
      if (Math.abs(world[t.v][2]) < 9.5 && t.arm < 0.2) b3 = Math.min(b3, t.f);
    }
    raw.push((at(FRONT2D, h) + at(BACK2D, h)) / 2 - (f3 + b3) / 2);
  }
  const shift = raw.map((_, i) => {
    const win = raw.slice(Math.max(0, i - 2), i + 3);
    return win.reduce((a, b) => a + b, 0) / win.length;
  });
  const shiftAt = (h) => {
    const i = Math.max(0, Math.min(shift.length - 1, h + 4));
    const lo = Math.floor(i), hi = Math.min(shift.length - 1, lo + 1);
    const d = shift[lo] + (shift[hi] - shift[lo]) * (i - lo);
    return d * (1 - smooth(31, 34, h)) * smooth(-9, -4, h);
  };
  for (const t of trunkVerts) {
    if (t.w <= 0) continue;
    const d = shiftAt(t.h) * t.w;
    world[t.v][0] += d * front[0];
    world[t.v][1] += d * front[1];
  }
  console.log('buste recentré (h : décalage) :', shift.map((d, i) => `${i - 4}:${d.toFixed(1)}`).filter((_, i) => i % 3 === 0).join(' '));
}

// ── Les chaussures ──────────────────────────────────────────────────────────
// Une chaussure de course basse, faite du pied lui-même : sous le col (plus haut
// au talon qu'au cou-de-pied), les orteils fondus en un bout arrondi, la tige
// gonflée de l'épaisseur du cuir, la voûte comblée par une semelle plate et un
// peu évasée. La cheville ne monte pas : les appuis du dessin restent justes.
const neighbours = world.map(() => new Set());
for (const f of faces.body) {
  for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    neighbours[a].add(b);
    neighbours[b].add(a);
  }
}
/** Les normales lissées d'un ensemble de positions, pondérées par l'aire. */
function normalsOf(pos) {
  const n = pos.map(() => [0, 0, 0]);
  for (const f of faces.body) {
    for (let k = 1; k + 1 < f.length; k++) {
      const [a, b, c] = [pos[f[0]], pos[f[k]], pos[f[k + 1]]];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      for (const i of [f[0], f[k], f[k + 1]]) for (let j = 0; j < 3; j++) n[i][j] += cr[j];
    }
  }
  return n.map((v) => {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  });
}
const shoe = world.map(() => [0, 0]);
for (const side of ['R', 'L']) {
  const ankle = heads[index.get(`foot.${side}`)];
  const foot = index.get(`foot.${side}`);
  const shin = index.get(`lowerleg02.${side}`);
  const zone = [...body].filter((v) => (per[v].get(foot) ?? 0) + (per[v].get(shin) ?? 0) > 0.5 && world[v][1] < 7);
  const u = (v) => world[v][0] - ankle[0];
  // Le col : 5,2 au talon, 4,1 au cou-de-pied, tout l'avant-pied dedans.
  const collar = (x) => (x < -1 ? 5.2 : x < 2.5 ? 5.2 - ((x + 1) / 3.5) * 1.1 : 4.1);
  const inside = new Map(zone.map((v) => [v, 1 - smooth(collar(u(v)) - 0.45, collar(u(v)) + 0.45, world[v][1])]));
  // Les orteils fondus : un lissage de Taubin, qui ne fait pas fondre le volume.
  const toes = zone.filter((v) => u(v) > 2.5);
  for (let it = 0; it < 14; it++) {
    for (const lambda of [0.5, -0.53]) {
      const moved = toes.map((v) => {
        const ns = [...neighbours[v]];
        const c = [0, 0, 0];
        for (const q of ns) for (let k = 0; k < 3; k++) c[k] += world[q][k] / ns.length;
        const t = smooth(2.5, 5.5, u(v)) * lambda;
        return world[v].map((x, k) => x + (c[k] - x) * t);
      });
      toes.forEach((v, i) => { world[v] = moved[i]; });
    }
  }
  const n = normalsOf(world);
  for (const v of zone) {
    const s = inside.get(v);
    if (s < 0.01) continue;
    const p = world[v];
    // La voûte comblée : ce qui regarde le sol descend au plat de la semelle.
    const down = smooth(-0.3, -0.8, n[v][1]) * (1 - smooth(1.0, 2.0, p[1]));
    p[1] = p[1] * (1 - down * s);
    // Le talon renforcé, qui dépasse derrière comme celui du dessin (5 unités derrière la cheville) ;
    // la pointe relevée de 0,8 au bout, comme la sienne.
    const y0 = p[1];
    p[0] -= 1.5 * smooth(-0.5, -2.5, u(v)) * (1 - smooth(1.0, 3.6, y0)) * s;
    p[1] += 0.8 * smooth(8.5, 11.5, u(v)) * (1 - smooth(0.3, 1.6, y0)) * s;
    // La tige : l'épaisseur du cuir ; la semelle : un rebord qui dépasse un peu.
    const low = 1 - smooth(0.35, 1.3, p[1]);
    const lateral = Math.sign(p[2] - ankle[2]) || 1;
    p[0] += n[v][0] * 0.32 * s * (1 - low) + (u(v) < -1 ? -0.18 : 0) * low * s;
    p[1] = Math.max(0, p[1] + n[v][1] * 0.32 * s * (1 - low));
    p[2] += n[v][2] * 0.32 * s * (1 - low) + lateral * 0.28 * low * s;
    shoe[v] = [s, s * (1 - smooth(0.85, 1.35, p[1]))];
  }
}

// ── Les primitives : le corps, les yeux ─────────────────────────────────────
function primitive(groups, withShoes) {
  const tris = [];
  for (const g of groups) for (const f of faces[g]) for (let k = 1; k + 1 < f.length; k++) tris.push(f[0], f[k], f[k + 1]);
  const used = [...new Set(tris)];
  const remap = new Map(used.map((v, i) => [v, i]));
  const count = used.length;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const joints = new Uint8Array(count * 4);
  const weights = new Float32Array(count * 4);
  const shoes = new Float32Array(count * 2);
  used.forEach((v, i) => {
    position.set(world[v], i * 3);
    shoes.set(withShoes ? shoe[v] : [0, 0], i * 2);
    const top = [...per[v].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    top.forEach(([b, w], k) => { joints[i * 4 + k] = b; weights[i * 4 + k] = w / sum; });
    if (top.length === 0) weights[i * 4] = 1;
  });
  const indices = new Uint16Array(tris.map((v) => remap.get(v)));
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => position.subarray(i * 3, i * 3 + 3));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0];
    for (const i of [indices[t], indices[t + 1], indices[t + 2]]) {
      normal[i * 3] += nx; normal[i * 3 + 1] += ny; normal[i * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < count; i++) {
    const l = Math.hypot(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]) || 1;
    normal[i * 3] /= l; normal[i * 3 + 1] /= l; normal[i * 3 + 2] /= l;
  }
  return { position, normal, joints, weights, shoes, indices };
}

// ── Le glTF ─────────────────────────────────────────────────────────────────
const doc = new Document();
const buffer = doc.createBuffer();
const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
const nodes = order.map((name, i) => {
  const p = skel.bones[name].parent ? heads[index.get(keptOf(skel.bones[name].parent))] : [0, 0, 0];
  // Le bout de l'os, au repos : ce qui lui donne sa direction (`userData.tail` dans three).
  return doc.createNode(name)
    .setTranslation([heads[i][0] - p[0], heads[i][1] - p[1], heads[i][2] - p[2]])
    .setExtras({ tail: tails[i].map((x) => Math.round(x * 1000) / 1000) });
});
order.forEach((name, i) => {
  const parent = skel.bones[name].parent && keptOf(skel.bones[name].parent);
  if (parent) nodes[index.get(parent)].addChild(nodes[i]);
});
const ibm = new Float32Array(order.length * 16);
heads.forEach((h, i) => ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -h[0], -h[1], -h[2], 1], i * 16));
const skin = doc.createSkin('rig').setSkeleton(nodes[0]).setInverseBindMatrices(acc('MAT4', ibm));
nodes.forEach((n) => skin.addJoint(n));

const mesh = doc.createMesh('mannequin');
for (const [name, groups, withShoes] of [['body', ['body'], true], ['eyes', ['helper-l-eye', 'helper-r-eye'], false]]) {
  const p = primitive(groups, withShoes);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', p.position))
    .setAttribute('NORMAL', acc('VEC3', p.normal))
    .setAttribute('JOINTS_0', acc('VEC4', p.joints))
    .setAttribute('WEIGHTS_0', acc('VEC4', p.weights))
    .setIndices(acc('SCALAR', p.indices))
    .setMaterial(doc.createMaterial(name));
  // La chaussure : sa tige, et sa semelle (`_shoe` dans three).
  if (withShoes) prim.setAttribute('_SHOE', acc('VEC2', p.shoes));
  mesh.addPrimitive(prim);
  console.log(`${name} : ${p.position.length / 3} sommets, ${p.indices.length / 3} triangles`);
}
const meshNode = doc.createNode('mannequin').setMesh(mesh).setSkin(skin);
doc.createScene('scene').addChild(nodes[0]).addChild(meshNode);
doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);
doc.getRoot().getAsset().copyright = 'MakeHuman assets, CC0 1.0 — https://github.com/makehumancommunity/makehuman';

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await doc.transform(weld(), reorder({ encoder: MeshoptEncoder }), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
const glb = await io.writeBinary(doc);
const name = `mannequin-${crypto.createHash('sha256').update(glb).digest('hex').slice(0, 8)}.glb`;
fs.writeFileSync(path.join(out, name), glb);
console.log(`${order.length} os ; ${(glb.length / 1024).toFixed(1)} Ko → public/figures/${name}`);
