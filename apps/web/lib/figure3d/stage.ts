/**
 * La scène des schémas 3D : un seul moteur WebGL pour toutes les vignettes.
 *
 * `/exercices` montre trente-six schémas 3D sur une page ; un navigateur ne
 * tient pas trente-six contextes WebGL. Un seul rend donc chaque vignette à
 * son tour, dans un coin de sa toile, et l'image est recopiée dans la toile de
 * la vignette — sur fond transparent : le fond de la carte reste celui de
 * l'app, quel que soit l'écran.
 *
 * Chaque vignette a son mannequin (un clone : la géométrie est partagée, le
 * squelette est à elle), ses muscles peints, son décor, son plâtre. Seule la
 * vignette qu'on dessine est visible dans la scène.
 *
 * La lumière : un environnement de studio (réflexions douces), une lumière
 * principale devant et au-dessus, un contre-jour qui détache la silhouette. La
 * caméra regarde toujours le plan du dessin, en projection orthographique ;
 * c'est le corps qui se tourne (`rig.ts`) : un point 3D tombe là où le dessin
 * le met, et le calque vectoriel (consignes, angles, flèches) se pose dessus
 * sans décalage. Le sol qui reçoit l'ombre est légèrement incliné vers nous,
 * pour que l'ombre se voie sans tourner la caméra ; vu de dessus, il n'y en a
 * pas.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { FIGURES } from '../exerciseFigures';
import { add, between, lerp, mul, rot, skeleton, sub, unit, type Panel, type Pose, type Pt, type Skeleton } from '../figure';
import { MODEL_URL } from './model';
import { farMask, muscleMask } from './muscles';
import { buildProps, dumbbell } from './props';
import { Rig, armSides, type RestData, type Side } from './rig';

/** Le cadre d'une vignette, en unités du corps : le viewBox du schéma vectoriel. */
export interface FigureFrame {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Les couleurs, lues sur les variables CSS de la vignette : elles suivent le thème et l'écran. */
interface Tokens {
  dark: boolean;
  near: THREE.Color;
  far: THREE.Color;
  muscle: THREE.Color;
  cast: THREE.Color;
  sling: THREE.Color;
  mat: THREE.Color;
  towel: THREE.Color;
  pad: THREE.Color;
  metal: THREE.Color;
  plate: THREE.Color;
  carry: THREE.Color;
  shoe: THREE.Color;
  sole: THREE.Color;
  /** La position de départ : une silhouette pâle, derrière le corps de l'instant. */
  ghost: THREE.Color;
  /** L'accroche de porte, dans le vert des élastiques. */
  band: THREE.Color;
  /** Un fond, un ton sous le papier de la carte. */
  backdrop: THREE.Color;
}

function readTokens(el: Element): Tokens {
  const s = getComputedStyle(el);
  const c = (name: string, fallback: string) => new THREE.Color(s.getPropertyValue(name).trim() || fallback);
  const dark = document.documentElement.dataset.theme === 'dark';
  const near = c('--fig-near', '#3B3630');
  const faint = c('--text-faint', '#6B6359');
  const bg2 = c('--bg-elev-2', '#EEE7DB');
  return {
    dark,
    near,
    far: c('--fig-far', '#BDB3A4'),
    muscle: c('--fig-muscle', '#B8452A'),
    cast: c('--cast', '#E6D7B5'),
    sling: c('--fig-sling', '#B9AE98'),
    mat: c('--fig-mat', '#E6DFD3'),
    towel: c('--fig-towel', '#CFD5D3'),
    pad: bg2.clone().lerp(c('--border-strong', '#CFC5B5'), dark ? 0.7 : 0.85),
    metal: faint,
    plate: c('--text-dim', '#4A433B'),
    carry: c('--fig-carry', '#8C7B63'),
    // La chaussure, à l'inverse du corps : tige claire et semelle sombre sur le corps à l'encre, l'inverse la nuit.
    shoe: bg2.clone().lerp(c('--bg-elev', '#FBF8F3'), 0.5),
    sole: c('--text-dim', '#4A433B'),
    ghost: c('--fig-ghost', '#DCD5C9'),
    band: c('--good', '#5E7A52'),
    backdrop: c('--bg-elev', '#FBF8F3').lerp(c('--text', '#1C1915'), dark ? 0.08 : 0.05),
  };
}

/**
 * Le matériau du corps : mat, les muscles en terracotta, la chaussure, le côté
 * opposé teinté. Les masques par sommet sont fondus sur 1 à 2 cm
 * (`muscles.ts`) ; le shader les tranche net, sur un liseré d'un millimètre :
 * un muscle se lit comme une zone, pas comme une tache.
 */
function bodyMaterial() {
  const uniforms = {
    uMuscle: { value: new THREE.Color() },
    uFar: { value: new THREE.Color() },
    uFarMix: { value: 0.42 },
    uShoe: { value: new THREE.Color() },
    uSole: { value: new THREE.Color() },
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMuscle;\nattribute float aFar;\nattribute vec2 _shoe;\nvarying float vMuscle;\nvarying float vFar;\nvarying vec2 vShoe;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMuscle = aMuscle;\nvFar = aFar;\nvShoe = _shoe;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uMuscle;\nuniform vec3 uFar;\nuniform float uFarMix;\nuniform vec3 uShoe;\nuniform vec3 uSole;\nvarying float vMuscle;\nvarying float vFar;\nvarying vec2 vShoe;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        [
          'float mus = smoothstep( 0.42, 0.58, vMuscle ) * ( 1.0 - vShoe.x );',
          'float farK = smoothstep( 0.35, 0.65, vFar );',
          'vec3 tone = mix( diffuse, uMuscle, mus );',
          'tone = mix( tone, uShoe, vShoe.x );',
          'tone = mix( tone, uSole, vShoe.y );',
          'tone = mix( tone, uFar, farK * uFarMix * ( 1.0 - 0.7 * vShoe.x ) );',
          'vec4 diffuseColor = vec4( tone, opacity );',
        ].join('\n\t'),
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( mix( roughnessFactor, 0.78, mus ), 0.5, vShoe.x - vShoe.y );')
      // Le muscle garde sa couleur dans l'ombre : un peu de lui-même, comme une encre.
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += uMuscle * 0.16 * mus;');
  };
  return { material, uniforms };
}

const Y = new THREE.Vector3(0, 1, 0);

/** Un cylindre de hauteur 1 posé de `a` à `b`. */
function place(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  const d = b.clone().sub(a);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(Y, d.clone().normalize());
  mesh.scale.set(1, d.length(), 1);
}

const perp3 = (v: THREE.Vector3, axis: THREE.Vector3) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis))).normalize();

