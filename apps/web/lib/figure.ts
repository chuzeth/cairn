/**
 * Les schémas d'exercices : un corps aux proportions humaines, posé par ses
 * appuis, et ce que l'œil doit y lire.
 *
 * Le 05/10, Pierre : « des schémas très précis, beaucoup plus précis que ce
 * que tu as fait ». Les premiers étaient des bâtons posés point par point : un
 * tibia plus long que l'autre, un genou « à angle droit » qui n'en faisait pas
 * un. Ici le corps mesure 100 unités, ses segments ont les longueurs de Winter
 * (Biomechanics and Motor Control of Human Movement, 2009), un pied posé sur
 * le sol se résout jusqu'au sol, et un angle affiché est celui du dessin : les
 * tests le vérifient.
 *
 * Coordonnées du monde : x vers l'avant du corps, y vers le haut, le sol à 0.
 * Une unité vaut 1,8 cm pour 1,80 m. Rien ici ne trace : ce module calcule des
 * points et des contours, `ExerciseFigure` les dessine.
 */

export type Pt = readonly [number, number];

// ─────────────────────────────────────────────────────────────────────────────
// Vecteurs
// ─────────────────────────────────────────────────────────────────────────────

const RAD = Math.PI / 180;
export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
export const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
export const norm = (a: Pt): number => Math.hypot(a[0], a[1]);
export const dist = (a: Pt, b: Pt): number => norm(sub(a, b));
export const unit = (a: Pt): Pt => {
  const n = norm(a);
  return n === 0 ? [0, 0] : [a[0] / n, a[1] / n];
};
export const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** Rotation dans le sens trigonométrique, degrés (y vers le haut). */
export const rot = ([x, y]: Pt, deg: number): Pt => {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [x * c - y * s, x * s + y * c];
};
/**
 * La direction d'un segment : degrés depuis la verticale descendante, positifs
 * vers l'avant. 0 pend, 90 pointe devant, 180 monte, −90 part derrière.
 */
export const dir = (theta: number): Pt => [Math.sin(theta * RAD), -Math.cos(theta * RAD)];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];

/** L'angle intérieur au sommet `at`, entre `a` et `b`, degrés (0 à 180). */
export function angleAt(a: Pt, at: Pt, b: Pt): number {
  const u = unit(sub(a, at));
  const v = unit(sub(b, at));
  return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) / RAD;
}

/**
 * Le sommet intermédiaire d'une chaîne de deux segments — le genou entre la
 * hanche et la cheville, le coude entre l'épaule et le poignet.
 *
 * `bend` choisit le côté : +1 pour un genou, qui plie vers l'avant du corps ;
 * −1 pour un coude, qui plie vers l'arrière. Hors d'atteinte, la chaîne se
 * tend vers la cible : `reach` le dit, et les tests le refusent.
 */
export function solve2(root: Pt, target: Pt, a: number, b: number, bend: 1 | -1): { mid: Pt; end: Pt; reach: boolean } {
  const v = sub(target, root);
  const d0 = norm(v);
  const reach = d0 <= a + b + 0.05 && d0 >= Math.abs(a - b) - 0.05;
  const d = Math.min(a + b - 1e-6, Math.max(Math.abs(a - b) + 1e-6, d0));
  const u = unit(v);
  const alpha = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)))) / RAD;
  const m1 = add(root, mul(rot(u, alpha), a));
  const m2 = add(root, mul(rot(u, -alpha), a));
  const mid = Math.sign(cross(v, sub(m1, root))) === bend ? m1 : m2;
  const end = add(mid, mul(unit(sub(target, mid)), b));
  return { mid, end, reach };
}

// ─────────────────────────────────────────────────────────────────────────────
// Le corps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Longueurs des segments pour un corps de 100 unités (Winter 2009) : hanche à
 * 0,530 de la taille, genou à 0,285, cheville à 0,039, épaule à 0,818 ; bras
 * 0,186, avant-bras 0,146, pied 0,152.
 */
export const SEG = {
  trunk: 28.8,
  /** De l'épaule au centre de la tête. */
  neck: 11.2,
  thigh: 24.5,
  shank: 24.6,
  upperArm: 18.6,
  forearm: 14.6,
  /** Du poignet au bout des doigts, main à demi fermée. */
  hand: 8,
  /** Hauteur de la cheville au-dessus de la plante. */
  ankle: 3.9,
  heel: 3.8,
  ball: 8,
  toe: 11.4,
} as const;

/** Une jambe : posée par sa cheville (le genou se résout), ou par ses angles. */
export type LegSpec =
  | { ankle: Pt; sole?: number }
  | { thigh: number; shank: number; sole?: number };

/**
 * Un bras : la main où elle doit être (le coude se résout), ses angles, ou ses
 * points quand le bras vient vers nous et que la vue le raccourcit. `hand` est
 * le poignet ; `fingers`, la direction des doigts quand la main ne prolonge pas
 * l'avant-bras — 180, à plat contre un mur, les doigts vers le haut.
 */
export type ArmSpec =
  | { hand: Pt; fingers?: number }
  | { upper: number; fore: number }
  | { elbow: Pt; hand: Pt; fingers?: number };

/** De profil, l'athlète regarde vers les x croissants. */
export interface SidePose {
  view: 'side';
  hip: Pt;
  /** Le buste penché vers l'avant, degrés : 0 debout, 90 à l'horizontale face au sol, −90 couché sur le dos. */
  lean: number;
  /** La tête par rapport au buste, degrés : + le menton vers la poitrine. */
  nod?: number;
  /** La jambe de notre côté, et celle de l'autre côté, plus pâle. */
  near: LegSpec;
  far: LegSpec;
  /** Le bras libre, et son côté (`near` par défaut). */
  free: ArmSpec;
  freeSide?: 'near' | 'far';
  /**
   * Le bras plâtré : en écharpe par défaut, l'avant-bras dessiné devant soi ;
   * `across`, l'avant-bras en travers du ventre, que le profil raccourcit —
   * face à un mur, il ne le traverse pas ; `over` le pose sur le corps, dessiné par-dessus.
   */
  cast?: (ArmSpec & { over?: boolean }) | 'sling' | 'across';
}

/** De face (ou de dos) : la gauche et la droite sont celles de l'image. */
export interface FrontPose {
  view: 'front';
  /** Le milieu des deux hanches. */
  pelvis: Pt;
  /** Le buste penché vers la droite de l'image, degrés. */
  tilt?: number;
  /** Tout le corps tourné autour du bassin, degrés, sens trigonométrique (un gainage latéral). */
  turn?: number;
  left: { ankle: Pt };
  right: { ankle: Pt };
  free: { side: 'left' | 'right'; elbow: Pt; hand: Pt };
  /** Le bras plâtré, en écharpe par défaut. */
  cast?: { elbow: Pt; hand: Pt };
  /** Vu de dos : le visage ne se voit pas. */
  back?: boolean;
}

/** Vu du dessus : x sur le côté, y vers l'avant. */
export interface TopPose {
  view: 'top';
  /** Le milieu des épaules. */
  at: Pt;
  free: { side: 'left' | 'right'; elbow: Pt; hand: Pt };
}

export type Pose = SidePose | FrontPose | TopPose;

