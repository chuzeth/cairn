/**
 * Le mannequin, posé par les squelettes des schémas.
 *
 * Les poses ne changent pas : `lib/figure` résout toujours un squelette 2D —
 * hanche, genou, cheville, épaule, coude, poignet, inclinaison du buste,
 * plante du pied. Ici, chaque segment du mannequin tourne pour prendre la
 * direction de son segment 2D. Les longueurs sont remises à celles de Winter
 * avant tout : une cuisse de 24,5, un tibia de 24,6, un bras de 18,6, un
 * avant-bras de 14,6, un buste de 28,8 ; de face, les hanches et les épaules
 * du dessin sont celles du mannequin (`FRONT`). Les articulations 3D tombent
 * donc sur celles du dessin, dans la vue du dessin —
 * `tests/exercise-figures-3d.test.ts` le vérifie, avec les appuis.
 *
 * La caméra ne tourne jamais : c'est le corps qui se tourne vers elle. De
 * profil, il regarde vers les x croissants ; de face, vers nous ; de dos, vers
 * le fond ; vu de dessus, la tête vers nous, le regard vers le haut de l'image.
 *
 * Ce que la vue ne dit pas, la 3D le décide, et le dit ici : un bras qui pend
 * s'écarte de 7 à 9° pour ne pas traverser la cuisse ; un bras « en
 * raccourci » vient vers nous (de profil), devant le corps (de face, de dos)
 * ou sous les épaules (de dessus) de ce qu'il faut pour garder ses longueurs,
 * sauf si la fiche dit où est la main ; une jambe de face plie le genou vers
 * l'avant quand sa cheville est plus près que la jambe tendue ; l'écharpe
 * porte l'avant-bras en travers du ventre ; un bras plâtré « posé » se pose
 * sur le ventre, le coude au sol contre le flanc.
 *
 * Repère : celui des schémas, x vers la droite de l'image, y vers le haut, le
 * sol à 0 ; z vers nous. De profil, la jambe et le bras « de notre côté » sont
 * les droits (`.R`).
 */
import * as THREE from 'three';
import {
  SEG, dir, rot, type ArmPts, type ArmSpec, type FrontArm, type FrontPose, type LegPts, type Pose, type Prop, type Pt,
  type Skeleton, type SidePose, type TopPose,
} from '../figure';

export type Side = 'R' | 'L';
const RAD = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Le côté du corps que désigne un côté du dessin. De profil, celui de notre
 * côté est le droit ; de face, la gauche de l'image est la droite du corps ; de
 * dos et vu de dessus, sa gauche.
 */
export function sideOf(p: Pose, side: 'left' | 'right' | 'near' | 'far'): Side {
  if (side === 'near') return 'R';
  if (side === 'far') return 'L';
  const mirrored = p.view === 'front' && p.back !== true;
  return (side === 'left') === mirrored ? 'R' : 'L';
}

/** Le côté du bras libre et celui du plâtre. */
export function armSides(p: Pose): { free: Side; cast: Side } {
  const free = p.view === 'side' ? (p.freeSide === 'far' ? 'L' : 'R') : sideOf(p, p.free.side);
  return { free, cast: free === 'R' ? 'L' : 'R' };
}

/** Le repère du corps, dans le monde : devant, en haut (le long du buste), et sa droite. */
export interface BodyFrame {
  fwd: THREE.Vector3;
  up: THREE.Vector3;
  right: THREE.Vector3;
}

/** La rotation qui porte le repère (devant `f0`, haut `u0`) sur (devant `f1`, haut `u1`). */
function frameRotation(f0: THREE.Vector3, u0: THREE.Vector3, f1: THREE.Vector3, u1: THREE.Vector3): THREE.Quaternion {
  const basis = (f: THREE.Vector3, u: THREE.Vector3) => {
    const uu = u.clone().normalize();
    const ff = perp(f, uu).normalize();
    return new THREE.Matrix4().makeBasis(ff, uu, ff.clone().cross(uu));
  };
  return new THREE.Quaternion().setFromRotationMatrix(basis(f1, u1).multiply(basis(f0, u0).transpose()));
}

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