/**
 * Un cordon rembourré qui suit une courbe : la sangle de l'écharpe, du poignet
 * au cou et retour. La géométrie est allouée une fois, recalculée à chaque
 * image par repères de Frenet.
 */
class Cord {
  readonly mesh: THREE.Mesh;
  private readonly rings = 72;
  private readonly sides = 10;
  constructor(material: THREE.Material, private readonly radius: number) {
    const g = new THREE.BufferGeometry();
    const n = (this.rings + 1) * this.sides;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < this.rings; i++) {
      for (let j = 0; j < this.sides; j++) {
        const a = i * this.sides + j, b = i * this.sides + ((j + 1) % this.sides), c = a + this.sides, d = b + this.sides;
        idx.push(a, c, b, b, c, d);
      }
    }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }
  update(curve: THREE.Curve<THREE.Vector3>) {
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const nrm = this.mesh.geometry.attributes.normal as THREE.BufferAttribute;
    const frames = curve.computeFrenetFrames(this.rings, false);
    const p = new THREE.Vector3();
    const o = new THREE.Vector3();
    for (let i = 0; i <= this.rings; i++) {
      curve.getPointAt(i / this.rings, p);
      for (let j = 0; j < this.sides; j++) {
        const a = (j / this.sides) * Math.PI * 2;
        o.copy(frames.normals[i]!).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i]!, Math.sin(a));
        const k = i * this.sides + j;
        nrm.setXYZ(k, o.x, o.y, o.z);
        pos.setXYZ(k, p.x + o.x * this.radius, p.y + o.y * this.radius, p.z + o.z * this.radius);
      }
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  }
}

interface Materials {
  body: ReturnType<typeof bodyMaterial>;
  ghost: THREE.MeshBasicMaterial;
  eyes: THREE.MeshStandardMaterial;
  cast: THREE.MeshStandardMaterial;
  sling: THREE.MeshStandardMaterial;
  pad: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  mat: THREE.MeshStandardMaterial;
  towel: THREE.MeshStandardMaterial;
  carry: THREE.MeshStandardMaterial;
  band: THREE.MeshStandardMaterial;
  backdrop: THREE.MeshStandardMaterial;
}