export interface LegPts { hip: Pt; knee: Pt; ankle: Pt; heel: Pt; ball: Pt; toe: Pt; sole: number; reach: boolean }
export interface ArmPts { shoulder: Pt; elbow: Pt; wrist: Pt; tip: Pt; projected: boolean; reach: boolean }

/** Le squelette résolu : ce que les dessins, les annotations et les tests lisent. */
export interface Skeleton {
  view: Pose['view'];
  joints: Record<string, Pt>;
  legs: Record<string, LegPts>;
  arms: { free: ArmPts; cast: ArmPts };
  /** Les segments posés par leurs angles ou leurs appuis : leur longueur doit être exacte. */
  rigid: [string, string, number][];
  reach: boolean;
}

function legOf(hip: Pt, spec: LegSpec): LegPts {
  let knee: Pt;
  let ankle: Pt;
  let reach = true;
  if ('ankle' in spec) {
    const s = solve2(hip, spec.ankle, SEG.thigh, SEG.shank, 1);
    knee = s.mid;
    ankle = s.end;
    reach = s.reach;
  } else {
    knee = add(hip, mul(dir(spec.thigh), SEG.thigh));
    ankle = add(knee, mul(dir(spec.shank), SEG.shank));
  }
  const sole = spec.sole ?? 0;
  const at = (v: Pt) => add(ankle, rot(v, sole));
  return {
    hip, knee, ankle, sole, reach,
    heel: at([-SEG.heel, -SEG.ankle]),
    ball: at([SEG.ball, -SEG.ankle]),
    toe: at([SEG.toe, -SEG.ankle + 0.8]),
  };
}

function armOf(shoulder: Pt, spec: ArmSpec): ArmPts {
  const fingers = (wrist: Pt, elbow: Pt, k: number): Pt =>
    add(wrist, mul('fingers' in spec && spec.fingers != null ? dir(spec.fingers) : unit(sub(wrist, elbow)), SEG.hand * k));
  if ('elbow' in spec) {
    return { shoulder, elbow: spec.elbow, wrist: spec.hand, tip: fingers(spec.hand, spec.elbow, 0.75), projected: true, reach: true };
  }
  let elbow: Pt;
  let wrist: Pt;
  let reach = true;
  if ('hand' in spec) {
    const s = solve2(shoulder, spec.hand, SEG.upperArm, SEG.forearm, -1);
    elbow = s.mid;
    wrist = s.end;
    reach = s.reach;
  } else {
    elbow = add(shoulder, mul(dir(spec.upper), SEG.upperArm));
    wrist = add(elbow, mul(dir(spec.fore), SEG.forearm));
  }
  return { shoulder, elbow, wrist, tip: fingers(wrist, elbow, 1), projected: false, reach };
}

/** La cheville d'un pied dont l'avant (la tête des métatarses) est posé en `ball`, la plante inclinée de `sole`. */
export const ankleFromBall = (ball: Pt, sole: number): Pt => sub(ball, rot([SEG.ball, -SEG.ankle], sole));
/** La cheville d'un pied posé sur la pointe, le bout des orteils en `toe`. */
export const ankleFromToe = (toe: Pt, sole: number): Pt => sub(toe, rot([SEG.toe, -SEG.ankle + 0.8], sole));
/** La cheville d'un pied dont le talon est posé en `heel`. */
export const ankleFromHeel = (heel: Pt, sole: number): Pt => sub(heel, rot([-SEG.heel, -SEG.ankle], sole));

/** L'angle d'une direction, réciproque de `dir`. */
export const thetaOf = (v: Pt): number => Math.atan2(v[0], -v[1]) / RAD;

/**
 * L'écharpe vue de profil, l'avant-bras en travers du ventre : l'avant-bras et
 * la main, presque perpendiculaires à la vue, n'en montrent qu'un peu moins de la moitié.
 */
function across(shoulder: Pt, elbow: Pt, fore: Pt): ArmPts {
  const wrist = add(elbow, mul(fore, SEG.forearm * 0.45));
  return { shoulder, elbow, wrist, tip: add(wrist, mul(fore, SEG.hand * 0.45)), projected: true, reach: true };
}

function sideSkeleton(p: SidePose): Skeleton {
  const up = dir(180 - p.lean);
  const shoulder = add(p.hip, mul(up, SEG.trunk));
  const head = add(shoulder, mul(dir(180 - p.lean - (p.nod ?? 0)), SEG.neck));
  const near = legOf(p.hip, p.near);
  const far = legOf(p.hip, p.far);
  const free = armOf(shoulder, p.free);
  // L'écharpe : le bras le long du buste, l'avant-bras devant la poitrine.
  const down = thetaOf(sub(p.hip, shoulder));
  const slingElbow = add(shoulder, mul(dir(down + 6), SEG.upperArm));
  const cast =
    p.cast === undefined || p.cast === 'sling'
      ? armOf(shoulder, { upper: down + 6, fore: down + 100 })
      : p.cast === 'across'
        ? across(shoulder, slingElbow, dir(down + 95))
        : armOf(shoulder, p.cast);
  const joints: Record<string, Pt> = {
    hip: p.hip, shoulder, head,
    'near.hip': p.hip, 'near.knee': near.knee, 'near.ankle': near.ankle, 'near.heel': near.heel,
    'near.ball': near.ball, 'near.toe': near.toe,
    'far.hip': p.hip, 'far.knee': far.knee, 'far.ankle': far.ankle, 'far.heel': far.heel,
    'far.ball': far.ball, 'far.toe': far.toe,
    'free.shoulder': shoulder, 'free.elbow': free.elbow, 'free.wrist': free.wrist, 'free.tip': free.tip,
    'cast.shoulder': shoulder, 'cast.elbow': cast.elbow, 'cast.wrist': cast.wrist, 'cast.tip': cast.tip,
  };
  const rigid: [string, string, number][] = [
    ['hip', 'shoulder', SEG.trunk],
    ['near.hip', 'near.knee', SEG.thigh], ['near.knee', 'near.ankle', SEG.shank],
    ['far.hip', 'far.knee', SEG.thigh], ['far.knee', 'far.ankle', SEG.shank],
  ];
  if (!free.projected) rigid.push(['free.shoulder', 'free.elbow', SEG.upperArm], ['free.elbow', 'free.wrist', SEG.forearm]);
  if (!cast.projected) rigid.push(['cast.shoulder', 'cast.elbow', SEG.upperArm], ['cast.elbow', 'cast.wrist', SEG.forearm]);
  return {
    view: 'side', joints, legs: { near, far }, arms: { free, cast }, rigid,
    reach: near.reach && far.reach && free.reach && cast.reach,
  };
}

/** De face : les largeurs d'un homme de 1,80 m. */
export const FRONT = {
  /** Écart des centres des hanches au milieu du bassin. */
  hip: 5,
  /** Écart des épaules. */
  shoulder: 10,
  shoulderHeight: 27,
} as const;

