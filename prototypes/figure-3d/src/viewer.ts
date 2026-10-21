/**
 * Une vignette 3D : le mannequin dans son décor, éclairé comme en studio, vu
 * de profil, animé au tempo de la séance entre la position de départ et la
 * position dessinée — les mêmes que le schéma vectoriel (`between`, `phaseAt`).
 *
 * La lumière : un environnement de studio (réflexions douces), une lumière
 * principale devant et au-dessus qui porte l'ombre au sol, un contre-jour qui
 * détache la silhouette du fond. Le cadre est celui du schéma vectoriel : le
 * corps dans toutes ses positions et le décor.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { FIGURES } from '../../../apps/web/lib/exerciseFigures';
import { between, parts, skeleton, FURNITURE, type Panel, type Pose, type Prop, type Pt, type SidePose } from '../../../apps/web/lib/figure';
import { cycleOf, phaseAt, type Cycle } from '../../../apps/web/lib/motion';
import { farMask, muscleMask } from './muscles';
import { BENCH, BOX } from './props';
import { parseRig, type Rig } from './rig';
import { DARK, LIGHT, type Tokens } from './tokens';

export type Theme = 'light' | 'dark';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  exercise: keyof typeof FIGURES;
  theme: Theme;
  tempo?: string;
  /** Le regard au-dessus de l'horizontale, degrés : assez pour voir l'ombre au sol. */
  elevation?: number;
  /** Le regard tourné vers l'avant du corps, degrés : 0, le profil strict. */
  yaw?: number;
  pixelRatio?: number;
  /** Le type de carte d'ombres (essais sur Safari iOS). */
  shadow?: 'pcf' | 'vsm' | 'basic';
  /** Le cadre, en unités du corps ; par défaut celui du schéma vectoriel sans ses consignes. */
  frame?: { x0: number; x1: number; y0: number; y1: number };
}

const color = (hex: string) => new THREE.Color(hex);
const mix = (a: string, b: string, t: number) => color(a).lerp(color(b), t);

/** Le cadre du schéma vectoriel, sans ses consignes : le corps dans toutes ses positions, le décor. */
function frameOf(panel: Panel): { x0: number; x1: number; y0: number; y1: number } {
  const pts: Pt[] = [];
  const add = (pose: Pose) => { for (const p of parts(pose).parts) pts.push(...p.pts); };
  add(panel.pose);
  if (panel.ghost) {
    add(panel.ghost);
    for (const s of [0.2, 0.4, 0.6, 0.8]) add(between(panel.ghost, panel.pose, s));
  }
  for (const prop of panel.props) {
    if (prop.kind === 'bench') pts.push([prop.from, 0], [prop.to, prop.h]);
    if (prop.kind === 'box') pts.push([prop.x, 0], [prop.x - prop.face * prop.depth, prop.h]);
    if (prop.kind === 'mat') pts.push([prop.from, 0], [prop.to, 1]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs) - 3.5, x1: Math.max(...xs) + 3.5, y0: Math.min(0, ...ys) - 3, y1: Math.max(...ys) + 3.5 };
}

/** Le matériau du corps : la couleur du mannequin, les muscles fondus vers la terracotta, le côté opposé teinté. */
function bodyMaterial() {
  const uniforms = {
    uMuscle: { value: new THREE.Color() },
    uFar: { value: new THREE.Color() },
    uFarMix: { value: 0.5 },
    uMuscleRough: { value: 0.72 },
  };
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.62, metalness: 0, sheen: 0.15, sheenRoughness: 0.8 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMuscle;\nattribute float aFar;\nvarying float vMuscle;\nvarying float vFar;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMuscle = aMuscle;\nvFar = aFar;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uMuscle;\nuniform vec3 uFar;\nuniform float uFarMix;\nuniform float uMuscleRough;\nvarying float vMuscle;\nvarying float vFar;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec3 baseTone = mix( diffuse, uFar, vFar * uFarMix );\n\tvec4 diffuseColor = vec4( mix( baseTone, uMuscle, vMuscle ), opacity );')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix( roughnessFactor, uMuscleRough, vMuscle );');
  };
  return { material: m, uniforms };
}

/** Un cylindre de hauteur 1 posé de `a` à `b`. */
function place(mesh: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  const d = b.clone().sub(a);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  mesh.scale.set(1, d.length(), 1);
}