/** Le bras plâtré est-il en écharpe ? De profil, sauf s'il est posé ou dit par ses angles ; de face, sauf s'il est dit. */
const strapped = (p: Pose) =>
  p.view === 'side' ? p.cast === undefined || p.cast === 'sling' || p.cast === 'across' : p.view === 'top' || p.cast === undefined;

/**
 * Ce que porte le corps et qui le suit : le plâtre, l'écharpe, l'haltère ou la
 * poignée, le sac.
 */
class Attachments {
  readonly group = new THREE.Group();
  private readonly castParts: THREE.Mesh[] = [];
  private readonly cuff: THREE.Mesh | null = null;
  private readonly cord: Cord | null = null;
  private readonly held: THREE.Object3D | null = null;
  private readonly bag: THREE.Mesh | null = null;
  /** L'anse du sac porté à la main. */
  private readonly strap: THREE.Mesh | null = null;
  private readonly anchors: Record<string, number>;
  private readonly castR: { upper: number; fore: number; hand: number };

  constructor(private readonly rig: Rig, private readonly panel: Panel, m: Materials) {
    const d = rig.restData();
    this.castR = castRadii(d, armSides(panel.pose).cast);
    this.anchors = strapAnchors(d);
    const cyl = (r0: number, r1: number) => new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 1, 40, 1, true), m.cast);
    const ball = (r: number) => new THREE.Mesh(new THREE.SphereGeometry(r, 40, 20), m.cast);
    const R = this.castR;
    this.castParts = [cyl(R.upper, R.upper + 0.15), ball(R.upper), ball(R.upper + 0.15), cyl(R.fore + 0.1, R.fore), ball(R.fore), cyl(R.fore, R.hand), ball(R.hand)];
    this.group.add(...this.castParts);
    if (strapped(panel.pose) || (panel.ghost && strapped(panel.ghost))) {
      this.cuff = new THREE.Mesh(new THREE.CylinderGeometry(R.fore + 0.45, R.fore + 0.45, 3.4, 40, 1, true), m.sling);
      this.cord = new Cord(m.sling, 0.75);
      this.group.add(this.cuff, this.cord.mesh);
    }
    if (panel.hold === 'dumbbell') this.held = dumbbell({ handle: m.metal, plate: m.plate });
    else if (panel.hold === 'handle') this.held = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 6, 20), m.carry);
    if (this.held) this.group.add(this.held);
    if (panel.carry === 'main') {
      // Un sac de sport tenu par son anse : 11 cm d'épaisseur, 21 de haut, 27 de long.
      this.bag = new THREE.Mesh(new RoundedBoxGeometry(6, 12, 15, 3, 1.6), m.carry);
      this.strap = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.4, 10, 24, Math.PI), m.carry);
      this.group.add(this.bag, this.strap);
    } else if (panel.carry) {
      this.bag = new THREE.Mesh(new THREE.CapsuleGeometry(1, 1, 8, 24), m.carry);
      this.group.add(this.bag);
    }
    this.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  }

  update(k: Skeleton, p: Pose) {
    const rig = this.rig;
    const s = armSides(this.panel.pose).cast;
    const h = (n: string) => rig.head(n);
    const shoulder = h(`upperarm01.${s}`);
    const elbow = h(`lowerarm01.${s}`);
    const wrist = h(`wrist.${s}`);
    const knuckles = ['finger2-1', 'finger3-1', 'finger4-1', 'finger5-1'].map((f) => h(`${f}.${s}`)).reduce((a, b) => a.add(b)).multiplyScalar(0.25);
    const handEnd = knuckles.clone().addScaledVector(rig.along(s), 0.6);
    const upperStart = shoulder.clone().lerp(elbow, 0.45);
    const [cu, bu, be, cf, bw, ch, bh] = this.castParts as [THREE.Mesh, THREE.Mesh, THREE.Mesh, THREE.Mesh, THREE.Mesh, THREE.Mesh, THREE.Mesh];
    place(cu, upperStart, elbow);
    bu.position.copy(upperStart);
    be.position.copy(elbow);
    place(cf, elbow, wrist);
    bw.position.copy(wrist);
    // La main plâtrée est plate : aplatie dans l'axe de la paume.
    const palm = rig.palm(s);
    const along = handEnd.clone().sub(wrist).normalize();
    const across = along.clone().cross(palm).normalize();
    ch.position.copy(wrist).lerp(handEnd, 0.5);
    ch.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, along, perp3(palm, along)));
    ch.scale.set(1, wrist.distanceTo(handEnd), 0.68);
    bh.position.copy(handEnd);
    bh.quaternion.copy(ch.quaternion);
    bh.scale.set(1, 1, 0.68);

    // L'écharpe : un bracelet au poignet plâtré, le cordon passe au cou et revient.
    const strap = strapped(p);
    if (this.cuff && this.cord) {
      this.cuff.visible = strap;
      this.cord.mesh.visible = strap;
      if (strap) {
        const fore = wrist.clone().sub(elbow).normalize();
        const cuffAt = wrist.clone().addScaledVector(fore, -2.6);
        this.cuff.position.copy(cuffAt);
        this.cuff.quaternion.setFromUnitVectors(Y, fore);
        const a = this.anchors;
        // Les écarts du cordon à la peau, dans le repère du buste : devant, en haut, vers la droite.
        const f = rig.frame();
        const at = (i: number, fwd: number, up: number, right: number) =>
          rig.vertex(i).addScaledVector(f.fwd, fwd).addScaledVector(f.up, up).addScaledVector(f.right, right);
        const up = h('neck01').sub(h('spine05')).normalize();
        const top = cuffAt.clone().addScaledVector(perp3(up, fore), this.castR.fore + 0.6);
        const side = new THREE.Vector3().crossVectors(fore, up).normalize();
        this.cord.update(new THREE.CatmullRomCurve3([
          top.clone().addScaledVector(side, 1.1),
          at(a.chestR!, 0.9, 0.25, 0.3),
          at(a.neckR!, 0, 0.9, 0.3),
          at(a.nape!, -0.9, 0.3, 0),
          at(a.neckL!, 0, 0.9, -0.3),
          at(a.chestL!, 0.9, 0.25, -0.3),
          top.clone().addScaledVector(side, -1.1),
        ], false, 'centripetal'));
      }
    }

    const free = armSides(p).free;
    if (this.held) {
      this.held.position.copy(rig.grip(free));
      this.held.quaternion.setFromUnitVectors(Y, rig.across(free));
    }

    if (this.bag && this.strap) {
      // Le sac pend sous le poing, droit : l'anse passe dans la main, le sac en long dans le sens de la marche.
      const grip = rig.grip(free);
      const f = rig.frame();
      const along = new THREE.Vector3(f.fwd.x, 0, f.fwd.z);
      const yaw = along.lengthSq() > 1e-6 ? Math.atan2(-along.z, along.x) : 0;
      this.strap.position.copy(grip).add(new THREE.Vector3(0, -2.2, 0));
      this.strap.rotation.set(0, yaw, 0);
      this.bag.position.copy(grip).add(new THREE.Vector3(0, -2.4 - 6, 0));
      this.bag.rotation.set(0, yaw + Math.PI / 2, 0);
    } else if (this.bag && this.panel.carry) {
      // Le sac, là où le dessin le pose : sur le dos, ou sur la cuisse de notre côté.
      const ends = bagEnds(this.panel.carry, k);
      if (ends) {
        const z = this.panel.carry === 'genoux' ? rig.head('lowerleg01.R').z : 0;
        const a = new THREE.Vector3(ends.a[0], ends.a[1], z);
        const b = new THREE.Vector3(ends.b[0], ends.b[1], z);
        this.bag.position.copy(a).lerp(b, 0.5);
        this.bag.quaternion.setFromUnitVectors(Y, b.clone().sub(a).normalize());
        this.bag.scale.set(ends.r, (a.distanceTo(b) + 2 * ends.r) / 3, ends.r * 1.7);
      }
    }
  }
}