/** La face du mur le plus proche devant le corps (vers les x croissants), s'il y en a un. */
function frontWall(props: readonly Prop[], hipX: number): number | null {
  const faces = props.filter((q): q is Extract<Prop, { kind: 'wall' }> => q.kind === 'wall' && q.face === -1 && q.x > hipX).map((q) => q.x);
  return faces.length ? Math.min(...faces) : null;
}

/** Comment se tient un bras : sa main (paume vers où), ce qu'elle serre. */
export interface ArmStyle {
  /** La normale de la paume voulue, dans le monde. */
  palm?: THREE.Vector3;
  /** Les doigts repliés : 0 tendus, 1 le poing serré sur une poignée. */
  grip?: number;
  /** La direction des doigts, quand la main ne prolonge pas l'avant-bras (à plat contre un mur). */
  fingers?: THREE.Vector3;
}

/** Le corps au repos : positions, normales, poids par os, têtes d'os. */
export interface RestData {
  pos: Float32Array;
  normal: Float32Array;
  weightOf: (v: number, test: (bone: string) => boolean) => number;
  head: (bone: string) => [number, number, number];
}

export interface PoseOptions {
  hold?: 'dumbbell' | 'handle';
  /** Le décor de la vignette : un mur devant borne l'avant-bras en écharpe. */
  props?: readonly Prop[];
}

export class Rig {
  readonly scene: THREE.Object3D;
  readonly body: THREE.SkinnedMesh;
  readonly meshes: THREE.SkinnedMesh[] = [];
  readonly bones = new Map<string, THREE.Bone>();
  /** Les positions des têtes d'os au repos, avant les longueurs de Winter. */
  private readonly restHead = new Map<string, THREE.Vector3>();
  private readonly restLocal = new Map<string, THREE.Vector3>();
  private readonly restPos: Float32Array;
  private readonly restNormal: Float32Array;
  /** Les longueurs du mannequin au repos, pour le rapport. */
  readonly restLengths: Record<string, number> = {};
  /** L'axe du buste au repos, des hanches aux épaules, dans le plan du profil. */
  private readonly restUp: THREE.Vector3;

  constructor(scene: THREE.Object3D) {
    this.scene = scene;
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
    const axis = this.mid('upperarm01.R', 'upperarm01.L').sub(this.mid('upperleg01.R', 'upperleg01.L'));
    this.restUp = new THREE.Vector3(axis.x, axis.y, 0).normalize();
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
    return this.mid('upperarm01.R', 'upperarm01.L').distanceTo(this.mid('upperleg01.R', 'upperleg01.L'));
  }

  /** Une chaîne d'os allongée ou raccourcie pour que `from` → `to` mesure `target`. */
  private stretch(chain: string[], from: string, to: string, target: number) {
    const f = target / this.restHead.get(from)!.distanceTo(this.restHead.get(to)!);
    for (const n of chain) this.bone(n).position.copy(this.restLocal.get(n)!).multiplyScalar(f);
  }

  /**
   * Les longueurs de Winter, celles des schémas. Le mannequin de MakeHuman a le
   * bras court (13,6 pour 18,6) : il est allongé, le reste bouge de quelques %.
   * La cheville est remise à 3,9 au-dessus de la semelle en tassant le pied.
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

  /** Remet un bras à son repos, de l'épaule aux doigts : pour en essayer une autre pose. */
  resetArm(side: Side) {
    for (const [name, b] of this.bones) {
      if (name.endsWith(`.${side}`) && /^(upperarm|lowerarm|wrist|metacarpal|finger)/.test(name)) b.quaternion.identity();
    }
    this.scene.updateMatrixWorld(true);
  }

  /** Remet chaque os à son repos (longueurs de Winter gardées). */
  reset() {
    for (const b of this.bones.values()) b.quaternion.identity();
    this.scene.updateMatrixWorld(true);
  }