function frontSkeleton(p: FrontPose): Skeleton {
  const turn = p.turn ?? 0;
  const o = p.pelvis;
  // Le corps se construit droit autour du bassin, puis tourne d'un bloc.
  const place = (v: Pt): Pt => add(o, rot(v, turn));
  const up = dir(180 + (p.tilt ?? 0));
  const right = rot(up, -90);
  const atTrunk = (h: number, side: number): Pt => add(mul(up, h), mul(right, side));
  const lHip = place([-FRONT.hip, 0]);
  const rHip = place([FRONT.hip, 0]);
  const lSh = place(atTrunk(FRONT.shoulderHeight, -FRONT.shoulder));
  const rSh = place(atTrunk(FRONT.shoulderHeight, FRONT.shoulder));
  const neck = place(atTrunk(SEG.trunk, 0));
  const head = place(atTrunk(SEG.trunk + SEG.neck, 0));
  const straight = (hip: Pt, ankle: Pt): LegPts => {
    const knee = lerp(hip, ankle, SEG.thigh / (SEG.thigh + SEG.shank));
    return { hip, knee, ankle, heel: ankle, ball: ankle, toe: ankle, sole: 0, reach: dist(hip, ankle) <= SEG.thigh + SEG.shank + 0.05 };
  };
  const left = straight(lHip, p.left.ankle);
  const rightLeg = straight(rHip, p.right.ankle);
  const freeSh = p.free.side === 'left' ? lSh : rSh;
  const castSh = p.free.side === 'left' ? rSh : lSh;
  const free = armOf(freeSh, { elbow: p.free.elbow, hand: p.free.hand });
  // L'écharpe : le coude au flanc, l'avant-bras en travers du ventre.
  const inward = p.free.side === 'left' ? -1 : 1;
  const castSpec = p.cast ?? {
    elbow: place(atTrunk(FRONT.shoulderHeight - 17.5, -inward * 9.2)),
    hand: place(atTrunk(FRONT.shoulderHeight - 14.5, inward * 4.5)),
  };
  const cast = armOf(castSh, castSpec);
  const joints: Record<string, Pt> = {
    pelvis: o, neck, head,
    'left.hip': lHip, 'left.knee': left.knee, 'left.ankle': left.ankle,
    'right.hip': rHip, 'right.knee': rightLeg.knee, 'right.ankle': rightLeg.ankle,
    'free.shoulder': freeSh, 'free.elbow': free.elbow, 'free.wrist': free.wrist, 'free.tip': free.tip,
    'cast.shoulder': castSh, 'cast.elbow': cast.elbow, 'cast.wrist': cast.wrist, 'cast.tip': cast.tip,
  };
  return {
    view: 'front', joints, legs: { left, right: rightLeg }, arms: { free, cast }, rigid: [],
    reach: left.reach && rightLeg.reach,
  };
}

function topSkeleton(p: TopPose): Skeleton {
  const o = p.at;
  const lSh: Pt = add(o, [-FRONT.shoulder, 0]);
  const rSh: Pt = add(o, [FRONT.shoulder, 0]);
  const freeSh = p.free.side === 'left' ? lSh : rSh;
  const castSh = p.free.side === 'left' ? rSh : lSh;
  const free = armOf(freeSh, { elbow: p.free.elbow, hand: p.free.hand });
  const side = p.free.side === 'left' ? 1 : -1;
  const cast = armOf(castSh, { elbow: add(castSh, [side * 1.5, 3]), hand: add(o, [-side * 3.5, 6.5]) });
  const joints: Record<string, Pt> = {
    head: add(o, [0, 0.8]), shoulder: o,
    'free.shoulder': freeSh, 'free.elbow': free.elbow, 'free.wrist': free.wrist, 'free.tip': free.tip,
    'cast.shoulder': castSh, 'cast.elbow': cast.elbow, 'cast.wrist': cast.wrist, 'cast.tip': cast.tip,
  };
  return { view: 'top', joints, legs: {}, arms: { free, cast }, rigid: [], reach: true };
}

export function skeleton(p: Pose): Skeleton {
  return p.view === 'side' ? sideSkeleton(p) : p.view === 'front' ? frontSkeleton(p) : topSkeleton(p);
}

// ─────────────────────────────────────────────────────────────────────────────
// Les contours
// ─────────────────────────────────────────────────────────────────────────────

interface Disc {
  c: Pt;
  r: number;
}

