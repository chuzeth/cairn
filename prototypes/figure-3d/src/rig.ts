/**
 * Le mannequin, posé par les squelettes des schémas.
 *
 * Les poses ne changent pas : `lib/figure` résout toujours un squelette 2D de
 * profil — hanche, genou, cheville, épaule, coude, poignet, inclinaison du
 * buste, plante du pied. Ici, chaque segment du mannequin tourne pour prendre
 * la direction de son segment 2D, dans le plan du profil. Les longueurs sont
 * remises à celles de Winter avant tout : une cuisse de 24,5, un tibia de
 * 24,6, un bras de 18,6, un avant-bras de 14,6, un buste de 28,8. Le genou et
 * la cheville 3D tombent donc exactement sur ceux du dessin, vus de profil —
 * `check.mts` le vérifie, avec les appuis.
 *
 * Repère : celui des schémas, x vers l'avant, y vers le haut, le sol à 0 ; z
 * vers nous. La jambe et le bras « de notre côté » sont les droits (`.R`).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { SEG, type ArmPts, type LegPts, type Pt, type Skeleton, type SidePose } from '../../../apps/web/lib/figure';

type Side = 'R' | 'L';
const RAD = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

const flat = (p: Pt, q: Pt) => new THREE.Vector3(q[0] - p[0], q[1] - p[1], 0).normalize();
/** La direction `v` tournée d'un quart de tour vers l'avant dans le plan du profil : (x, y) → (−y, x). */
const quarter = (v: THREE.Vector3) => new THREE.Vector3(-v.y, v.x, 0);
/** Le nom d'un os tel que MakeHuman l'écrit : GLTFLoader ôte les points (`upperleg01.R` → `upperleg01R`) et garde l'original. */
const nameOf = (o: THREE.Object3D): string => (o.userData.name as string | undefined) ?? o.name;
const perp = (v: THREE.Vector3, axis: THREE.Vector3) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
/** L'angle signé de `a` vers `b` autour de `axis` (les deux ramenés dans le plan normal). */
function signedAngle(a: THREE.Vector3, b: THREE.Vector3, axis: THREE.Vector3): number {
  const pa = perp(a, axis).normalize();
  const pb = perp(b, axis).normalize();
  if (pa.lengthSq() < 1e-8 || pb.lengthSq() < 1e-8) return 0;
  return Math.atan2(axis.dot(pa.clone().cross(pb)), pa.dot(pb));
}

/** Comment se tient un bras : sa main (paume vers où), ce qu'elle serre. */
export interface ArmStyle {
  /** Écarté du corps, degrés, dans le plan frontal : une main qui pend ne traverse pas la cuisse. */
  abduct?: number;
  /** La normale de la paume voulue, dans le monde. */
  palm?: THREE.Vector3;
  /** Les doigts repliés : 0 tendus, 1 le poing serré sur une poignée. */
  grip?: number;
}

export class Rig {
  readonly scene: THREE.Group;
  readonly body: THREE.SkinnedMesh;
  readonly meshes: THREE.SkinnedMesh[];
  readonly bones = new Map<string, THREE.Bone>();
  /** Les positions des têtes d'os au repos, avant les longueurs de Winter. */
  private readonly restHead = new Map<string, THREE.Vector3>();
  private readonly restLocal = new Map<string, THREE.Vector3>();
  /** Les longueurs du mannequin au repos, pour le rapport. */
  readonly restLengths: Record<string, number> = {};
  private readonly restPos: Float32Array;
  private readonly restNormal: Float32Array;