  /**
   * Le buste : le milieu des hanches en `hip`, l'axe hanches → épaules selon
   * `up`, la poitrine vers `fwd` ; la tête suit `nod`.
   */
  private orient(hip: THREE.Vector3, up: THREE.Vector3, fwd: THREE.Vector3, nod = 0) {
    const root = this.bone('root');
    root.quaternion.identity();
    root.position.copy(this.restLocal.get('root')!);
    this.scene.updateMatrixWorld(true);
    const midHip = this.mid('upperleg01.R', 'upperleg01.L');
    const q = frameRotation(X, this.restUp, fwd, up);
    root.quaternion.copy(q);
    const offset = midHip.clone().sub(root.position).applyQuaternion(q);
    root.position.copy(hip).sub(offset);
    // La tête : `nod` réparti sur les trois vertèbres du cou et la tête, autour de l'axe des épaules.
    for (const n of ['neck01', 'neck02', 'neck03', 'head']) this.bone(n).quaternion.setFromAxisAngle(Z, (-nod * RAD) / 4);
    root.updateMatrixWorld(true);
  }

  /** Le repère du buste, tel qu'il est posé. */
  frame(): BodyFrame {
    const q = this.world(this.bone('root'));
    const fwd = perp(X, this.restUp).normalize().applyQuaternion(q);
    const up = this.restUp.clone().applyQuaternion(q);
    return { fwd, up, right: fwd.clone().cross(up) };
  }

  /**
   * Le buste de profil : le milieu des hanches sur la hanche du dessin, l'axe
   * hanches → épaules sur celui du dessin.
   */
  trunk(k: Skeleton, p: SidePose) {
    const hip = k.joints.hip!;
    const up = flat(hip, k.joints.shoulder!);
    this.orient(new THREE.Vector3(hip[0], hip[1], 0), up, new THREE.Vector3(up.y, -up.x, 0), p.nod ?? 0);
  }

  /**
   * Une jambe par ses deux directions, dans le monde : la cuisse et le tibia
   * tournent sur eux-mêmes pour que leur avant regarde `frontT` et `frontS` ;
   * le pied prend l'orientation `foot`.
   */
  private legDirs(side: Side, t: THREE.Vector3, s: THREE.Vector3, frontT: THREE.Vector3, frontS: THREE.Vector3, foot: THREE.Quaternion) {
    const ul = this.bone(`upperleg01.${side}`);
    this.swing(ul, this.dirOf(`upperleg01.${side}`, `lowerleg01.${side}`), t);
    // L'avant de la cuisse au repos (+x) va sur celui qu'on veut : le genou regarde devant.
    this.twist(ul, t, signedAngle(X.clone().applyQuaternion(this.world(ul)), frontT, t));
    const ll = this.bone(`lowerleg01.${side}`);
    this.swing(ll, this.dirOf(`lowerleg01.${side}`, `foot.${side}`), s);
    this.twist(ll, s, signedAngle(X.clone().applyQuaternion(this.world(ll)), frontS, s));
    this.setWorld(this.bone(`foot.${side}`), foot);
  }

  /** Une jambe de profil : la cuisse, le tibia, puis le pied à plat sur sa plante inclinée de `sole`. */
  leg(side: Side, l: LegPts) {
    const t = flat(l.hip, l.knee);
    const s = flat(l.knee, l.ankle);
    this.legDirs(side, t, s, quarter(t), quarter(s), new THREE.Quaternion().setFromAxisAngle(Z, l.sole * RAD));
  }

