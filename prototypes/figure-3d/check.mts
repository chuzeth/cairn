/**
 * Les garanties des schémas, vérifiées sur le mannequin 3D posé.
 *
 * `tests/exercise-figures.test.ts` vérifie le dessin : longueurs de Winter,
 * appuis où ils sont dits, rien sous le sol. Ici, la même chose sur le
 * maillage skinné, sommet par sommet, à cinq instants du geste : les
 * articulations 3D, vues de profil, tombent sur celles du dessin ; les
 * segments gardent leur longueur ; la peau touche les appuis sans les
 * traverser ; rien ne passe sous le sol ni dans le banc ou la caisse.
 *
 * Usage : ../../node_modules/.bin/tsx check.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FIGURES } from '../../apps/web/lib/exerciseFigures';
import { SEG, between, parts, skeleton, type Contact, type Panel, type SidePose } from '../../apps/web/lib/figure';
import { parseRig, type Rig } from './src/rig';
import { BENCH, BOX } from './src/props';

const here = import.meta.dirname;
const glb = fs.readFileSync(path.join(here, 'www/mannequin.glb'));
const EXERCISES = ['split-squat-bulgare', 'step-up', 'dead-bug'] as const;
const TIMES = [0, 0.25, 0.5, 0.75, 1];

let failures = 0;
/** Les défauts du dessin, que le 3D ne fait que rendre visibles. */
let inherited = 0;
const report: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  report.push(`${ok ? 'ok ' : 'NON'}  ${what}`);
};

/** Les sommets dont le poids sur les os `test` dépasse `min`. */
function vertsOf(rig: Rig, test: (bone: string) => boolean, min = 0.5): number[] {
  const d = rig.restData();
  const out: number[] = [];
  for (let i = 0; i < d.pos.length / 3; i++) if (d.weightOf(i, test) >= min) out.push(i);
  return out;
}

/** L'os qui porte le plus un sommet : pour dire quelle partie du corps est en cause. */
function boneOf(rig: Rig, i: number): string {
  const g = rig.body.geometry;
  let best = 0, w = -1;
  for (let c = 0; c < 4; c++) if (g.attributes.skinWeight!.getComponent(i, c) > w) { w = g.attributes.skinWeight!.getComponent(i, c); best = g.attributes.skinIndex!.getComponent(i, c); }
  const b = rig.body.skeleton.bones[best]!;
  return (b.userData.name as string) ?? b.name;
}