/**
 * Un cordon rembourré qui suit une courbe : la sangle de l'écharpe, du poignet
 * au cou et retour (« collar and cuff »). La géométrie est allouée une fois et
 * recalculée à chaque image, par repères de Frenet.
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

export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera();
  readonly panel: Panel;
  readonly cycle: Cycle;
  rig!: Rig;
  private tokens: Tokens;
  private readonly body = bodyMaterial();
  private readonly eyes = new THREE.MeshStandardMaterial({ roughness: 0.3 });
  private readonly cast = new THREE.MeshStandardMaterial({ roughness: 0.92 });
  private readonly sling = new THREE.MeshStandardMaterial({ roughness: 0.95, side: THREE.DoubleSide });
  private readonly pad = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  private readonly metal = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.6 });
  private readonly plate = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.15 });
  private readonly matMat = new THREE.MeshStandardMaterial({ roughness: 0.95 });
  private readonly shadow = new THREE.ShadowMaterial({ opacity: 0.2 });
  private readonly key = new THREE.DirectionalLight(0xffffff, 2.1);
  private readonly rim = new THREE.DirectionalLight(0xffffff, 1.1);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.35);
  private readonly frame: { x0: number; x1: number; y0: number; y1: number };
  private castParts: THREE.Mesh[] = [];
  private cuff: THREE.Mesh | null = null;
  private strap: Cord | null = null;
  private dumbbell: THREE.Group | null = null;
  private anchors: Record<string, number> = {};
  private castR = { upper: 3, fore: 3, hand: 2.4 };
  private raf = 0;
  private t0 = 0;
  /** Figé : sur la position dessinée, ou sur l'instant `still` du geste. */
  paused = false;
  still = 1;
  /** Les mesures de fluidité : intervalles entre images, et temps de calcul d'une image, ms. */
  readonly stats = { intervals: [] as number[], work: [] as number[] };
  private last = 0;
  readonly opts: ViewerOptions;

  constructor(opts: ViewerOptions) {
    this.opts = opts;
    this.panel = FIGURES[opts.exercise]!.panels[0]!;
    this.cycle = cycleOf(opts.tempo);
    this.tokens = opts.theme === 'dark' ? DARK : LIGHT;
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(opts.pixelRatio ?? Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    const shadowTypes = { pcf: THREE.PCFShadowMap, vsm: THREE.VSMShadowMap, basic: THREE.BasicShadowMap } as const;
    // VSM par défaut : la PCF de three 0.186 grise tout le sol dans Safari iOS (constaté sur le simulateur, iOS 26.1).
    this.renderer.shadowMap.type = shadowTypes[opts.shadow ?? 'vsm'];
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.frame = opts.frame ?? frameOf(this.panel);
  }

  async load(glb: ArrayBuffer) {
    this.rig = await parseRig(glb);
    const rig = this.rig;
    for (const m of rig.meshes) {
      m.castShadow = true;
      m.receiveShadow = false;
      m.frustumCulled = false;
      const g = m.geometry;
      const n = g.attributes.position!.count;
      if (m === rig.body) {
        g.setAttribute('aMuscle', new THREE.BufferAttribute(muscleMask(rig, this.panel.muscles ?? []), 1));
        g.setAttribute('aFar', new THREE.BufferAttribute(farMask(rig), 1));
        m.material = this.body.material;
      } else {
        g.setAttribute('aMuscle', new THREE.BufferAttribute(new Float32Array(n), 1));
        g.setAttribute('aFar', new THREE.BufferAttribute(new Float32Array(n), 1));
        m.material = this.eyes;
      }
    }
    this.scene.add(rig.scene);
    this.measureCast();
    this.pickAnchors();
    this.buildProps();
    this.buildAttachments();
    this.buildLights();
    this.setTheme(this.opts.theme);
    this.resize();
    this.render(1);
  }

  // ── Le décor ──────────────────────────────────────────────────────────────

  private buildProps() {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 200), this.shadow);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    for (const prop of this.panel.props as Prop[]) {
      if (prop.kind === 'bench') {
        const w = BENCH.width;
        const top = new THREE.Mesh(new RoundedBoxGeometry(prop.to - prop.from, 2.6, w, 3, 0.6), this.pad);
        top.position.set((prop.from + prop.to) / 2, prop.h - 1.3, BENCH.z);
        this.scene.add(top);
        for (const x of [prop.from + 3, prop.to - 3]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(1.4, prop.h - 2.6, w - 3), this.metal);
          leg.position.set(x, (prop.h - 2.6) / 2, BENCH.z);
          this.scene.add(leg);
        }
      } else if (prop.kind === 'box') {
        const a = prop.x - prop.face * prop.depth;
        // La caisse sous le pied d'appui, décalée de son côté : la jambe arrière passe à côté, pas au travers.
        const box = new THREE.Mesh(new RoundedBoxGeometry(prop.depth, prop.h, BOX.width, 3, 0.7), this.pad);
        box.position.set((a + prop.x) / 2, prop.h / 2, BOX.z);
        this.scene.add(box);
      } else if (prop.kind === 'mat') {
        const mat = new THREE.Mesh(new RoundedBoxGeometry(prop.to - prop.from, FURNITURE.mat, 34, 2, 0.25), this.matMat);
        mat.position.set((prop.from + prop.to) / 2, FURNITURE.mat / 2, 0);
        this.scene.add(mat);
      }
    }
    for (const o of this.scene.children) if ((o as THREE.Mesh).isMesh && o !== floor) { o.castShadow = true; o.receiveShadow = true; }
  }

  private buildLights() {
    const { x0, x1, y1 } = this.frame;
    const cx = (x0 + x1) / 2;
    this.key.position.set(cx + 30, 140, 60);
    this.key.target.position.set(cx, 0, 0);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    const s = Math.max(x1 - x0, y1) * 0.75;
    Object.assign(this.key.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 400 });
    this.key.shadow.radius = 8;
    this.key.shadow.blurSamples = 16;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.4;
    this.rim.position.set(cx - 70, 60, -50);
    this.rim.target.position.set(cx, 40, 0);
    this.scene.add(this.key, this.key.target, this.rim, this.rim.target, this.hemi);
  }

  // ── Le plâtre, l'écharpe, l'haltère ───────────────────────────────────────

  /** Le rayon du plâtre : il enveloppe le bras, d'un centimètre d'épaisseur. */
  private measureCast() {
    const d = this.rig.restData();
    const side = this.castSide();
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
    this.castR = {
      upper: r(`upperarm01.${side}`, `lowerarm01.${side}`, new RegExp(`^upperarm02\\.${side}$`)),
      fore: r(`lowerarm01.${side}`, `wrist.${side}`, new RegExp(`^lowerarm0[12]\\.${side}$`)),
      hand: r(`wrist.${side}`, `finger3-1.${side}`, new RegExp(`^(wrist|metacarpal\\d)\\.${side}$`)),
    };
  }

  private castSide(): 'R' | 'L' {
    return (this.panel.pose as SidePose).freeSide === 'far' ? 'R' : 'L';
  }

  /** Des sommets repères pour la sangle de l'écharpe : le cou, la poitrine. */
  private pickAnchors() {
    const d = this.rig.restData();
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
    this.anchors = {
      // Le côté du cou, où la sangle passe : sur le trapèze, à 4 unités du milieu.
      neckR: best((x, y, z) => y + near(y, neck[1] + 0.8, 1.8) + near(z, 4.6, 0.6) + near(x, neck[0], 1.4)),
      neckL: best((x, y, z) => y + near(y, neck[1] + 0.8, 1.8) + near(z, -4.6, 0.6) + near(x, neck[0], 1.4)),
      nape: best((x, y, z) => -x + near(y, neck[1] + 1.2, 0.8) + near(z, 0, 0.8)),
      chestR: best((x, y, z) => x + near(y, sh[1] - 7, 0.8) + near(z, 3.2, 0.8)),
      chestL: best((x, y, z) => x + near(y, sh[1] - 7, 0.8) + near(z, -3.2, 0.8)),
    };
  }

  private buildAttachments() {
    const pose = this.panel.pose as SidePose;
    const castOver = typeof pose.cast === 'object' && pose.cast.over === true;
    const cyl = (r0: number, r1: number) => new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 1, 40, 1, true), this.cast);
    const ball = (r: number) => new THREE.Mesh(new THREE.SphereGeometry(r, 40, 20), this.cast);
    const R = this.castR;
    this.castParts = [
      cyl(R.upper, R.upper + 0.15), ball(R.upper), // du milieu du bras au coude
      ball(R.upper + 0.15),
      cyl(R.fore + 0.1, R.fore), // l'avant-bras
      ball(R.fore),
      cyl(R.fore, R.hand), ball(R.hand), // la main jusqu'aux phalanges
    ];
    for (const m of this.castParts) { m.castShadow = true; this.scene.add(m); }
    // Les bouts du plâtre se referment : les sphères ferment les cylindres ouverts.
    if (!castOver) {
      this.cuff = new THREE.Mesh(new THREE.CylinderGeometry(R.fore + 0.45, R.fore + 0.45, 3.4, 40, 1, true), this.sling);
      this.cuff.castShadow = true;
      this.scene.add(this.cuff);
      this.strap = new Cord(this.sling, 0.75);
      this.scene.add(this.strap.mesh);
    }
    if (this.panel.hold === 'dumbbell') {
      const g = new THREE.Group();
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 9.6, 24), this.metal);
      g.add(handle);
      const profile = [[0, -1.15], [2.9, -1.15], [3.2, -0.85], [3.2, 0.85], [2.9, 1.15], [0, 1.15]].map(([x, y]) => new THREE.Vector2(x, y));
      const disc = new THREE.LatheGeometry(profile, 48);
      for (const y of [-3.75, 3.75]) {
        const p = new THREE.Mesh(disc, this.plate);
        p.position.y = y;
        g.add(p);
      }
      g.traverse((o) => { o.castShadow = true; });
      this.dumbbell = g;
      this.scene.add(g);
    }
  }

  private updateAttachments() {
    const rig = this.rig;
    const s = this.castSide();
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
    place(ch, wrist, handEnd);
    bh.position.copy(handEnd);
    // La main plâtrée est plate : aplatie dans l'axe de la paume.
    const palm = rig.palm(s);
    const along = handEnd.clone().sub(wrist).normalize();
    const across = along.clone().cross(palm).normalize();
    const basis = new THREE.Matrix4().makeBasis(across, along, perp3(palm, along));
    ch.quaternion.setFromRotationMatrix(basis);
    ch.scale.set(1, wrist.distanceTo(handEnd), 0.68);
    bh.quaternion.copy(ch.quaternion);
    bh.scale.set(1, 1, 0.68);

    if (this.cuff && this.strap) {
      // Le bracelet autour du poignet plâtré ; le cordon en part, passe au cou et revient.
      const fore = wrist.clone().sub(elbow).normalize();
      const cuffAt = wrist.clone().addScaledVector(fore, -2.6);
      this.cuff.position.copy(cuffAt);
      this.cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), fore);
      const a = this.anchors;
      const v = (i: number) => rig.vertex(i);
      const up = h('neck01').sub(h('spine05')).normalize();
      const top = cuffAt.clone().addScaledVector(perp3(up, fore), this.castR.fore + 0.6);
      const side = new THREE.Vector3().crossVectors(fore, up).normalize();
      const pts = [
        top.clone().addScaledVector(side, 1.1),
        v(a.chestR!).addScaledVector(new THREE.Vector3(1, 0.2, 0.3).normalize(), 1.0),
        v(a.neckR!).add(new THREE.Vector3(0, 0.9, 0.3)),
        v(a.nape!).add(new THREE.Vector3(-0.9, 0.3, 0)),
        v(a.neckL!).add(new THREE.Vector3(0, 0.9, -0.3)),
        v(a.chestL!).addScaledVector(new THREE.Vector3(1, 0.2, -0.3).normalize(), 1.0),
        top.clone().addScaledVector(side, -1.1),
      ];
      this.strap.update(new THREE.CatmullRomCurve3(pts, false, 'centripetal'));
    }

    if (this.dumbbell) {
      const f = (this.panel.pose as SidePose).freeSide === 'far' ? 'L' : 'R';
      const kn = ['finger2-1', 'finger3-1', 'finger4-1', 'finger5-1'].map((n) => h(`${n}.${f}`)).reduce((p, q) => p.add(q)).multiplyScalar(0.25);
      const c = kn.addScaledVector(rig.palm(f), 1.25).addScaledVector(rig.along(f), 1.1);
      this.dumbbell.position.copy(c);
      this.dumbbell.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), rig.across(f));
    }
  }

  // ── Le thème, le cadre, l'image ───────────────────────────────────────────

  setTheme(theme: Theme) {
    const t = (this.tokens = theme === 'dark' ? DARK : LIGHT);
    this.renderer.setClearColor(color(t.bgElev));
    this.body.material.color = color(t.near);
    this.body.uniforms.uMuscle.value = color(t.muscle);
    this.body.uniforms.uFar.value = color(t.far);
    this.body.uniforms.uFarMix.value = theme === 'dark' ? 0.8 : 0.42;
    this.body.material.roughness = theme === 'dark' ? 0.68 : 0.58;
    this.body.material.sheenColor = color(theme === 'dark' ? '#ffffff' : t.far);
    this.eyes.color = mix(t.near, t.text, 0.35);
    this.cast.color = color(t.cast);
    this.sling.color = color(t.sling);
    this.pad.color = mix(t.bgElev2, t.borderStrong, theme === 'dark' ? 0.7 : 0.85);
    this.metal.color = color(t.textFaint);
    this.plate.color = color(t.textDim);
    this.matMat.color = color(t.mat);
    this.shadow.opacity = theme === 'dark' ? 0.5 : 0.2;
    this.hemi.color = color('#ffffff');
    this.hemi.groundColor = color(t.bgElev2);
    // Un corps clair sous la lumière du jour blanchit : la nuit, moins de lumière, pour qu'il garde sa couleur et ses muscles.
    this.hemi.intensity = theme === 'dark' ? 0.2 : 0.35;
    this.scene.environmentIntensity = theme === 'dark' ? 0.32 : 0.55;
    this.rim.intensity = theme === 'dark' ? 1.3 : 0.9;
    this.key.intensity = theme === 'dark' ? 1.25 : 2.3;
    this.key.color = color('#fff6ec');
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 300;
    const hgt = c.clientHeight || 300;
    this.renderer.setSize(w, hgt, false);
    const { x0, x1, y0, y1 } = this.frame;
    // Tourné, le corps prend de la largeur : le cadre s'élargit d'autant.
    const turned = 1 + Math.abs(Math.sin(((this.opts.yaw ?? 0) * Math.PI) / 180)) * 0.35;
    let fw = (x1 - x0) * turned;
    let fh = (y1 - y0) * (turned > 1 ? 1.08 : 1);
    if (fw / fh > w / hgt) fh = fw * (hgt / w); else fw = fh * (w / hgt);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const e = (this.opts.elevation ?? 6) * Math.PI / 180;
    const yaw = (this.opts.yaw ?? 0) * Math.PI / 180;
    const dist = 300;
    this.camera.position.set(cx + Math.sin(yaw) * Math.cos(e) * dist, cy + Math.sin(e) * dist, Math.cos(yaw) * Math.cos(e) * dist);
    this.camera.lookAt(cx, cy, 0);
    Object.assign(this.camera, { left: -fw / 2, right: fw / 2, top: fh / 2, bottom: -fh / 2, near: 1, far: 800 });
    this.camera.updateProjectionMatrix();
  }

  /** La position à l'instant `t` du geste (0 départ, 1 position dessinée), dessinée. */
  render(t: number) {
    const panel = this.panel;
    const pose = (panel.ghost ? between(panel.ghost, panel.pose, t) : panel.pose) as SidePose;
    this.rig.pose(skeleton(pose), pose, { hold: panel.hold === 'dumbbell', supine: pose.lean < -60 });
    this.updateAttachments();
    this.renderer.render(this.scene, this.camera);
  }

  /** La position de l'instant, pour l'animation ; 1 quand c'est figé. */
  phase(now: number) {
    return this.paused || !this.panel.ghost ? this.still : phaseAt(this.cycle, now - this.t0);
  }

  start() {
    this.stop();
    this.t0 = performance.now();
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      if (this.last) this.stats.intervals.push(now - this.last);
      this.last = now;
      const a = performance.now();
      this.render(this.phase(now));
      this.stats.work.push(performance.now() - a);
      if (this.stats.intervals.length > 600) { this.stats.intervals.shift(); this.stats.work.shift(); }
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.last = 0;
  }
}

const perp3 = (v: THREE.Vector3, axis: THREE.Vector3) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis))).normalize();