  /** Une jambe vers sa cheville, en 3D : le genou se résout, poussé vers `pole` ; le pied prend l'orientation `foot`. */
  legTo(side: Side, ankle: THREE.Vector3, pole: THREE.Vector3, foot: THREE.Quaternion) {
    const hip = this.head(`upperleg01.${side}`);
    const a = SEG.thigh;
    const b = SEG.shank;
    const toA = ankle.clone().sub(hip);
    const d = Math.min(a + b - 1e-3, Math.max(Math.abs(a - b) + 1e-3, toA.length()));
    const u = toA.normalize();
    const cos = (a * a + d * d - b * b) / (2 * a * d);
    const knee = hip.clone().addScaledVector(u, a * cos).addScaledVector(perp(pole, u).normalize(), a * Math.sqrt(Math.max(0, 1 - cos * cos)));
    const end = hip.clone().addScaledVector(u, d);
    this.legDirs(side, knee.clone().sub(hip).normalize(), end.sub(knee).normalize(), pole, pole, foot);
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

  /** Le milieu du poing : là où passe une poignée. */
  grip(side: Side): THREE.Vector3 {
    const kn = ['finger2-1', 'finger3-1', 'finger4-1', 'finger5-1'].map((n) => this.head(`${n}.${side}`)).reduce((p, q) => p.add(q)).multiplyScalar(0.25);
    return kn.addScaledVector(this.palm(side), 1.25).addScaledVector(this.along(side), 1.1);
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
    if (style.palm) this.twist(this.bone(`lowerarm02.${side}`), v, signedAngle(this.palm(side), style.palm, v));
    if (style.fingers) {
      this.swing(this.bone(`wrist.${side}`), this.along(side), style.fingers);
      if (style.palm) this.twist(this.bone(`wrist.${side}`), style.fingers, signedAngle(this.palm(side), style.palm, style.fingers));
    }
    this.fingers(side, style.grip ?? 0.15);
  }

  /** Un bras par ses points 2D, écarté de `abduct` degrés vers son côté. */
  arm(side: Side, a: ArmPts, abduct: number, style: ArmStyle = {}) {
    const lateral = new THREE.Vector3(0, 0, side === 'R' ? 1 : -1);
    const tilt = (d: THREE.Vector3) => {
      const al = abduct * RAD;
      return d.multiplyScalar(Math.cos(al)).add(lateral.clone().multiplyScalar(Math.sin(al))).normalize();
    };
    this.armDirs(side, tilt(flat(a.shoulder, a.elbow)), tilt(flat(a.elbow, a.wrist)), style);
  }

  /**
   * Un bras « en raccourci » : le dessin donne le coude et la main tels que la
   * vue les montre, plus courts que le bras. Ils viennent vers nous de ce qu'il
   * faut pour que chaque segment garde sa longueur ; vus de profil, ils restent
   * exactement où le dessin les met.
   */
  armProjected(side: Side, a: ArmPts, style: ArmStyle = {}) {
    const s = this.head(`upperarm01.${side}`);
    const depth = (d: number, l: number) => Math.sqrt(Math.max(0, l * l - d * d));
    const elbow = new THREE.Vector3(a.elbow[0], a.elbow[1], s.z + depth(Math.hypot(a.elbow[0] - s.x, a.elbow[1] - s.y), SEG.upperArm));
    const wrist = new THREE.Vector3(a.wrist[0], a.wrist[1], elbow.z + depth(Math.hypot(a.wrist[0] - a.elbow[0], a.wrist[1] - a.elbow[1]), SEG.forearm));
    this.armDirs(side, elbow.clone().sub(s).normalize(), wrist.sub(elbow).normalize(), style);
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

  /**
   * Un bras de face, de dos ou de dessus, par ses points tels que la vue les
   * montre ; ce que la vue ne voit pas va dans l'axe de la caméra, du côté
   * `sign` (+1 vers nous). Sans `depth`, chaque segment s'y déplie de ce qu'il
   * faut pour garder sa longueur. Avec, la main va à `depth` de l'épaule, et le
   * coude se résout du côté de celui du dessin.
   */
  armView(side: Side, a: ArmPts, sign: 1 | -1, depth: number | undefined, style: ArmStyle = {}) {
    const s = this.head(`upperarm01.${side}`);
    const out = (from: THREE.Vector3, p: Pt, l: number) =>
      new THREE.Vector3(p[0], p[1], from.z + sign * Math.sqrt(Math.max(0, l * l - (p[0] - from.x) ** 2 - (p[1] - from.y) ** 2)));
    const elbow = out(s, a.elbow, SEG.upperArm);
    if (depth == null) {
      const wrist = out(elbow, a.wrist, SEG.forearm);
      this.armDirs(side, elbow.clone().sub(s).normalize(), wrist.sub(elbow).normalize(), style);
    } else {
      this.armTo(side, new THREE.Vector3(a.wrist[0], a.wrist[1], s.z + sign * depth), elbow.sub(s), style);
    }
  }

  /** Les doigts repliés vers la paume ; le pouce referme le poing. */
  fingers(side: Side, grip: number) {
    const palm = this.palm(side);
    const CURL = [62, 80, 50];
    for (let f = 2; f <= 5; f++) {
      for (let j = 1; j <= 3; j++) {
        const name = `finger${f}-${j}.${side}`;
        const b = this.bone(name);
        const dirn = j < 3 ? this.dirOf(name, `finger${f}-${j + 1}.${side}`) : this.tailOf(name).sub(this.head(name)).normalize();
        this.twist(b, dirn.clone().cross(palm).normalize(), CURL[j - 1]! * RAD * grip);
      }
    }
    for (let j = 2; j <= 3; j++) {
      const along = this.along(side);
      this.twist(this.bone(`finger1-${j}.${side}`), along.clone().cross(palm).normalize(), 35 * RAD * grip);
    }
  }

  /** La main posée à plat au sol : le poignet la remet à l'horizontale, le pouce rabattu. */
  handFlat(side: Side) {
    const along = this.along(side);
    this.swing(this.bone(`wrist.${side}`), along, new THREE.Vector3(along.x, 0.04, along.z).normalize());
    this.thumbFlat(side);
  }

  /** Le pouce rabattu dans le plan de la paume : sur une main à plat, il ne pointe plus dans le mur ou la caisse. */
  thumbFlat(side: Side) {
    const thumb = this.tailOf(`finger1-3.${side}`).sub(this.head(`finger1-1.${side}`));
    const axis = this.along(side);
    this.twist(this.bone(`finger1-1.${side}`), axis, signedAngle(thumb, this.across(side), axis) * 0.85);
  }

  /** Toute la pose, dans la vue du dessin. */
  pose(k: Skeleton, p: Pose, opts: PoseOptions = {}) {
    this.reset();
    if (p.view === 'front') this.poseFront(k, p, opts);
    else if (p.view === 'top') this.poseTop(k, p, opts);
    else this.poseSide(k, p, opts);
    this.scene.updateMatrixWorld(true);
  }

  /** Le côté `s` du corps : sa droite, ou sa gauche. */
  private lateral(f: BodyFrame, s: Side) {
    return f.right.clone().multiplyScalar(s === 'R' ? 1 : -1);
  }

  /**
   * L'écharpe, en vrai : le bras pend un peu devant (10°) et s'écarte du flanc
   * (8°) ; l'avant-bras part à 40° de l'avant, vers le milieu, un peu relevé,
   * le pouce en haut. Face à un mur proche (`wall`, sa face en x), l'avant-bras
   * rentre vers le ventre, jusqu'à 85° : le plâtre ne le traverse pas. De face
   * et de dessus, où l'on voit à quelle distance du ventre il passe, il part à
   * 65° (`inward`) : en travers du ventre, contre lui.
   */
  private sling(side: Side, f: BodyFrame, wall: number | null = null, inward0 = 40) {
    const out = this.lateral(f, side);
    const hang = f.up.clone().negate().multiplyScalar(Math.cos(10 * RAD)).addScaledVector(f.fwd, Math.sin(10 * RAD));
    const u = hang.multiplyScalar(Math.cos(8 * RAD)).addScaledVector(out, Math.sin(8 * RAD)).normalize();
    for (const inward of [inward0, 50, 60, 70, 78, 85].filter((a) => a >= inward0)) {
      const v = f.fwd.clone().multiplyScalar(Math.cos(inward * RAD)).addScaledVector(out, -Math.sin(inward * RAD)).addScaledVector(f.up, 0.2).normalize();
      this.armDirs(side, u, v, { palm: perp(f.fwd.clone().negate(), v).normalize(), grip: 0.6 });
      if (wall === null) break;
      const knuckles = this.head(`finger3-1.${side}`);
      const reach = Math.max(knuckles.x + 2.8, knuckles.clone().addScaledVector(this.along(side), 3.5).x);
      if (reach <= wall - 0.5) break;
      this.resetArm(side);
    }
  }

  /**
   * De face ou de dos : le corps tourné vers nous (ou vers le fond), puis de
   * `turn` autour du bassin ; les jambes vers leurs chevilles, les pieds à plat
   * dans le repère du corps ; les bras par leurs points, l'écharpe sinon.
   */
  private poseFront(k: Skeleton, p: FrontPose, opts: PoseOptions) {
    const sign: 1 | -1 = p.back ? -1 : 1;
    const fwd = new THREE.Vector3(0, 0, sign);
    const [bx, by] = rot([0, 1], p.turn ?? 0);
    const [ux, uy] = rot(dir(180 + (p.tilt ?? 0)), p.turn ?? 0);
    this.orient(new THREE.Vector3(p.pelvis[0], p.pelvis[1], 0), new THREE.Vector3(ux, uy, 0), fwd);
    const foot = frameRotation(X, Y, fwd, new THREE.Vector3(bx, by, 0));
    for (const side of ['left', 'right'] as const) {
      const s = sideOf(p, side);
      const leg = p[side];
      const hip = this.head(`upperleg01.${s}`);
      this.legTo(s, new THREE.Vector3(leg.ankle[0], leg.ankle[1], hip.z + sign * (leg.depth ?? 0)), fwd, foot);
    }
    this.arms(k, p, sign, opts);
  }

  /** Vu de dessus : debout, la tête vers nous, le regard vers le haut de l'image ; les épaules en `at`. */
  private poseTop(k: Skeleton, p: TopPose, opts: PoseOptions) {
    const fwd = new THREE.Vector3(0, 1, 0);
    const up = new THREE.Vector3(0, 0, 1);
    this.orient(new THREE.Vector3(p.at[0], p.at[1], -SEG.trunk), up, fwd);
    const foot = frameRotation(X, Y, fwd, up);
    for (const s of ['R', 'L'] as const) {
      const hip = this.head(`upperleg01.${s}`);
      this.legTo(s, hip.clone().addScaledVector(up, -(SEG.thigh + SEG.shank)), fwd, foot);
    }
    this.arms(k, p, -1, opts);
  }

  /** Les bras de face, de dos ou de dessus : le libre par ses points, le plâtré par les siens ou en écharpe. */
  private arms(k: Skeleton, p: FrontPose | TopPose, sign: 1 | -1, opts: PoseOptions) {
    const f = this.frame();
    const { free, cast } = armSides(p);
    // La paume vers le corps, le pouce devant : un bras au repos, une poignée tenue droite. Au sol (un
    // gainage sur l'avant-bras), la main à plat, paume en bas.
    const onFloor = p.view === 'front' && k.arms.free.wrist[1] < 6;
    const style = onFloor ? { palm: new THREE.Vector3(0, -1, 0), grip: 0 } : { palm: this.lateral(f, free).negate(), grip: opts.hold ? 1 : 0.25 };
    this.armView(free, k.arms.free, sign, p.free.depth, style);
    if (onFloor) this.handFlat(free);
    const spec: FrontArm | undefined = p.view === 'front' ? p.cast : undefined;
    if (spec) this.armView(cast, k.arms.cast, sign, spec.depth, { palm: this.lateral(f, cast).negate(), grip: 0.3 });
    else this.sling(cast, f, null, 65);
  }

  /**
   * De profil : le buste, les jambes, le bras libre ; le bras plâtré selon
   * `cast` (en écharpe, en travers, posé sur le ventre, ou par ses angles).
   */
  private poseSide(k: Skeleton, p: SidePose, opts: PoseOptions) {
    this.trunk(k, p);
    this.leg('R', k.legs.near!);
    this.leg('L', k.legs.far!);
    const { free: freeSide, cast: castSide } = armSides(p);
    const up = flat(k.joints.hip!, k.joints.shoulder!);
    const down = up.clone().negate();
    const lateral = (s: Side) => new THREE.Vector3(0, 0, s === 'R' ? 1 : -1);
    const supine = p.lean < -60;

    // Le bras libre.
    const free = k.arms.free;
    const fingers = (spec: ArmSpec) => ('fingers' in spec && spec.fingers != null ? new THREE.Vector3(...dir(spec.fingers), 0) : undefined);
    const grip = opts.hold ? 1 : 0.25;
    // Une main dont le dessin dit les doigts est posée à plat : paume vers l'appui (un mur devant, une caisse dessous).
    const f = fingers(p.free);
    const flatHand = f ? { palm: new THREE.Vector3(f.y, -f.x, 0), grip: 0, fingers: f } : null;
    if (free.projected) {
      this.armProjected(freeSide, free, flatHand ?? { palm: lateral(freeSide).negate(), grip });
      if (flatHand) this.thumbFlat(freeSide);
    } else {
      // Écarté s'il pend, pour ne pas traverser la cuisse ; au sol, à plat, paume en bas.
      const hanging = flat(free.shoulder, free.elbow).dot(down) > 0.7;
      const onFloor = supine && free.wrist[1] < 6;
      this.arm(freeSide, free, hanging ? (opts.hold ? 9 : 7) : onFloor ? 9 : 0,
        onFloor ? { palm: new THREE.Vector3(0, -1, 0), grip: 0 } : flatHand ?? { palm: lateral(freeSide).negate(), grip });
      if (onFloor) this.handFlat(freeSide);
      else if (flatHand) this.thumbFlat(freeSide);
    }

    // Le bras plâtré.
    const cast = p.cast;
    if (cast === undefined || cast === 'sling' || cast === 'across') {
      this.sling(castSide, this.frame(), frontWall(opts.props ?? [], k.joints.hip![0]));
    } else if (cast.over) {
      // Posé sur le ventre : la main sur la peau au droit de la main du dessin, le coude contre le flanc.
      const s = this.head(`upperarm01.${castSide}`);
      const x = 'hand' in cast ? cast.hand[0] : s.x + 20;
      const z = -1.5 * lateral(castSide).z;
      const target = new THREE.Vector3(x, this.surfaceAbove(x, z) + 2.4, z);
      this.armTo(castSide, target, new THREE.Vector3(0, supine ? -1.2 : -0.6, lateral(castSide).z), { palm: new THREE.Vector3(0, -1, 0), grip: 0.35 });
    } else if (k.arms.cast.projected) {
      this.armProjected(castSide, k.arms.cast, { palm: lateral(castSide).negate(), grip: 0.3 });
    } else {
      this.arm(castSide, k.arms.cast, 6, { palm: lateral(castSide).negate(), grip: 0.3 });
    }
  }

  // ── Le maillage ───────────────────────────────────────────────────────────

  /** Le corps au repos : positions, normales, poids par os, têtes d'os. */
  restData(): RestData {
    const g = this.body.geometry;
    const J = g.attributes.skinIndex!;
    const W = g.attributes.skinWeight!;
    const names = this.body.skeleton.bones.map(nameOf);
    const cache = new Map<(b: string) => boolean, boolean[]>();
    return {
      pos: this.restPos,
      normal: this.restNormal,
      weightOf: (v, test) => {
        let hit = cache.get(test);
        if (!hit) cache.set(test, (hit = names.map(test)));
        let w = 0;
        for (let c = 0; c < 4; c++) if (hit[J.getComponent(v, c)]) w += W.getComponent(v, c);
        return w;
      },
      head: (bone) => this.restHead.get(bone)!.toArray() as [number, number, number],
    };
  }

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
    if (this.surfaces.size > 200) this.surfaces.clear();
    this.surfaces.set(key, top);
    return top;
  }

  private readonly surfaces = new Map<string, number>();
  private armVerts: Uint8Array | null = null;

  /** Les sommets des bras, qu'une main posée ne doit pas prendre pour le ventre. */
  isArm(i: number): boolean {
    if (!this.armVerts) {
      const d = this.restData();
      const n = this.body.geometry.attributes.position!.count;
      const onArm = (nm: string) => /^(upperarm|lowerarm|wrist|metacarpal|finger)/.test(nm);
      this.armVerts = new Uint8Array(n);
      for (let v = 0; v < n; v++) this.armVerts[v] = d.weightOf(v, onArm) > 0.3 ? 1 : 0;
    }
    return this.armVerts[i] === 1;
  }
}