/** Les deux bouts du sac et son rayon, comme `carryShape` les pose sur le dessin. */
function bagEnds(carry: NonNullable<Panel['carry']>, k: Skeleton): { a: Pt; b: Pt; r: number } | null {
  const j = k.joints;
  if (carry === 'dos') {
    const hip = j.hip!;
    const up = unit(sub(j.shoulder!, hip));
    const front = rot(up, -90);
    const at = (hh: number, f: number): Pt => add(add(hip, mul(up, hh)), mul(front, f));
    return { a: at(9, -9), b: at(22.5, -9.2), r: 3.75 };
  }
  if (carry === 'genoux') {
    const hip = j['near.hip']!;
    const knee = j['near.knee']!;
    const d = unit(sub(knee, hip));
    const c = add(lerp(hip, knee, 0.62), mul(rot(d, 90), 6.4));
    return { a: add(c, mul(d, -3.4)), b: add(c, mul(d, 3.4)), r: 3.5 };
  }
  return null;
}

/** Le rayon du plâtre : il enveloppe le bras, d'un centimètre d'épaisseur. */
function castRadii(d: RestData, side: Side) {
  const r = (a: string, b: string, bones: RegExp) => {
    const A = new THREE.Vector3(...d.head(a));
    const B = new THREE.Vector3(...d.head(b));
    const ax = B.clone().sub(A).normalize();
    const len = A.distanceTo(B);
    const ds: number[] = [];
    const v = new THREE.Vector3();
    const onArm = (n: string) => bones.test(n);
    for (let i = 0; i < d.pos.length / 3; i++) {
      if (d.weightOf(i, onArm) < 0.5) continue;
      v.set(d.pos[i * 3]!, d.pos[i * 3 + 1]!, d.pos[i * 3 + 2]!).sub(A);
      const t = v.dot(ax);
      if (t < 0 || t > len) continue;
      ds.push(v.sub(ax.clone().multiplyScalar(t)).length());
    }
    ds.sort((p, q) => p - q);
    return (ds[Math.floor(ds.length * 0.98)] ?? 2.5) + 0.55;
  };
  return {
    upper: r(`upperarm01.${side}`, `lowerarm01.${side}`, new RegExp(`^upperarm02\\.${side}$`)),
    fore: r(`lowerarm01.${side}`, `wrist.${side}`, new RegExp(`^lowerarm0[12]\\.${side}$`)),
    hand: r(`wrist.${side}`, `finger3-1.${side}`, new RegExp(`^(wrist|metacarpal\\d)\\.${side}$`)),
  };
}