  constructor(gltf: { scene: THREE.Group }) {
    this.scene = gltf.scene;
    this.meshes = [];
    this.scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(nameOf(o), o as THREE.Bone);
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) this.meshes.push(o as THREE.SkinnedMesh);
    });
    this.body = this.meshes.find((m) => m.geometry.attributes.position!.count > 1000)!;
    this.scene.updateMatrixWorld(true);
    for (const [n, b] of this.bones) {
      this.restHead.set(n, b.getWorldPosition(new THREE.Vector3()));
      this.restLocal.set(n, b.position.clone());
    }
    // Le corps au repos, avant toute retouche : ce sur quoi les muscles se dessinent.
    const g = this.body.geometry;
    const n = g.attributes.position!.count;
    this.restPos = new Float32Array(n * 3);
    this.restNormal = new Float32Array(n * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      this.vertex(i, v);
      this.restPos.set([v.x, v.y, v.z], i * 3);
      v.fromBufferAttribute(g.attributes.normal as THREE.BufferAttribute, i).normalize();
      this.restNormal.set([v.x, v.y, v.z], i * 3);
    }
    const d = (a: string, b: string) => this.restHead.get(a)!.distanceTo(this.restHead.get(b)!);
    Object.assign(this.restLengths, {
      thigh: d('upperleg01.R', 'lowerleg01.R'),
      shank: d('lowerleg01.R', 'foot.R'),
      upperArm: d('upperarm01.R', 'lowerarm01.R'),
      forearm: d('lowerarm01.R', 'wrist.R'),
      ankle: this.restHead.get('foot.R')!.y,
      trunk: this.trunkLength(),
    });
    this.fitWinter();
  }

  bone(name: string): THREE.Bone {
    const b = this.bones.get(name);
    if (!b) throw new Error(`Os inconnu : ${name}`);
    return b;
  }

  head(name: string, out = new THREE.Vector3()): THREE.Vector3 {
    return this.bone(name).getWorldPosition(out);
  }

  /** Le bout d'un os, posé : son décalage au repos, porté par l'os. */
  tailOf(name: string): THREE.Vector3 {
    const b = this.bone(name);
    const off = new THREE.Vector3(...(b.userData.tail as [number, number, number])).sub(this.restHead.get(name)!);
    return b.localToWorld(off);
  }

  private mid(a: string, b: string) {
    return this.head(a).add(this.head(b)).multiplyScalar(0.5);
  }

  private trunkLength(): number {
    this.scene.updateMatrixWorld(true);
    const v = this.mid('upperarm01.R', 'upperarm01.L').sub(this.mid('upperleg01.R', 'upperleg01.L'));
    return Math.hypot(v.x, v.y);
  }

  /** Une chaîne d'os allongée ou raccourcie pour que `from` → `to` mesure `target`. */
  private stretch(chain: string[], from: string, to: string, target: number) {
    const f = target / this.restHead.get(from)!.distanceTo(this.restHead.get(to)!);
    for (const n of chain) this.bone(n).position.copy(this.restLocal.get(n)!).multiplyScalar(f);
  }

  /**
   * Les longueurs de Winter, celles des schémas. Le mannequin de MakeHuman a le
   * bras court (13,6 pour 18,6) : il est allongé, le reste bouge de quelques %.
   * La cheville est remise à 3,9 au-dessus de la plante en tassant le pied.
   */
  private fitWinter() {
    for (const s of ['R', 'L'] as const) {
      this.stretch([`upperleg02.${s}`, `lowerleg01.${s}`], `upperleg01.${s}`, `lowerleg01.${s}`, SEG.thigh);
      this.stretch([`lowerleg02.${s}`, `foot.${s}`], `lowerleg01.${s}`, `foot.${s}`, SEG.shank);
      this.stretch([`upperarm02.${s}`, `lowerarm01.${s}`], `upperarm01.${s}`, `lowerarm01.${s}`, SEG.upperArm);
      this.stretch([`lowerarm02.${s}`, `wrist.${s}`], `lowerarm01.${s}`, `wrist.${s}`, SEG.forearm);
      this.bone(`foot.${s}`).scale.set(1, SEG.ankle / this.restHead.get(`foot.${s}`)!.y, 1);
    }
    // Le buste : la colonne s'allonge jusqu'à 28,8 entre les hanches et les épaules.
    const spine = ['spine04', 'spine03', 'spine02', 'spine01'];
    let lo = 0.7, hi = 1.4;
    for (let i = 0; i < 30; i++) {
      const f = (lo + hi) / 2;
      for (const n of spine) this.bone(n).position.copy(this.restLocal.get(n)!).multiplyScalar(f);
      if (this.trunkLength() < SEG.trunk) lo = f; else hi = f;
    }
    this.scene.updateMatrixWorld(true);
  }

  /** Les longueurs actuelles, pour les vérifier. */
  lengths() {
    this.scene.updateMatrixWorld(true);
    const d = (a: string, b: string) => this.head(a).distanceTo(this.head(b));
    return {
      thigh: d('upperleg01.R', 'lowerleg01.R'),
      shank: d('lowerleg01.R', 'foot.R'),
      upperArm: d('upperarm01.R', 'lowerarm01.R'),
      forearm: d('lowerarm01.R', 'wrist.R'),
      trunk: this.trunkLength(),
    };
  }

  // ── Les rotations, dans le monde ──────────────────────────────────────────

  private setWorld(b: THREE.Bone, q: THREE.Quaternion) {
    const parent = b.parent!.getWorldQuaternion(new THREE.Quaternion());
    b.quaternion.copy(parent.invert().multiply(q));
    b.updateMatrixWorld(true);
  }

  private world(b: THREE.Bone) {
    return b.getWorldQuaternion(new THREE.Quaternion());
  }

  /** Tourne `b` au plus court pour que la direction `from` (monde) devienne `to`. */
  private swing(b: THREE.Bone, from: THREE.Vector3, to: THREE.Vector3) {
    const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
    this.setWorld(b, q.multiply(this.world(b)));
  }

  private twist(b: THREE.Bone, axis: THREE.Vector3, angle: number) {
    if (Math.abs(angle) < 1e-6) return;
    const q = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), angle);
    this.setWorld(b, q.multiply(this.world(b)));
  }

  private dirOf(a: string, b: string) {
    return this.head(b).sub(this.head(a)).normalize();
  }

  // ── La pose ───────────────────────────────────────────────────────────────

  /** Remet chaque os à son repos (longueurs de Winter gardées). */
  reset() {
    for (const b of this.bones.values()) b.quaternion.identity();
    this.scene.updateMatrixWorld(true);
  }

  /**
   * Le buste : le milieu des hanches sur la hanche du dessin, l'axe hanches →
   * épaules sur celui du dessin ; la tête suit `nod`.
   */
  trunk(k: Skeleton, p: SidePose) {
    const hip = k.joints.hip!;
    const up = flat(hip, k.joints.shoulder!);
    const root = this.bone('root');
    root.quaternion.identity();
    root.position.copy(this.restLocal.get('root')!);
    this.scene.updateMatrixWorld(true);
    const midHip = this.mid('upperleg01.R', 'upperleg01.L');
    const axis = this.mid('upperarm01.R', 'upperarm01.L').sub(midHip);
    axis.z = 0;
    const q = new THREE.Quaternion().setFromUnitVectors(axis.normalize(), up);
    root.quaternion.copy(q);
    const offset = midHip.clone().sub(root.position).applyQuaternion(q);
    root.position.set(hip[0], hip[1], 0).sub(offset);
    root.updateMatrixWorld(true);
    // La tête : `nod` réparti sur les trois vertèbres du cou et la tête.
    const nod = -(p.nod ?? 0) * RAD;
    for (const n of ['neck01', 'neck02', 'neck03', 'head']) this.bone(n).quaternion.setFromAxisAngle(Z, nod / 4);
    root.updateMatrixWorld(true);
  }

  /** Une jambe : la cuisse, le tibia, puis le pied à plat sur sa plante inclinée de `sole`. */
  leg(side: Side, l: LegPts) {
    const ul = this.bone(`upperleg01.${side}`);
    const t = flat(l.hip, l.knee);
    this.swing(ul, this.dirOf(`upperleg01.${side}`, `lowerleg01.${side}`), t);
    // Le genou regarde devant : l'avant de la cuisse au repos (+x) va sur le quart de tour de son axe.
    const front = X.clone().applyQuaternion(this.world(ul));
    this.twist(ul, t, signedAngle(front, quarter(t), t));
    const s = flat(l.knee, l.ankle);
    const ll = this.bone(`lowerleg01.${side}`);
    this.swing(ll, this.dirOf(`lowerleg01.${side}`, `foot.${side}`), s);
    const shin = X.clone().applyQuaternion(this.world(ll));
    this.twist(ll, s, signedAngle(shin, quarter(s), s));
    this.setWorld(this.bone(`foot.${side}`), new THREE.Quaternion().setFromAxisAngle(Z, l.sole * RAD));
  }

  /** La normale de la paume, lue sur la main posée. */
  palm(side: Side): THREE.Vector3 {
    const across = this.head(`finger2-1.${side}`).sub(this.head(`finger5-1.${side}`));
    const along = this.head(`finger3-1.${side}`).sub(this.head(`wrist.${side}`));
    return (side === 'R' ? across.cross(along) : along.cross(across)).normalize();
  }

  /** Le long de la main, du poignet vers les doigts. */
  along(side: Side): THREE.Vector3 {
    return this.dirOf(`wrist.${side}`, `finger3-1.${side}`);
  }

  /** De l'auriculaire vers l'index : l'axe d'une poignée serrée. */
  across(side: Side): THREE.Vector3 {
    return this.head(`finger2-1.${side}`).sub(this.head(`finger5-1.${side}`)).normalize();
  }

  /**
   * Un bras par ses deux directions, dans le monde : le bras, l'avant-bras.
   * Le coude plie dans le plan des deux ; la paume tourne avec l'avant-bras.
   */
  armDirs(side: Side, u: THREE.Vector3, v: THREE.Vector3, style: ArmStyle = {}) {
    const ua = this.bone(`upperarm01.${side}`);
    this.swing(ua, this.dirOf(`upperarm01.${side}`, `lowerarm01.${side}`), u);
    // Le pli du coude : au repos l'avant-bras part devant ; on le fait partir vers `v`.
    const fold = perp(v, u);
    if (fold.lengthSq() > 1e-4) {
      const restFold = perp(this.dirOf(`lowerarm01.${side}`, `wrist.${side}`), u);
      this.twist(ua, u, signedAngle(restFold, fold, u));
    }
    const la = this.bone(`lowerarm01.${side}`);
    this.swing(la, this.dirOf(`lowerarm01.${side}`, `wrist.${side}`), v);
    // La paume : l'avant-bras tourne sur lui-même, dans sa moitié basse (pronation, supination).
    if (style.palm) {
      const angle = signedAngle(this.palm(side), style.palm, v);
      this.twist(this.bone(`lowerarm02.${side}`), v, angle);
    }
    this.fingers(side, style.grip ?? 0.15);
  }

  /** Un bras par ses points 2D, écarté de `abduct` degrés vers son côté. */
  arm(side: Side, a: ArmPts, style: ArmStyle = {}) {
    const lateral = new THREE.Vector3(0, 0, side === 'R' ? 1 : -1);
    const tilt = (d: THREE.Vector3) => {
      const al = (style.abduct ?? 0) * RAD;
      return d.multiplyScalar(Math.cos(al)).add(lateral.clone().multiplyScalar(Math.sin(al))).normalize();
    };
    this.armDirs(side, tilt(flat(a.shoulder, a.elbow)), tilt(flat(a.elbow, a.wrist)), style);
  }

  /** Un bras par sa main, en 3D : le coude se résout, poussé vers `pole`. */
  armTo(side: Side, target: THREE.Vector3, pole: THREE.Vector3, style: ArmStyle = {}) {
    const s = this.head(`upperarm01.${side}`);
    const a = SEG.upperArm;
    const b = SEG.forearm;
    const toT = target.clone().sub(s);
    const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, toT.length()));
    const u = toT.normalize();
    const cos = (a * a + d * d - b * b) / (2 * a * d);
    const n = perp(pole, u).normalize();
    const elbow = s.clone().add(u.clone().multiplyScalar(a * cos)).add(n.multiplyScalar(a * Math.sqrt(1 - cos * cos)));
    const wrist = s.clone().add(u.multiplyScalar(d));
    this.armDirs(side, elbow.clone().sub(s).normalize(), wrist.sub(elbow).normalize(), style);
  }

  /** Les doigts repliés vers la paume ; le pouce referme le poing. */
  fingers(side: Side, grip: number) {
    const palm = this.palm(side);
    const CURL = [62, 80, 50];
    for (let f = 2; f <= 5; f++) {
      for (let j = 1; j <= 3; j++) {
        const b = this.bone(`finger${f}-${j}.${side}`);
        const next = j < 3 ? `finger${f}-${j + 1}.${side}` : null;
        const name = `finger${f}-${j}.${side}`;
        const dir = next ? this.dirOf(name, next) : this.tailOf(name).sub(this.head(name)).normalize();
        const axis = dir.clone().cross(palm).normalize();
        this.twist(b, axis, CURL[j - 1]! * RAD * grip);
      }
    }
    for (let j = 2; j <= 3; j++) {
      const b = this.bone(`finger1-${j}.${side}`);
      const along = this.along(side);
      this.twist(b, along.clone().cross(palm).normalize(), 35 * RAD * grip);
    }
  }

  /** La main posée à plat au sol : le poignet la remet à l'horizontale, le pouce rabattu dans le plan de la paume. */
  handFlat(side: Side) {
    const along = this.along(side);
    const level = new THREE.Vector3(along.x, 0.04, along.z).normalize();
    this.swing(this.bone(`wrist.${side}`), along, level);
    this.thumbFlat(side);
  }

  /** Le pouce rabattu dans le plan de la paume, au lieu de pointer vers le sol. */
  thumbFlat(side: Side) {
    const b = this.bone(`finger1-1.${side}`);
    const along = this.along(side);
    const thumb = this.tailOf(`finger1-3.${side}`).sub(this.head(`finger1-1.${side}`));
    this.twist(b, along, signedAngle(thumb, this.across(side), along) * 0.85);
  }

  /**
   * Toute la pose de profil : le buste, les jambes, le bras libre ; le bras
   * plâtré selon `cast` (en écharpe, posé sur le ventre, ou par ses angles).
   */
  pose(k: Skeleton, p: SidePose, opts: { hold?: boolean; supine?: boolean } = {}) {
    this.reset();
    this.trunk(k, p);
    this.leg('R', k.legs.near!);
    this.leg('L', k.legs.far!);
    const freeSide: Side = p.freeSide === 'far' ? 'L' : 'R';
    const castSide: Side = freeSide === 'R' ? 'L' : 'R';
    const hip = k.joints.hip!;
    const up = flat(hip, k.joints.shoulder!);
    const down = up.clone().negate();
    const fwd = new THREE.Vector3(up.y, -up.x, 0);
    const lateral = (s: Side) => new THREE.Vector3(0, 0, s === 'R' ? 1 : -1);

    // Le bras libre : par ses angles ; écarté s'il pend, paume vers la cuisse avec l'haltère, au sol paume en bas.
    const free = k.arms.free;
    const hanging = flat(free.shoulder, free.elbow).dot(down) > 0.7;
    const onFloor = opts.supine && free.wrist[1] < 6;
    this.arm(freeSide, free, {
      abduct: hanging ? (opts.hold ? 9 : 7) : onFloor ? 9 : 0,
      palm: onFloor ? new THREE.Vector3(0, -1, 0) : lateral(freeSide).negate(),
      grip: opts.hold ? 1 : onFloor ? 0 : 0.25,
    });
    if (onFloor) this.handFlat(freeSide);

    // Le bras plâtré.
    if (p.cast === undefined || p.cast === 'sling' || p.cast === 'across') {
      // L'écharpe, en vrai : le bras le long du buste, l'avant-bras en travers du ventre, le pouce en haut.
      // Le bras pend un peu devant (10°) et s'écarte du flanc (8°) ; l'avant-bras part à 40° de l'avant, vers le milieu, un peu relevé.
      const u = down.clone().applyAxisAngle(Z, 10 * RAD).multiplyScalar(Math.cos(8 * RAD)).add(lateral(castSide).multiplyScalar(Math.sin(8 * RAD))).normalize();
      const v = fwd.clone().multiplyScalar(Math.cos(40 * RAD)).add(lateral(castSide).negate().multiplyScalar(Math.sin(40 * RAD))).add(up.clone().multiplyScalar(0.2)).normalize();
      this.armDirs(castSide, u, v, { palm: perp(fwd.clone().negate(), v).normalize(), grip: 0.6 });
    } else if (p.cast.over && opts.supine) {
      // Couché, l'avant-bras plâtré posé sur le ventre, le coude au sol contre le flanc.
      const s = this.head(`upperarm01.${castSide}`);
      const target = new THREE.Vector3(p.cast && 'hand' in p.cast ? p.cast.hand[0] : s.x + 20, 0, 1.5 * lateral(castSide).z * -1);
      target.y = this.surfaceAbove(target.x, target.z) + 2.4;
      this.armTo(castSide, target, new THREE.Vector3(0, -1.2, lateral(castSide).z), { palm: new THREE.Vector3(0, -1, 0), grip: 0.35 });
    } else {
      this.arm(castSide, k.arms.cast, { palm: lateral(castSide).negate(), grip: 0.3 });
    }
    this.scene.updateMatrixWorld(true);
  }

  // ── Le maillage ───────────────────────────────────────────────────────────

  /** Le corps au repos : positions, normales, poids par os, têtes d'os. */
  restData() {
    const g = this.body.geometry;
    const J = g.attributes.skinIndex!;
    const W = g.attributes.skinWeight!;
    const names = this.body.skeleton.bones.map(nameOf);
    const cache = new Map<(b: string) => boolean, boolean[]>();
    return {
      pos: this.restPos,
      normal: this.restNormal,
      weightOf: (v: number, test: (bone: string) => boolean) => {
        let hit = cache.get(test);
        if (!hit) cache.set(test, (hit = names.map(test)));
        let w = 0;
        for (let c = 0; c < 4; c++) if (hit[J.getComponent(v, c)]) w += W.getComponent(v, c);
        return w;
      },
      head: (bone: string) => this.restHead.get(bone)!.toArray() as [number, number, number],
    };
  }

  // ── Le maillage posé ──────────────────────────────────────────────────────

  /** La position posée d'un sommet du corps, dans le monde. */
  vertex(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.body.getVertexPosition(i, out);
    return out.applyMatrix4(this.body.matrixWorld);
  }

  /** Le haut du corps au droit de (x, z), lu sur les sommets posés : là où une main se pose. */
  surfaceAbove(x: number, z: number, r = 1.6): number {
    this.scene.updateMatrixWorld(true);
    // Le buste ne bouge pas d'une image à l'autre : la mesure se garde, par position du bassin.
    const root = this.bone('root');
    const key = [x, z, ...root.position.toArray(), ...root.quaternion.toArray()].map((u) => u.toFixed(2)).join(',');
    const known = this.surfaces.get(key);
    if (known !== undefined) return known;
    const n = this.body.geometry.attributes.position!.count;
    const v = new THREE.Vector3();
    let top = 0;
    for (let i = 0; i < n; i++) {
      this.vertex(i, v);
      if (Math.abs(v.x - x) < r && Math.abs(v.z - z) < r && !this.isArm(i)) top = Math.max(top, v.y);
    }
    this.surfaces.set(key, top);
    return top;
  }

  private readonly surfaces = new Map<string, number>();

  private armVerts: Uint8Array | null = null;
  /** Les sommets des bras, qu'une main posée ne doit pas prendre pour le ventre. */
  isArm(i: number): boolean {
    if (!this.armVerts) {
      const g = this.body.geometry;
      const n = g.attributes.position!.count;
      const names = this.body.skeleton.bones.map(nameOf);
      const arm = new Set(names.map((nm, j) => (/^(upperarm|lowerarm|wrist|metacarpal|finger)/.test(nm) ? j : -1)).filter((j) => j >= 0));
      this.armVerts = new Uint8Array(n);
      const J = g.attributes.skinIndex!;
      const W = g.attributes.skinWeight!;
      for (let v = 0; v < n; v++) {
        let w = 0;
        for (let c = 0; c < 4; c++) if (arm.has(J.getComponent(v, c))) w += W.getComponent(v, c);
        this.armVerts[v] = w > 0.3 ? 1 : 0;
      }
    }
    return this.armVerts[i] === 1;
  }
}

export async function loadRig(url: string): Promise<Rig> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  return new Rig(gltf);
}

export async function parseRig(data: ArrayBuffer): Promise<Rig> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.parseAsync(data, '');
  return new Rig(gltf);
}