for (const ex of EXERCISES) {
  const rig = await parseRig(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  const panel: Panel = FIGURES[ex]!.panels[0]!;
  const n = rig.body.geometry.attributes.position!.count;
  const feet = { R: vertsOf(rig, (b) => b === 'foot.R'), L: vertsOf(rig, (b) => b === 'foot.L') };
  const trunk = vertsOf(rig, (b) => /^(root|spine0\d|pelvis)/.test(b));
  const v = new THREE.Vector3();
  report.push(`\n── ${ex}`);

  for (const t of TIMES) {
    const pose = (panel.ghost ? between(panel.ghost, panel.pose, t) : panel.pose) as SidePose;
    const k = skeleton(pose);
    rig.pose(k, pose, { hold: panel.hold === 'dumbbell', supine: pose.lean < -60 });
    const at = `t = ${t.toFixed(2)}`;

    // Les longueurs de Winter.
    const L = rig.lengths();
    const lengthErr = Math.max(
      Math.abs(L.thigh - SEG.thigh), Math.abs(L.shank - SEG.shank), Math.abs(L.upperArm - SEG.upperArm),
      Math.abs(L.forearm - SEG.forearm), Math.abs(L.trunk - SEG.trunk),
    );
    check(lengthErr < 0.05, `${at} longueurs de Winter, écart max ${lengthErr.toFixed(3)}`);

    // Les articulations vues de profil sur celles du dessin.
    const pairs: [string, string][] = [
      ['upperleg01.R', 'near.hip'], ['lowerleg01.R', 'near.knee'], ['foot.R', 'near.ankle'],
      ['upperleg01.L', 'far.hip'], ['lowerleg01.L', 'far.knee'], ['foot.L', 'far.ankle'],
      ['upperarm01.R', 'free.shoulder'],
    ];
    let worst = 0, worstName = '';
    for (const [bone, joint] of pairs) {
      rig.head(bone, v);
      const p = k.joints[joint]!;
      const e = Math.hypot(v.x - p[0], v.y - p[1]);
      if (e > worst) { worst = e; worstName = joint; }
    }
    check(worst < 0.1, `${at} hanches, genoux, chevilles, épaule sur le dessin : écart max ${worst.toFixed(3)} (${worstName})`);
    // Le bras libre s'écarte du corps : vu de profil, il raccourcit d'autant, pas plus.
    for (const [bone, joint] of [['lowerarm01.R', 'free.elbow'], ['wrist.R', 'free.wrist']] as const) {
      rig.head(bone, v);
      const p = k.joints[joint]!;
      check(Math.hypot(v.x - p[0], v.y - p[1]) < 0.9, `${at} ${joint} à ${Math.hypot(v.x - p[0], v.y - p[1]).toFixed(2)} du dessin (bras écarté de 7 à 9°)`);
    }

    // Rien sous le sol.
    let lowest = Infinity, li = 0;
    for (let i = 0; i < n; i++) if (rig.vertex(i, v).y < lowest) { lowest = v.y; li = i; }
    check(lowest >= -0.8, `${at} le corps descend à ${lowest.toFixed(2)} (≥ −0,8)${lowest < -0.8 ? ` — ${boneOf(rig, li)}` : ''}`);

    // Les appuis : la peau à la hauteur dite.
    const contacts: Contact[] = t === 1 ? panel.contacts ?? [] : t === 0 ? panel.ghostContacts ?? [] : [];
    for (const c of contacts) {
      const tol = c.tol ?? 0.6;
      let y: number;
      let what: string;
      if (c.ref) {
        const [side, point] = c.ref.split('.') as ['near' | 'far', string];
        const s = side === 'near' ? 'R' : 'L';
        const ankle = rig.head(`foot.${s}`);
        // Le talon : la peau derrière la cheville ; l'avant du pied : sous les têtes des métatarses.
        const ys = feet[s].map((i) => rig.vertex(i, new THREE.Vector3())).filter((q) => (point === 'heel' ? q.x < ankle.x - 1 : q.x > ankle.x + 5 && q.x < ankle.x + 10));
        y = Math.min(...ys.map((q) => q.y));
        what = c.ref;
      } else {
        const list = c.part === 'trunk' ? trunk : c.part === 'far.foot' ? feet.L : feet.R;
        y = Math.min(...list.map((i) => rig.vertex(i, v).y));
        what = c.part!;
      }
      check(Math.abs(y - c.y) <= tol, `${at} appui ${what} à ${y.toFixed(2)} pour ${c.y.toFixed(2)} (± ${tol})`);
    }

    // Le décor : la peau ne traverse ni le banc ni la caisse.
    for (const prop of panel.props) {
      if (prop.kind !== 'bench' && prop.kind !== 'box') continue;
      const [x0, x1, h, z0, z1] = prop.kind === 'bench'
        ? [prop.from, prop.to, prop.h, BENCH.z - BENCH.width / 2, BENCH.z + BENCH.width / 2]
        : [Math.min(prop.x, prop.x - prop.face * prop.depth), Math.max(prop.x, prop.x - prop.face * prop.depth), prop.h, BOX.z - BOX.width / 2, BOX.z + BOX.width / 2];
      let depth = 0, di = -1;
      for (let i = 0; i < n; i++) {
        rig.vertex(i, v);
        if (v.x > x0 && v.x < x1 && v.z > z0 && v.z < z1 && v.y < h && h - v.y > depth) { depth = h - v.y; di = i; }
      }
      // Le même recouvrement sur le dessin : s'il y est déjà, le 3D n'ajoute rien, il le montre.
      let flat = 0;
      for (const part of parts(pose).parts) for (const [x, y] of part.pts) if (x > x0 && x < x1 && y < h) flat = Math.max(flat, h - y);
      const where = depth > 0.8 ? ` — ${boneOf(rig, di)}, en ${rig.vertex(di, v).toArray().map((u) => u.toFixed(1)).join(', ')}` : '';
      if (depth > 0.8 && depth <= flat + 0.3) {
        inherited++;
        report.push(`hér  ${at} ${prop.kind} : la peau y entre de ${depth.toFixed(2)}, le dessin de ${flat.toFixed(2)}${where}`);
      } else check(depth <= 0.8, `${at} ${prop.kind} : la peau y entre de ${depth.toFixed(2)} (≤ 0,8 ; le dessin : ${flat.toFixed(2)})${where}`);
    }
  }
}

console.log(report.join('\n'));
console.log(failures === 0 ? '\nToutes les garanties tiennent sur le mannequin.' : `\n${failures} garantie(s) en défaut.`);
if (inherited > 0) console.log(`${inherited} recouvrement(s) hérité(s) du dessin (« hér ») : la pose 2D les a déjà, le profil les cache.`);
process.exit(failures === 0 ? 0 : 1);