/** Des sommets repères pour le cordon de l'écharpe : les côtés du cou, la nuque, la poitrine. */
function strapAnchors(d: RestData): Record<string, number> {
  const neck = d.head('neck01');
  const sh = d.head('upperarm01.R');
  const n = d.pos.length / 3;
  const best = (score: (x: number, y: number, z: number) => number) => {
    let bi = 0, bs = -Infinity;
    for (let i = 0; i < n; i++) {
      const s = score(d.pos[i * 3]!, d.pos[i * 3 + 1]!, d.pos[i * 3 + 2]!);
      if (s > bs) { bs = s; bi = i; }
    }
    return bi;
  };
  const near = (v: number, c: number, r: number) => (Math.abs(v - c) < r ? 0 : -1e6);
  return {
    neckR: best((x, y, z) => y + near(y, neck[1] + 0.8, 1.8) + near(z, 4.6, 0.6) + near(x, neck[0], 1.4)),
    neckL: best((x, y, z) => y + near(y, neck[1] + 0.8, 1.8) + near(z, -4.6, 0.6) + near(x, neck[0], 1.4)),
    nape: best((x, y, z) => -x + near(y, neck[1] + 1.2, 0.8) + near(z, 0, 0.8)),
    chestR: best((x, y, z) => x + near(y, sh[1] - 7, 0.8) + near(z, 3.2, 0.8)),
    chestL: best((x, y, z) => x + near(y, sh[1] - 7, 0.8) + near(z, -3.2, 0.8)),
  };
}

/** Une vignette : son mannequin, son décor, ce qu'il porte, sa toile. */
export class FigureView {
  readonly panel: Panel;
  readonly root = new THREE.Group();
  readonly rig: Rig;
  private readonly attachments: Attachments;
  /** La position de départ : un second mannequin, posé une fois, en silhouette pâle. */
  private readonly ghost: Rig | null = null;
  private ghostPosed = false;
  private props: THREE.Group | null = null;
  private propsTop = -Infinity;
  tokens: Tokens | null = null;

