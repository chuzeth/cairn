/**
 * Le mannequin : le maillage de base de MakeHuman, son squelette par défaut et
 * ses poids, réunis en un glTF riggé aux coordonnées des schémas.
 *
 * Source : https://github.com/makehumancommunity/makehuman (branche master),
 * `makehuman/data/3dobjs/base.obj`, `data/rigs/default.mhskel`,
 * `data/rigs/default_weights.mhw`, `data/targets/macrodetails/…`. Licence :
 * CC0 1.0 — `LICENSE.md` §C (« These assets have been released under CC0 1.0
 * Universal ») et `LICENSE.ASSETS.md` ; chaque fichier le redit dans son
 * en-tête (`"license": "CC0"`, « explicitly released as CC0 in september
 * 2020 »).
 *
 * Usage : node build-model.mjs <dossier des fichiers MakeHuman>
 *
 * Le corps est celui d'un homme jeune, musclé et sec (les cibles macro de
 * MakeHuman, mélangées comme le fait son curseur). Repère des schémas : x vers
 * l'avant, y vers le haut, z vers nous — le côté droit du corps, celui qu'on
 * voit de profil. Unité : 1 = 1/100 de la taille, le sol à 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt, quantize, reorder, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const src = process.argv[2];
if (!src) throw new Error('Usage : node build-model.mjs <dossier MakeHuman>');
const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');
const out = path.join(import.meta.dirname, 'www');
fs.mkdirSync(out, { recursive: true });

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
const targets = [];
for (const [m, wm] of Object.entries(MUSCLE)) {
  for (const [w, ww] of Object.entries(WEIGHT)) {
    targets.push([`universal-male-young-${m}-${w}.target`, wm * ww]);
    targets.push([`male-young-${m}-${w}-idealproportions.target`, wm * ww]);
  }
}
for (const [file, k] of targets) {
  for (const line of read(file).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [i, dx, dy, dz] = line.trim().split(/\s+/).map(Number);
    const v = verts[i];
    v[0] += dx * k; v[1] += dy * k; v[2] += dz * k;
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
// Parents avant enfants.
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

// ── Les primitives : le corps, les yeux ─────────────────────────────────────
function primitive(groups) {
  const tris = [];
  for (const g of groups) {
    for (const f of faces[g]) for (let k = 1; k + 1 < f.length; k++) tris.push(f[0], f[k], f[k + 1]);
  }
  const used = [...new Set(tris)];
  const remap = new Map(used.map((v, i) => [v, i]));
  const n = used.length;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const joints = new Uint8Array(n * 4);
  const weights = new Float32Array(n * 4);
  used.forEach((v, i) => {
    position.set(world[v], i * 3);
    const top = [...per[v].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
    top.forEach(([b, w], k) => { joints[i * 4 + k] = b; weights[i * 4 + k] = w / sum; });
    if (top.length === 0) weights[i * 4] = 1;
  });
  const indices = new Uint16Array(tris.map((v) => remap.get(v)));
  // Normales lissées, pondérées par l'aire.
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map((i) => position.subarray(i * 3, i * 3 + 3));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0];
    for (const i of [indices[t], indices[t + 1], indices[t + 2]]) {
      normal[i * 3] += nx; normal[i * 3 + 1] += ny; normal[i * 3 + 2] += nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(normal[i * 3], normal[i * 3 + 1], normal[i * 3 + 2]) || 1;
    normal[i * 3] /= l; normal[i * 3 + 1] /= l; normal[i * 3 + 2] /= l;
  }
  return { position, normal, joints, weights, indices };
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
for (const [name, groups] of [['body', ['body']], ['eyes', ['helper-l-eye', 'helper-r-eye']]]) {
  const p = primitive(groups);
  mesh.addPrimitive(
    doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', p.position))
      .setAttribute('NORMAL', acc('VEC3', p.normal))
      .setAttribute('JOINTS_0', acc('VEC4', p.joints))
      .setAttribute('WEIGHTS_0', acc('VEC4', p.weights))
      .setIndices(acc('SCALAR', p.indices))
      .setMaterial(doc.createMaterial(name)),
  );
  console.log(`${name} : ${p.position.length / 3} sommets, ${p.indices.length / 3} triangles`);
}
const meshNode = doc.createNode('mannequin').setMesh(mesh).setSkin(skin);
doc.createScene('scene').addChild(nodes[0]).addChild(meshNode);
doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0]);
doc.getRoot().getAsset().copyright = 'MakeHuman assets, CC0 1.0 — https://github.com/makehumancommunity/makehuman';

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await io.write(path.join(out, 'mannequin.raw.glb'), doc);
await doc.transform(weld(), reorder({ encoder: MeshoptEncoder }), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
await io.write(path.join(out, 'mannequin.glb'), doc);

const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(1);
console.log(`${order.length} os ; brut ${kb('mannequin.raw.glb')} Ko, compressé (meshopt) ${kb('mannequin.glb')} Ko`);
// Les mesures du repos, pour comparer aux longueurs de Winter.
const at = (n) => heads[index.get(n)];
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
console.log({
  thigh: d(at('upperleg01.R'), at('lowerleg01.R')).toFixed(1),
  shank: d(at('lowerleg01.R'), at('foot.R')).toFixed(1),
  ankleHeight: at('foot.R')[1].toFixed(1),
  hipHeight: at('upperleg01.R')[1].toFixed(1),
  trunk: d([0, at('upperleg01.R')[1], 0], [0, at('upperarm01.R')[1], 0]).toFixed(1),
  upperArm: d(at('upperarm01.R'), at('lowerarm01.R')).toFixed(1),
  forearm: d(at('lowerarm01.R'), at('wrist.R')).toFixed(1),
});