/** L'enveloppe convexe d'un nuage de points (chaîne monotone d'Andrew). */
export function hull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const turn = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && turn(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]!;
    while (upper.length >= 2 && turn(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const ring = ({ c, r }: Disc, n = 28): Pt[] =>
  Array.from({ length: n }, (_, i) => add(c, [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]));

/** Le contour d'une suite de disques : un membre, effilé, galbé là où il faut. */
export const blob = (discs: Disc[]): Pt[] => hull(discs.flatMap((d) => ring(d)));

/** Une ellipse en polygone. */
export const ellipse = (c: Pt, rx: number, ry: number, deg = 0, n = 32): Pt[] =>
  Array.from({ length: n }, (_, i) => {
    const t = (2 * Math.PI * i) / n;
    return add(c, rot([rx * Math.cos(t), ry * Math.sin(t)], deg));
  });

/**
 * Une courbe fermée lisse par des points de passage (Catmull-Rom centripète),
 * échantillonnée : un galbe, pas une ligne brisée. Le 21/10, Pierre voulait
 * des schémas « beaucoup plus réalistes » : un membre fait d'enveloppes
 * convexes ne pouvait avoir ni le galbe du mollet, ni le creux du genou, ni la
 * cambrure du dos.
 */
export function smoothClosed(control: Pt[], samples = 5): Pt[] {
  const n = control.length;
  if (n < 3) return control;
  const out: Pt[] = [];
  const at = (i: number) => control[((i % n) + n) % n]!;
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const t01 = Math.sqrt(Math.max(1e-6, dist(p0, p1)));
    const t12 = Math.sqrt(Math.max(1e-6, dist(p1, p2)));
    const t23 = Math.sqrt(Math.max(1e-6, dist(p2, p3)));
    // Tangentes de Catmull-Rom centripète, ramenées au segment p1 → p2.
    const m1 = mul(add(sub(mul(sub(p1, p0), 1 / t01), mul(sub(p2, p0), 1 / (t01 + t12))), mul(sub(p2, p1), 1 / t12)), t12);
    const m2 = mul(add(sub(mul(sub(p2, p1), 1 / t12), mul(sub(p3, p1), 1 / (t12 + t23))), mul(sub(p3, p2), 1 / t23)), t12);
    for (let k = 0; k < samples; k++) {
      const t = k / samples;
      const t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push(add(add(mul(p1, h00), mul(m1, h10)), add(mul(p2, h01), mul(m2, h11))));
    }
  }
  return out;
}

/**
 * Un segment du corps par son profil : ses largeurs devant et derrière l'os,
 * réparties de `a` à `b`. « Devant », c'est le côté vers lequel l'os tourne de
 * 90° — l'avant de la cuisse, le tibia, le biceps. Les bouts s'arrondissent
 * sur le rayon de l'articulation : deux segments voisins s'y recouvrent.
 */
function profile(a: Pt, b: Pt, front: readonly number[], back: readonly number[]): { pts: Pt[]; shade: [Pt, Pt] } {
  const d = unit(sub(b, a));
  const f = rot(d, 90);
  const len = dist(a, b);
  const n = front.length - 1;
  const along = (i: number) => add(a, mul(d, (len * i) / n));
  const frontSide = front.map((w, i) => add(along(i), mul(f, w)));
  const backSide = back.map((w, i) => add(along(i), mul(f, -w))).reverse();
  const rb = (front[n]! + back[n]!) / 2;
  const ra = (front[0]! + back[0]!) / 2;
  const capB = add(add(b, mul(f, (front[n]! - back[n]!) / 2)), mul(d, rb * 0.95));
  const capA = add(add(a, mul(f, (front[0]! - back[0]!) / 2)), mul(d, -ra * 0.95));
  const mid = along(n / 2);
  const wMid = Math.max(...front, ...back);
  return {
    pts: smoothClosed([...frontSide, capB, ...backSide, capA]),
    shade: [add(mid, mul(f, -wMid)), add(mid, mul(f, wMid))],
  };
}

/**
 * Les parties d'un corps : chacune nommée, dans l'ordre où elle se
 * dessine. `tone` dit comment : `far` le côté opposé, `near` le nôtre,
 * `cast` le plâtre, `sling` l'écharpe.
 */
export interface Part {
  name: string;
  tone: 'far' | 'near' | 'cast' | 'cast-far' | 'sling';
  pts: Pt[];
  /**
   * Le modelé : de l'ombre à la lumière, à travers la partie. La lumière vient
   * de devant et d'en haut — l'avant d'un membre est plus clair que son dos.
   */
  shade?: [Pt, Pt];
}

/**
 * La jambe de profil, aux galbes d'une jambe de coureur : le droit fémoral et
 * le vaste devant, les ischio-jambiers derrière ; le tibia presque droit, le
 * mollet haut et plein ; la cheville fine. Largeurs en unités (1,8 cm), de la
 * hanche au genou, puis du genou à la cheville.
 */
const THIGH = { front: [4.7, 5.0, 4.8, 4.2, 3.4, 3.0], back: [5.6, 5.0, 4.5, 3.9, 3.2, 3.0] } as const;
const SHANK = { front: [2.9, 2.6, 2.3, 2.0, 1.7, 1.6], back: [3.0, 4.0, 3.7, 2.7, 1.9, 1.7] } as const;

const leg = (side: string, l: LegPts, tone: Part['tone']): Part[] => {
  const thigh = profile(l.hip, l.knee, THIGH.front, THIGH.back);
  const shank = profile(l.knee, l.ankle, SHANK.front, SHANK.back);
  return [
    { name: `${side}.thigh`, tone, ...thigh },
    { name: `${side}.shank`, tone, ...shank },
    { name: `${side}.foot`, tone, ...shoe(l) },
  ];
};

/**
 * Le pied dans sa chaussure de course : la semelle à plat du talon aux orteils
 * — c'est elle qui touche le sol —, la pointe relevée, le cou-de-pied, le
 * contrefort du talon.
 */
function shoe(l: LegPts): { pts: Pt[]; shade: [Pt, Pt] } {
  const fwd = unit(sub(l.toe, l.heel));
  const up = rot(fwd, 90);
  const on = (p: Pt, f: number, u: number): Pt => add(add(p, mul(fwd, f)), mul(up, u));
  const pts = smoothClosed([
    on(l.heel, -1.1, 1.7),
    on(l.heel, -1.25, 0.6),
    on(l.heel, -0.5, 0.02),
    on(l.heel, 1.5, 0),
    lerp(l.heel, l.ball, 0.55),
    on(l.ball, 0, 0),
    on(l.toe, -0.6, 0.05),
    on(l.toe, 0.5, 0.75),
    on(l.toe, -0.4, 1.7),
    on(lerp(l.ball, l.ankle, 0.45), 0, 1.6),
    on(l.ankle, 1.5, 0.4),
    on(l.ankle, 0.2, 1.7),
    on(l.ankle, -1.9, 0.6),
    on(l.heel, -0.8, 3.0),
  ], 4);
  return { pts, shade: [on(l.heel, 0, 0), on(l.heel, 0, 4)] };
}

const limb = (name: string, a: Pt, b: Pt, ra: number, rb: number, tone: Part['tone'], bulge = 0): Part => ({
  name, tone,
  pts: blob([{ c: a, r: ra }, { c: lerp(a, b, 0.4), r: Math.max(ra, rb) * (1 + bulge) - 0.2 }, { c: b, r: rb }]),
});

/** Le bras : le deltoïde en haut, le biceps devant, le triceps derrière ; l'avant-bras plein près du coude. */
const UPPER_ARM = { front: [3.0, 2.6, 2.4, 2.2, 1.9], back: [3.0, 2.7, 2.5, 2.1, 1.9] } as const;
const FOREARM = { front: [2.0, 2.2, 1.8, 1.5, 1.3], back: [2.0, 2.0, 1.7, 1.4, 1.3] } as const;

const armParts = (side: 'free' | 'cast', a: ArmPts, tone: Part['tone']): Part[] => {
  if (tone === 'cast' || tone === 'cast-far') {
    const knuckles = lerp(a.wrist, a.tip, 0.65);
    return [
      limb(`${side}.upper`, a.shoulder, a.elbow, 2.8, 2.2, tone === 'cast' ? 'near' : 'far'),
      // Le plâtre : du milieu du bras aux phalanges, coude compris.
      { name: `${side}.cast-upper`, tone, pts: blob([{ c: lerp(a.shoulder, a.elbow, 0.45), r: 2.9 }, { c: a.elbow, r: 3.1 }]) },
      { name: `${side}.cast-fore`, tone, pts: blob([{ c: a.elbow, r: 3.1 }, { c: a.wrist, r: 2.6 }, { c: knuckles, r: 2.2 }]) },
    ];
  }
  // Vu de face, raccourci vers nous : le profil n'a plus de sens, l'enveloppe reste.
  if (a.projected) {
    return [
      limb(`${side}.upper`, a.shoulder, a.elbow, 2.8, 2.1, tone, 0.08),
      limb(`${side}.fore`, a.elbow, a.wrist, 2.1, 1.5, tone, 0.08),
      { name: `${side}.hand`, tone, pts: blob([{ c: a.wrist, r: 1.5 }, { c: lerp(a.wrist, a.tip, 0.5), r: 1.8 }, { c: a.tip, r: 1 }]) },
    ];
  }
  return [
    { name: `${side}.upper`, tone, ...profile(a.shoulder, a.elbow, UPPER_ARM.front, UPPER_ARM.back) },
    { name: `${side}.fore`, tone, ...profile(a.elbow, a.wrist, FOREARM.front, FOREARM.back) },
    { name: `${side}.hand`, tone, pts: blob([{ c: a.wrist, r: 1.4 }, { c: lerp(a.wrist, a.tip, 0.5), r: 1.7 }, { c: a.tip, r: 0.95 }]) },
  ];
};

/** L'écharpe : de la nuque au poignet plâtré, le long de l'avant-bras. */
function sling(nape: Pt, a: ArmPts): Part {
  const w = 1.1;
  const along = unit(sub(a.wrist, nape));
  const n = rot(along, 90);
  return {
    name: 'sling', tone: 'sling',
    pts: hull([add(nape, mul(n, w)), add(nape, mul(n, -w)), add(a.wrist, mul(n, w)), add(a.wrist, mul(n, -w))]),
  };
}

function sideParts(k: Skeleton, p: SidePose): Part[] {
  const j = k.joints;
  const hip = j.hip!;
  const shoulder = j.shoulder!;
  const head = j.head!;
  const up = unit(sub(shoulder, hip));
  const front = rot(up, -90);
  const at = (h: number, f: number): Pt => add(add(hip, mul(up, h)), mul(front, f));
  // Le buste de profil, des fessiers aux épaules : le ventre plat, la poitrine,
  // la cambrure des lombaires, le dos rond des omoplates. Les appuis — le sacrum
  // couché sur le dos, la poitrine face au sol — gardent les mesures d'avant.
  const trunk: Part = {
    name: 'trunk', tone: 'near',
    pts: smoothClosed([
      at(-5.6, 1.2),
      at(-3.2, 4.4),
      at(1.5, 5.2),
      at(7.5, 5.0),
      at(12.5, 5.0),
      at(17.5, 5.9),
      at(21.0, 6.1),
      at(25.0, 5.0),
      at(28.6, 3.4),
      at(31.4, 0.8),
      at(32.4, -2.0),
      at(31.5, -4.7),
      at(28.8, -6.2),
      at(25.0, -6.4),
      at(18.5, -6.3),
      at(13.0, -5.2),
      at(8.5, -4.7),
      at(4.0, -5.6),
      at(0.4, -7.0),
      at(-3.6, -6.2),
    ]),
    shade: [at(14, -6.5), at(14, 6.5)],
  };
  const hu = unit(sub(head, shoulder));
  const face = rot(hu, -90);
  // La tête de profil : le crâne, le front, le nez, les lèvres, le menton, la
  // mâchoire — un visage, pas un œuf. Repère : `face` devant, `hu` en haut.
  const hp = (f: number, u: number): Pt => add(add(head, mul(face, f)), mul(hu, u));
  const headPart: Part = {
    name: 'head', tone: 'near',
    pts: smoothClosed([
      hp(-5.7, 0.6), hp(-4.6, 4.2), hp(-1.4, 6.3), hp(2.6, 5.6), hp(4.9, 3.0), hp(5.4, 1.3),
      hp(6.6, -0.6), hp(5.6, -1.4), hp(5.9, -2.4), hp(5.4, -3.4), hp(5.1, -4.6), hp(3.0, -5.6),
      hp(0.6, -4.8), hp(-2.4, -4.6), hp(-5.0, -2.6),
    ], 4),
    shade: [hp(-6, 0), hp(6, 0)],
  };
  // Un cou d'homme : une douzaine de centimètres de large, pas une tige.
  const neck: Part = { name: 'neck', tone: 'near', pts: blob([{ c: at(SEG.trunk + 0.5, -0.4), r: 3.4 }, { c: lerp(at(SEG.trunk + 0.5, 0.3), head, 0.7), r: 3.0 }]) };
  const freeSide = p.freeSide ?? 'near';
  const castOver = typeof p.cast === 'object' && p.cast.over === true;
  const castTone: Part['tone'] = freeSide === 'near' ? 'cast-far' : 'cast';
  const freeParts = armParts('free', k.arms.free, freeSide === 'near' ? 'near' : 'far');
  const castParts = armParts('cast', k.arms.cast, castOver ? 'cast' : castTone);
  const strap = castOver ? [] : [sling(add(at(SEG.trunk + 2.5, -1.5), mul(up, 0)), k.arms.cast)];
  const far = leg('far', k.legs.far!, 'far');
  const near = leg('near', k.legs.near!, 'near');
  const behind = [...(freeSide === 'far' ? freeParts : castOver ? [] : castParts)];
  const inFront = [...(freeSide === 'near' ? freeParts : castOver ? [] : castParts)];
  return [
    ...far,
    ...behind,
    trunk,
    neck,
    headPart,
    ...near,
    ...(castOver ? castParts : []),
    ...strap,
    ...inFront,
  ];
}

function frontParts(k: Skeleton, p: FrontPose): Part[] {
  const j = k.joints;
  const o = j.pelvis!;
  const turn = p.turn ?? 0;
  const up = rot(dir(180 + (p.tilt ?? 0)), turn);
  const right = rot(up, -90);
  const at = (h: number, s: number): Pt => add(add(o, mul(up, h)), mul(right, s));
  // De face : les hanches, la taille marquée, le grand dorsal, les deltoïdes.
  const half = (s: 1 | -1): Pt[] => [
    at(-3.5, s * 9.6), at(1.5, s * 10.3), at(7.0, s * 8.6), at(11.5, s * 8.3), at(17.0, s * 9.6),
    at(21.5, s * 10.4), at(25.0, s * 12.0), at(28.4, s * 11.8), at(30.2, s * 8.6), at(30.2, s * 3.4),
  ];
  const trunk: Part = {
    name: 'trunk', tone: 'near',
    pts: smoothClosed([...half(1), ...half(-1).reverse(), at(-5.2, -3.5), at(-5.6, 0), at(-5.2, 3.5)]),
    shade: [at(14, -10), at(14, 10)],
  };
  const head = j.head!;
  const headPart: Part = { name: 'head', tone: 'near', pts: ellipse(head, 4.7, 6.1, turn + (p.tilt ?? 0)) };
  const neck: Part = { name: 'neck', tone: 'near', pts: blob([{ c: at(SEG.trunk - 1, 0), r: 3.6 }, { c: lerp(at(SEG.trunk - 1, 0), head, 0.7), r: 3.2 }]) };
  const legParts = (side: 'left' | 'right'): Part[] => {
    const l = k.legs[side]!;
    const out = side === 'left' ? -1 : 1;
    return [
      // De face, le vaste externe galbe le dehors de la cuisse, les adducteurs son dedans ;
      // le mollet déborde des deux côtés, plus au dedans.
      {
        name: `${side}.thigh`, tone: 'near',
        ...profile(l.hip, l.knee, out === 1 ? [5.0, 4.7, 4.3, 3.7, 3.0] : [4.6, 4.6, 3.9, 3.4, 3.0], out === 1 ? [4.6, 4.6, 3.9, 3.4, 3.0] : [5.0, 4.7, 4.3, 3.7, 3.0]),
      },
      {
        name: `${side}.shank`, tone: 'near',
        ...profile(l.knee, l.ankle, out === 1 ? [3.0, 3.1, 2.5, 1.9, 1.7] : [3.0, 3.4, 2.7, 1.9, 1.7], out === 1 ? [3.0, 3.4, 2.7, 1.9, 1.7] : [3.0, 3.1, 2.5, 1.9, 1.7]),
      },
      { name: `${side}.foot`, tone: 'near', pts: ellipse(add(l.ankle, rot([out * 0.8, -1.9], turn)), 2.7, 2, turn) },
    ];
  };
  const free = armParts('free', k.arms.free, 'near');
  const cast = armParts('cast', k.arms.cast, 'cast');
  const nape = at(SEG.trunk - 0.5, p.free.side === 'left' ? -2.5 : 2.5);
  // L'écharpe seulement quand le bras y est : posé ailleurs, il n'en porte pas.
  const arms = [...cast, ...(p.cast ? [] : [sling(nape, k.arms.cast)]), ...free];
  // De dos, les bras partent devant le corps : le buste les cache, sauf ce qui dépasse.
  return p.back
    ? [...legParts('left'), ...legParts('right'), ...arms, trunk, neck, headPart]
    : [...legParts('left'), ...legParts('right'), trunk, neck, headPart, ...arms];
}

function topParts(k: Skeleton, p: TopPose): Part[] {
  const o = p.at;
  const feet: Part[] = [-5.5, 5.5].map((x, i) => ({
    name: i === 0 ? 'left.foot' : 'right.foot', tone: 'far' as const,
    pts: blob([{ c: add(o, [x, -2]), r: 2.2 }, { c: add(o, [x * 1.08, 9.5]), r: 2 }]),
  }));
  const body: Part = {
    name: 'trunk', tone: 'near',
    pts: blob([{ c: add(o, [-FRONT.shoulder, 0]), r: 4.2 }, { c: add(o, [FRONT.shoulder, 0]), r: 4.2 }, { c: add(o, [0, -1.5]), r: 5.5 }]),
  };
  const head: Part = { name: 'head', tone: 'near', pts: hull([...ring({ c: k.joints.head!, r: 4.6 }), add(k.joints.head!, [0, 6])]) };
  return [...feet, body, ...armParts('cast', k.arms.cast, 'cast'), head, ...armParts('free', k.arms.free, 'near')];
}

export function parts(p: Pose): { skeleton: Skeleton; parts: Part[] } {
  const k = skeleton(p);
  const list = p.view === 'side' ? sideParts(k, p) : p.view === 'front' ? frontParts(k, p) : topParts(k, p);
  return { skeleton: k, parts: list };
}

// ─────────────────────────────────────────────────────────────────────────────
// Les muscles
// ─────────────────────────────────────────────────────────────────────────────

export type MuscleName =
  | 'quads' | 'hamstrings' | 'glutes' | 'gluteMed' | 'calves' | 'soleus' | 'tibialis' | 'hipFlexors'
  | 'adductors' | 'abs' | 'obliques' | 'back' | 'chest' | 'biceps' | 'triceps' | 'forearm' | 'shoulder' | 'diaphragm';

/** Un muscle qui travaille, du côté dit : la jambe de notre côté par défaut. */
export interface Muscle {
  muscle: MuscleName;
  side?: 'near' | 'far' | 'left' | 'right';
}

/**
 * La tache d'un muscle : une ellipse posée sur la partie du corps qui le porte,
 * et découpée par son contour — elle n'en déborde jamais.
 */
export function muscleShape(m: Muscle, k: Skeleton, list: Part[]): { clip: string; pts: Pt[] } | null {
  const side = m.side ?? (k.view === 'side' ? 'near' : 'right');
  const j = k.joints;
  const segment = (a: Pt, b: Pt, t: number, off: number, rx: number, ry: number, frontSign: 1 | -1 = 1) => {
    const d = unit(sub(b, a));
    const f = rot(d, 90 * frontSign);
    const c = add(lerp(a, b, t), mul(f, off));
    return ellipse(c, rx, ry, Math.atan2(d[1], d[0]) / RAD);
  };
  const has = (name: string) => list.some((p) => p.name === name);
  if (k.view === 'side') {
    const l = k.legs[side];
    const hip = j.hip!;
    const shoulder = j.shoulder!;
    const up = unit(sub(shoulder, hip));
    const front = rot(up, -90);
    const trunkAt = (h: number, f: number, rx: number, ry: number) =>
      ellipse(add(add(hip, mul(up, h)), mul(front, f)), rx, ry, Math.atan2(up[1], up[0]) / RAD);
    switch (m.muscle) {
      case 'quads': return l ? { clip: `${side}.thigh`, pts: segment(l.hip, l.knee, 0.55, 2.4, 9.5, 2.6) } : null;
      case 'hamstrings': return l ? { clip: `${side}.thigh`, pts: segment(l.hip, l.knee, 0.58, -2.5, 9.5, 2.6) } : null;
      case 'hipFlexors': return l ? { clip: `${side}.thigh`, pts: segment(l.hip, l.knee, 0.12, 2.6, 4.5, 2.4) } : null;
      case 'calves': return l ? { clip: `${side}.shank`, pts: segment(l.knee, l.ankle, 0.3, -2.1, 7, 2.5) } : null;
      case 'soleus': return l ? { clip: `${side}.shank`, pts: segment(l.knee, l.ankle, 0.58, -1.5, 6.5, 2) } : null;
      case 'tibialis': return l ? { clip: `${side}.shank`, pts: segment(l.knee, l.ankle, 0.38, 2, 8, 1.7) } : null;
      case 'adductors': return l ? { clip: `${side}.thigh`, pts: segment(l.hip, l.knee, 0.42, -0.4, 8.5, 2.2) } : null;
      case 'glutes': return { clip: 'trunk', pts: trunkAt(-0.4, -5.2, 5.5, 3.6) };
      case 'abs': return { clip: 'trunk', pts: trunkAt(11, 4.6, 8, 2.4) };
      case 'obliques': return { clip: 'trunk', pts: trunkAt(11, 0.5, 6.5, 3.2) };
      case 'back': return { clip: 'trunk', pts: trunkAt(19.5, -4.6, 7.5, 2.6) };
      case 'chest': return { clip: 'trunk', pts: trunkAt(21.5, 5.2, 5.5, 2.4) };
      case 'diaphragm': return { clip: 'trunk', pts: trunkAt(14.5, 3.2, 5.5, 3.4) };
      case 'biceps': return has('free.upper') ? { clip: 'free.upper', pts: segment(k.arms.free.shoulder, k.arms.free.elbow, 0.55, 1.6, 6.5, 1.9, -1) } : null;
      case 'triceps': return has('free.upper') ? { clip: 'free.upper', pts: segment(k.arms.free.shoulder, k.arms.free.elbow, 0.55, -1.6, 6.5, 1.9, -1) } : null;
      case 'forearm': return has('free.fore') ? { clip: 'free.fore', pts: segment(k.arms.free.elbow, k.arms.free.wrist, 0.35, 0, 5.5, 1.8) } : null;
      case 'shoulder': return { clip: 'free.upper', pts: ellipse(k.arms.free.shoulder, 3.2, 3.2) };
      default: return null;
    }
  }
  if (k.view === 'front') {
    const l = k.legs[side];
    const out = side === 'left' ? -1 : 1;
    switch (m.muscle) {
      case 'gluteMed': return l ? { clip: 'trunk', pts: ellipse(add(l.hip, [out * 4.6, 2.2]), 3.4, 4.2) } : null;
      case 'adductors': return l ? { clip: `${side}.thigh`, pts: segment(l.hip, l.knee, 0.4, -out * 2.6, 7, 2.2) } : null;
      case 'quads': return l ? { clip: `${side}.thigh`, pts: segment(l.hip, l.knee, 0.55, 0, 8, 3) } : null;
      case 'obliques': return { clip: 'trunk', pts: ellipse(add(j.pelvis!, [out * 6, 10]), 3, 6.5) };
      case 'abs': return { clip: 'trunk', pts: ellipse(add(j.pelvis!, [0, 10]), 4.5, 7) };
      default: return null;
    }
  }
  switch (m.muscle) {
    case 'obliques': case 'abs': return { clip: 'trunk', pts: ellipse(j.shoulder!, 7, 4) };
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Le décor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le décor, aux mesures d'un appartement : une chaise de 46 cm, un canapé de
 * 42, une marche de 17. `face` dit de quel côté s'ouvre le meuble (+1 : vers
 * les x croissants).
 */
export type Prop =
  | { kind: 'floor' }
  | { kind: 'wall'; x: number; face: 1 | -1 }
  | { kind: 'backdrop'; from: number; to: number; top: number }
  | { kind: 'chair'; x: number; face: 1 | -1; back?: boolean }
  | { kind: 'sofa'; x: number; face: 1 | -1 }
  /** Le tabouret de Pierre : 40 cm, en dur. */
  | { kind: 'stool'; x: number; face: 1 | -1 }
  | { kind: 'box'; x: number; h: number; depth: number; face: 1 | -1 }
  | { kind: 'stairs'; x: number; n: number; rail?: boolean }
  | { kind: 'jamb'; x: number }
  /** Une porte vue par la tranche, l'accroche à la hauteur `anchor` ; `face` : le côté où l'on se tient (−1 par défaut, à sa gauche). */
  | { kind: 'door'; x: number; anchor: number; face?: 1 | -1 }
  | { kind: 'mat'; from: number; to: number }
  | { kind: 'towel'; x: number; w: number }
  | { kind: 'bench'; from: number; to: number; h: number }
  /** Une machine ou un objet dessiné point par point : `pad` rembourré, `metal` le bâti. */
  | { kind: 'shape'; pts: Pt[]; closed?: boolean; tone?: 'pad' | 'metal' | 'line' }
  | { kind: 'circle'; c: Pt; r: number; tone?: 'pad' | 'metal' | 'line' }
  /** Un poids tenu : haltère, ou disque. */
  | { kind: 'dumbbell'; at: Pt; deg?: number };

/** Les mesures du décor, en unités (1 unité ≈ 1,8 cm). */
export const FURNITURE = {
  chair: { seat: 25.5, depth: 22, back: 50 },
  sofa: { seat: 23, depth: 30, back: 46, arm: 33 },
  /** Le tabouret de Pierre : 40 cm de haut, une assise de 30 cm. */
  stool: { seat: 22.2, depth: 17 },
  /** Une marche d'escalier : 17 cm de haut, 28 de giron. */
  stair: { rise: 9.4, run: 15.5 },
  mat: 0.6,
} as const;

/** Les surfaces où le corps s'appuie, pour vérifier qu'il y est. */
export function surfaceHeight(prop: Prop, x: number): number | null {
  switch (prop.kind) {
    case 'floor':
      return 0;
    case 'chair': {
      const [a, b] = prop.face === 1 ? [prop.x - FURNITURE.chair.depth, prop.x] : [prop.x, prop.x + FURNITURE.chair.depth];
      return x >= a - 0.5 && x <= b + 0.5 ? FURNITURE.chair.seat : null;
    }
    case 'sofa': {
      const [a, b] = prop.face === 1 ? [prop.x - FURNITURE.sofa.depth, prop.x] : [prop.x, prop.x + FURNITURE.sofa.depth];
      return x >= a - 0.5 && x <= b + 0.5 ? FURNITURE.sofa.seat : null;
    }
    case 'stool': {
      const [a, b] = prop.face === 1 ? [prop.x - FURNITURE.stool.depth, prop.x] : [prop.x, prop.x + FURNITURE.stool.depth];
      return x >= a - 0.5 && x <= b + 0.5 ? FURNITURE.stool.seat : null;
    }
    case 'box': {
      const [a, b] = prop.face === 1 ? [prop.x - prop.depth, prop.x] : [prop.x, prop.x + prop.depth];
      return x >= a - 0.5 && x <= b + 0.5 ? prop.h : null;
    }
    case 'stairs': {
      const i = Math.floor((x - prop.x) / FURNITURE.stair.run);
      return x < prop.x ? null : Math.min(prop.n, i + 1) * FURNITURE.stair.rise;
    }
    case 'mat':
      return x >= prop.from && x <= prop.to ? FURNITURE.mat : null;
    case 'towel':
      return Math.abs(x - prop.x) <= prop.w / 2 ? 0.8 : null;
    case 'bench':
      return x >= prop.from && x <= prop.to ? prop.h : null;
    default:
      return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ce qui se lit sur le schéma
// ─────────────────────────────────────────────────────────────────────────────

/** Un point : une articulation nommée (`near.knee`, `free.wrist`…) ou des coordonnées. */
export type Ref = Pt | string;

/** Un angle mesuré sur le dessin : au sommet `at`, entre `a` et `b`. Sans `label`, il dit ses degrés. */
export interface AngleMark { at: Ref; a: Ref; b: Ref; label?: string; r?: number }
/** Une consigne écrite à côté du point qu'elle désigne. */
export interface Note { text: string; at: Ref; dx: number; dy: number }
/** Un alignement : une ligne fine entre deux points. */
export interface Guide { from: Ref; to: Ref }
/**
 * Un mouvement. Écrit avec une articulation, il va de sa place dans la position
 * de départ (en pointillé) à sa place dans la position dessinée ; `bend`
 * l'écarte du corps. `label` : son tempo.
 */
export interface Motion { joint?: string; from?: Ref; to?: Ref; bend?: number; label?: string }
/** Un élastique — long (accroché à une porte, sous un pied), mini-bande —, ou une sangle. */
export interface Band {
  from: Ref;
  to: Ref;
  kind: 'long' | 'mini' | 'strap';
  /** L'élastique passe derrière le corps (dans le dos, sur le côté) : il se dessine avant lui. */
  behind?: boolean;
}
/** Un appui à vérifier : le point, ou le bas d'une partie, à la hauteur dite. */
export interface Contact { ref?: string; part?: string; y: number; tol?: number }

/** Une vignette : une position, et celle d'où l'on part en pointillé. */
export interface Panel {
  /** Ce que montre la position dessinée, et celle du pointillé. */
  label: string;
  ghostLabel?: string;
  props: Prop[];
  pose: Pose;
  ghost?: Pose;
  muscles?: Muscle[];
  bands?: Band[];
  ghostBands?: Band[];
  notes?: Note[];
  angles?: AngleMark[];
  guides?: Guide[];
  motions?: Motion[];
  contacts?: Contact[];
  ghostContacts?: Contact[];
  /** Ce que tient la main valide, dans les deux positions : un haltère, ou la poignée du kit. */
  hold?: 'dumbbell' | 'handle';
  /** La charge que porte le corps : le sac sur le dos, posé sur les genoux, ou tenu à la main. */
  carry?: 'dos' | 'genoux' | 'main';
}

export interface FigureSpec {
  panels: Panel[];
}

/**
 * Le crochet de l'accroche de porte : le cylindre est coincé derrière la porte
 * (en `x`), la sangle passe dessous et son crochet pend de notre côté. C'est là
 * que s'accroche l'élastique.
 */
export const doorHook = (doorX: number, anchor: number, face: 1 | -1 = -1): Pt =>
  face === -1 ? [doorX - 3.4, anchor] : [doorX + 2.2 + 3.4, anchor];

/** Un point nommé, lu sur un squelette. */
export function resolve(ref: Ref, k: Skeleton): Pt {
  if (typeof ref !== 'string') return ref;
  const p = k.joints[ref];
  if (!p) throw new Error(`Point inconnu sur le schéma : ${ref}`);
  return p;
}

/**
 * Le sac chargé, posé là où la fiche le dit : sur le dos, derrière le buste ;
 * sur les genoux, sur la cuisse de notre côté ; à la main, pendu sous la main
 * valide. `front` : il se dessine devant le corps — sur les genoux, à la main.
 */
export function carryShape(carry: NonNullable<Panel['carry']>, k: Skeleton): { pts: Pt[]; front: boolean } | null {
  const j = k.joints;
  if (carry === 'main') {
    const tip = j['free.tip'];
    if (!tip) return null;
    return { pts: blob([{ c: add(tip, [0, -3.5]), r: 3.8 }, { c: add(tip, [0, -9]), r: 4.4 }]), front: true };
  }
  if (k.view !== 'side') return null;
  if (carry === 'dos') {
    const hip = j.hip!;
    const up = unit(sub(j.shoulder!, hip));
    const front = rot(up, -90);
    const at = (h: number, f: number): Pt => add(add(hip, mul(up, h)), mul(front, f));
    return { pts: blob([{ c: at(9, -9), r: 3.6 }, { c: at(22.5, -9.2), r: 3.9 }]), front: false };
  }
  const hip = j['near.hip']!;
  const knee = j['near.knee']!;
  const d = unit(sub(knee, hip));
  const n = rot(d, 90);
  const c = add(lerp(hip, knee, 0.62), mul(n, 6.4));
  return { pts: blob([{ c: add(c, mul(d, -3.4)), r: 3.5 }, { c: add(c, mul(d, 3.4)), r: 3.5 }]), front: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Le mouvement
// ─────────────────────────────────────────────────────────────────────────────

/** Un angle vers un autre, par le plus court chemin. */
const lerpAngle = (a: number, b: number, t: number): number => a + ((((b - a) % 360) + 540) % 360 - 180) * t;
const lerpNum = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Les angles d'une jambe résolue : ce qui la fait tourner autour de la hanche et du genou. */
const legAngles = (l: LegPts): { thigh: number; shank: number; sole: number } => ({
  thigh: thetaOf(sub(l.knee, l.hip)), shank: thetaOf(sub(l.ankle, l.knee)), sole: l.sole,
});

/**
 * Une jambe entre deux positions. Un pied qui reste posé se tient par la
 * cheville — le genou se résout autour, le pied ne glisse pas. Une jambe qui
 * balance tourne par ses angles : par la cheville, elle irait en ligne droite
 * et plierait le genou en chemin.
 */
function legBetween(a: LegSpec, la: LegPts, b: LegSpec, lb: LegPts, t: number): LegSpec {
  if ('ankle' in a && 'ankle' in b) {
    return { ankle: lerp(a.ankle, b.ankle, t), sole: lerpNum(a.sole ?? 0, b.sole ?? 0, t) };
  }
  if (dist(la.ankle, lb.ankle) < 4) {
    return { ankle: lerp(la.ankle, lb.ankle, t), sole: lerpNum(la.sole, lb.sole, t) };
  }
  const x = 'thigh' in a ? { thigh: a.thigh, shank: a.shank, sole: a.sole ?? 0 } : legAngles(la);
  const y = 'thigh' in b ? { thigh: b.thigh, shank: b.shank, sole: b.sole ?? 0 } : legAngles(lb);
  return { thigh: lerpAngle(x.thigh, y.thigh, t), shank: lerpAngle(x.shank, y.shank, t), sole: lerpNum(x.sole, y.sole, t) };
}

/** Un bras entre deux positions : par ses angles s'ils sont dits des deux côtés, sinon par la main. */
function armBetween(a: ArmSpec, pa: ArmPts, b: ArmSpec, pb: ArmPts, t: number): ArmSpec {
  const fingers = (s: ArmSpec) => ('fingers' in s ? s.fingers : undefined);
  const fa = fingers(a);
  const fb = fingers(b);
  const f = fa != null && fb != null ? lerpAngle(fa, fb, t) : (t < 0.5 ? fa : fb);
  if ('upper' in a && 'upper' in b) return { upper: lerpAngle(a.upper, b.upper, t), fore: lerpAngle(a.fore, b.fore, t) };
  if (pa.projected || pb.projected) {
    return { elbow: lerp(pa.elbow, pb.elbow, t), hand: lerp(pa.wrist, pb.wrist, t), ...(f != null ? { fingers: f } : {}) };
  }
  return { hand: lerp(pa.wrist, pb.wrist, t), ...(f != null ? { fingers: f } : {}) };
}

/**
 * La position à l'instant `t` d'un mouvement, de `a` (0) à `b` (1).
 *
 * Le 14/10, Pierre : « quitte à permettre au système d'être un petit peu
 * animé, d'être en mouvement ». Le schéma passe de la position de départ à la
 * position dessinée, segment par segment : un corps de 100 unités qui se plie,
 * pas deux images qui se fondent. Les longueurs restent celles de Winter à
 * chaque instant (les tests le vérifient). Deux vues différentes ne se
 * mélangent pas : la seconde remplace la première à mi-chemin.
 */
export function between(a: Pose, b: Pose, t: number): Pose {
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (a.view === 'side' && b.view === 'side') {
    const ka = skeleton(a);
    const kb = skeleton(b);
    const castOf = (p: SidePose) => (typeof p.cast === 'object' ? p.cast : null);
    const ca = castOf(a);
    const cb = castOf(b);
    return {
      ...b,
      hip: lerp(a.hip, b.hip, t),
      lean: lerpAngle(a.lean, b.lean, t),
      nod: lerpNum(a.nod ?? 0, b.nod ?? 0, t),
      near: legBetween(a.near, ka.legs.near!, b.near, kb.legs.near!, t),
      far: legBetween(a.far, ka.legs.far!, b.far, kb.legs.far!, t),
      free: armBetween(a.free, ka.arms.free, b.free, kb.arms.free, t),
      cast: ca && cb ? { ...armBetween(ca, ka.arms.cast, cb, kb.arms.cast, t), ...(cb.over ? { over: true } : {}) } : (t < 0.5 ? a.cast : b.cast),
    };
  }
  if (a.view === 'front' && b.view === 'front') {
    return {
      ...b,
      pelvis: lerp(a.pelvis, b.pelvis, t),
      tilt: lerpNum(a.tilt ?? 0, b.tilt ?? 0, t),
      turn: lerpAngle(a.turn ?? 0, b.turn ?? 0, t),
      left: { ankle: lerp(a.left.ankle, b.left.ankle, t) },
      right: { ankle: lerp(a.right.ankle, b.right.ankle, t) },
      free: { side: b.free.side, elbow: lerp(a.free.elbow, b.free.elbow, t), hand: lerp(a.free.hand, b.free.hand, t) },
      ...(a.cast && b.cast ? { cast: { elbow: lerp(a.cast.elbow, b.cast.elbow, t), hand: lerp(a.cast.hand, b.cast.hand, t) } } : {}),
    };
  }
  if (a.view === 'top' && b.view === 'top') {
    return {
      ...b,
      at: lerp(a.at, b.at, t),
      free: { side: b.free.side, elbow: lerp(a.free.elbow, b.free.elbow, t), hand: lerp(a.free.hand, b.free.hand, t) },
    };
  }
  return t < 0.5 ? a : b;
}