  constructor(
    private readonly stage: FigureStage,
    readonly exercise: string,
    panelIndex: number,
    readonly canvas: HTMLCanvasElement,
  ) {
    this.panel = FIGURES[exercise as keyof typeof FIGURES]!.panels[panelIndex]!;
    const scene = cloneSkinned(stage.template);
    this.rig = new Rig(scene);
    const d = this.rig.restData();
    for (const m of this.rig.meshes) {
      m.castShadow = true;
      m.frustumCulled = false;
      if (m === this.rig.body) {
        // Une géométrie à elle, qui partage tout sauf ses muscles.
        const src = m.geometry;
        const g = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(src.attributes)) g.setAttribute(name, attr);
        g.setIndex(src.index);
        g.setAttribute('aFar', stage.far(d));
        g.setAttribute('aMuscle', new THREE.BufferAttribute(muscleMask(d, this.panel.muscles ?? [], this.panel.pose), 1));
        m.geometry = g;
        m.material = stage.materials.body.material;
      } else {
        m.material = stage.materials.eyes;
      }
    }
    // Le corps de l'instant se dessine après la silhouette de départ : il passe toujours devant elle.
    for (const m of this.rig.meshes) m.renderOrder = 2;
    this.attachments = new Attachments(this.rig, this.panel, stage.materials);
    this.attachments.group.traverse((o) => { o.renderOrder = 2; });
    this.root.add(scene, this.attachments.group);
    if (this.panel.ghost) {
      // Une silhouette sans relief ni ombre, qui n'écrit pas la profondeur : le décor devant elle la
      // cache, le corps de l'instant se dessine par-dessus. Pas de pointillé qui court sur le corps.
      const ghostScene = cloneSkinned(stage.template);
      this.ghost = new Rig(ghostScene);
      for (const m of this.ghost.meshes) {
        m.material = stage.materials.ghost;
        m.castShadow = false;
        m.frustumCulled = false;
        m.renderOrder = 1;
        if (m !== this.ghost.body) m.visible = false;
      }
      this.root.add(ghostScene);
    }
    this.root.visible = false;
    stage.scene.add(this.root);
  }

  /** Le décor, bâti à la première image : il monte jusqu'au haut du cadre. */
  ensureProps(top: number) {
    if (this.props && top <= this.propsTop) return;
    if (this.props) this.root.remove(this.props);
    this.props = buildProps(this.panel.props, this.exercise, this.stage.materials, top);
    this.propsTop = top;
    this.root.add(this.props);
  }

  /** La position à l'instant `t` du geste (0 départ, 1 position dessinée). */
  poseAt(t: number) {
    const panel = this.panel;
    if (this.ghost && panel.ghost && !this.ghostPosed) {
      this.ghost.pose(skeleton(panel.ghost), panel.ghost, { props: panel.props, ...(panel.hold ? { hold: panel.hold } : {}) });
      this.ghostPosed = true;
    }
    const pose = panel.ghost ? between(panel.ghost, panel.pose, t) : panel.pose;
    const k = skeleton(pose);
    this.rig.pose(k, pose, { props: panel.props, ...(panel.hold ? { hold: panel.hold } : {}) });
    this.attachments.update(k, pose);
  }

  draw(t: number, frame: FigureFrame): boolean {
    return this.stage.draw(this, t, frame);
  }

  dispose() {
    this.stage.scene.remove(this.root);
    this.stage.views.delete(this);
  }
}

export class FigureStage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera();
  readonly materials: Materials;
  readonly views = new Set<FigureView>();
  private readonly key = new THREE.DirectionalLight(0xfff6ec, 2.3);
  private readonly rim = new THREE.DirectionalLight(0xffffff, 0.9);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.35);
  private readonly floor: THREE.Mesh;
  private farAttr: THREE.BufferAttribute | null = null;
  private size = { w: 0, h: 0 };
  private theme = '';
  /** Le temps de calcul et de rendu de chaque image, ms, et l'intervalle entre deux images d'une vignette. */
  readonly work: number[] = [];
  readonly intervals: number[] = [];
  private readonly lastDraw = new WeakMap<FigureView, number>();

  private constructor(readonly template: THREE.Object3D) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // VSM : la PCF de three 0.186 grise tout le sol dans Safari iOS (constaté sur le simulateur, iOS 26.1).
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.materials = {
      body: bodyMaterial(),
      ghost: new THREE.MeshBasicMaterial({ depthWrite: false, transparent: true }),
      eyes: new THREE.MeshStandardMaterial({ roughness: 0.3 }),
      cast: new THREE.MeshStandardMaterial({ roughness: 0.92 }),
      sling: new THREE.MeshStandardMaterial({ roughness: 0.95, side: THREE.DoubleSide }),
      pad: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
      metal: new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.6 }),
      plate: new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 }),
      mat: new THREE.MeshStandardMaterial({ roughness: 0.95 }),
      towel: new THREE.MeshStandardMaterial({ roughness: 1 }),
      carry: new THREE.MeshStandardMaterial({ roughness: 0.85 }),
      band: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
      backdrop: new THREE.MeshStandardMaterial({ roughness: 1 }),
    };
    // Tout passe dans la même file, réglée par `renderOrder` : le décor, puis la silhouette de départ,
    // puis le corps et ce qu'il porte. La silhouette s'efface en partie pendant le geste (voir `draw`) ;
    // dans une file à part, elle repasserait devant le corps.
    for (const material of Object.values(this.materials)) {
      const m = (material as { material?: THREE.Material }).material ?? (material as THREE.Material);
      m.transparent = true;
    }
    // Le sol qui reçoit l'ombre, incliné de 8° vers nous : vue de profil exact, l'ombre se voit quand même.
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(600, 300), new THREE.ShadowMaterial({ opacity: 0.2 }));
    this.floor.rotation.x = -Math.PI / 2 + (8 * Math.PI) / 180;
    this.floor.receiveShadow = true;
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.radius = 8;
    this.key.shadow.blurSamples = 16;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.4;
    this.scene.add(this.floor, this.key, this.key.target, this.rim, this.rim.target, this.hemi);
    if (location.search.includes('figures=mesure')) this.showStats();
  }

  /**
   * Le compteur des essais (`?figures=mesure`) : images par seconde des vignettes qui bougent,
   * temps de calcul d'une image. Sans ce paramètre, rien ne s'affiche ni ne se mesure en plus.
   */
  private showStats() {
    const el = document.createElement('output');
    el.style.cssText = 'position:fixed;left:8px;bottom:calc(64px + env(safe-area-inset-bottom));z-index:99;font:12px/1.3 ui-monospace,Menlo,monospace;background:var(--bg-elev);color:var(--text);padding:4px 6px;border:1px solid var(--border)';
    document.body.append(el);
    const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    setInterval(() => {
      const iv = this.intervals.slice(-120).filter((x) => x < 500);
      const wk = this.work.slice(-120);
      el.textContent = `3D ${iv.length ? (1000 / mean(iv)).toFixed(0) : '–'} i/s · p95 ${pct(iv, 0.95).toFixed(0)} ms · calcul ${mean(wk).toFixed(1)} ms (p95 ${pct(wk, 0.95).toFixed(1)}) · ${this.views.size} vignettes`;
    }, 1000);
  }

  private static loading: Promise<FigureStage> | null = null;

  /** La scène, créée une fois : le mannequin chargé, le moteur prêt. Échoue sans WebGL. */
  static get(): Promise<FigureStage> {
    FigureStage.loading ??= (async () => {
      const data = await fetch(MODEL_URL).then((r) => {
        if (!r.ok) throw new Error(`Mannequin : ${r.status}`);
        return r.arrayBuffer();
      });
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(data, '');
      return new FigureStage(gltf.scene);
    })();
    FigureStage.loading.catch(() => { FigureStage.loading = null; });
    return FigureStage.loading;
  }

  /** Le côté opposé : le même pour tous les clones, calculé une fois. */
  far(d: RestData): THREE.BufferAttribute {
    this.farAttr ??= new THREE.BufferAttribute(farMask(d), 1);
    return this.farAttr;
  }

  view(exercise: string, panelIndex: number, canvas: HTMLCanvasElement): FigureView {
    const v = new FigureView(this, exercise, panelIndex, canvas);
    this.views.add(v);
    return v;
  }

  private applyTheme(t: Tokens) {
    const m = this.materials;
    m.body.material.color.copy(t.near);
    m.body.uniforms.uMuscle.value.copy(t.muscle);
    m.body.uniforms.uFar.value.copy(t.far);
    // Le côté opposé, un ton au-dessus du corps : il ne se confond pas avec la silhouette pâle du départ.
    m.body.uniforms.uFarMix.value = t.dark ? 0.7 : 0.3;
    m.body.uniforms.uShoe.value.copy(t.shoe);
    m.body.uniforms.uSole.value.copy(t.sole);
    m.body.material.roughness = t.dark ? 0.68 : 0.62;
    m.ghost.color.copy(t.ghost);
    m.eyes.color.copy(t.near).lerp(t.plate, 0.35);
    m.cast.color.copy(t.cast);
    m.sling.color.copy(t.sling);
    m.pad.color.copy(t.pad);
    m.metal.color.copy(t.metal);
    m.plate.color.copy(t.plate);
    m.mat.color.copy(t.mat);
    m.towel.color.copy(t.towel);
    m.carry.color.copy(t.carry);
    m.band.color.copy(t.band);
    m.backdrop.color.copy(t.backdrop);
    (this.floor.material as THREE.ShadowMaterial).opacity = t.dark ? 0.5 : 0.2;
    // Un corps clair sous la lumière du jour blanchit : la nuit, moins de lumière, pour qu'il garde sa couleur et ses muscles.
    this.hemi.groundColor.copy(t.pad);
    this.hemi.intensity = t.dark ? 0.2 : 0.35;
    this.scene.environmentIntensity = t.dark ? 0.32 : 0.55;
    this.rim.intensity = t.dark ? 1.3 : 0.9;
    this.key.intensity = t.dark ? 1.25 : 2.3;
  }

  /**
   * Dessine une vignette à l'instant `t`, dans son cadre, et recopie l'image
   * dans sa toile. `false` si la toile n'a pas de taille (hors de la page).
   */
  draw(view: FigureView, t: number, frame: FigureFrame): boolean {
    const canvas = view.canvas;
    // La pleine résolution de l'écran, jusqu'à 3 : un iPhone récent dessine net, sans flou de mise à l'échelle.
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (w < 2 || h < 2) return false;
    const start = performance.now();
    const theme = document.documentElement.dataset.theme ?? 'light';
    if (!view.tokens || theme !== this.theme) {
      for (const v of this.views) v.tokens = null;
      this.theme = theme;
    }
    view.tokens ??= readTokens(canvas);
    this.applyTheme(view.tokens);
    // Le côté opposé ne se teinte que de profil : de face, de dos, de dessus, les deux côtés se voient autant.
    const viewOf = view.panel.pose.view;
    if (viewOf !== 'side') this.materials.body.uniforms.uFarMix.value = 0;
    this.floor.visible = viewOf !== 'top';
    for (const v of this.views) v.root.visible = v === view;
    view.ensureProps(frame.y1);
    view.poseAt(t);
    // La silhouette de départ apparaît quand le corps la quitte : pendant le geste, elle ne fait pas de
    // liseré autour de lui ; à l'arrêt, sur la position dessinée, elle est entière.
    const g = Math.min(1, Math.max(0, (t - 0.2) / 0.4));
    this.materials.ghost.opacity = g * g * (3 - 2 * g);

    // Le cadre du dessin, agrandi pour remplir la toile sans déformer (« meet » du SVG).
    let fw = frame.x1 - frame.x0;
    let fh = frame.y1 - frame.y0;
    if (fw / fh > w / h) fh = fw * (h / w); else fw = fh * (w / h);
    const cx = (frame.x0 + frame.x1) / 2;
    const cy = (frame.y0 + frame.y1) / 2;
    this.camera.position.set(cx, cy, 300);
    this.camera.lookAt(cx, cy, 0);
    Object.assign(this.camera, { left: -fw / 2, right: fw / 2, top: fh / 2, bottom: -fh / 2, near: 1, far: 800 });
    this.camera.updateProjectionMatrix();
    this.key.position.set(cx + 30, 140, 60);
    this.key.target.position.set(cx, 0, 0);
    this.rim.position.set(cx - 70, 60, -50);
    this.rim.target.position.set(cx, 40, 0);
    const s = Math.max(fw, fh) * 0.75;
    Object.assign(this.key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 400 });
    this.key.shadow.camera.updateProjectionMatrix();
    this.floor.position.x = cx;

    // Le moteur dessine dans le coin haut-gauche de sa toile, qui ne fait que grandir.
    if (w > this.size.w || h > this.size.h) {
      this.size = { w: Math.max(w, this.size.w), h: Math.max(h, this.size.h) };
      this.renderer.setSize(this.size.w, this.size.h, false);
    }
    const y = this.size.h - h;
    this.renderer.setViewport(0, y, w, h);
    this.renderer.setScissor(0, y, w, h);
    this.renderer.setScissorTest(true);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.renderer.domElement, 0, 0, w, h, 0, 0, w, h);
    const end = performance.now();
    this.work.push(end - start);
    const last = this.lastDraw.get(view);
    if (last !== undefined) this.intervals.push(end - last);
    this.lastDraw.set(view, end);
    if (this.work.length > 600) this.work.shift();
    if (this.intervals.length > 600) this.intervals.shift();
    return true;
  }
}
