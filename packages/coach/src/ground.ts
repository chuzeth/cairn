import type { GroundKind, GroundRun, StretchGround } from '@cairn/core';
import { streetKey, streetName } from '@cairn/core';

/**
 * Le sol d'une montée, lu sur OpenStreetMap le long de la trace de l'athlète.
 *
 * Une trace dit où l'athlète est passé, jamais sur quoi : la descente du 24/09
 * suivait sa montée habituelle, et 260 de ses mètres sont les 562 marches de la
 * montée Nicolas de Lange. Ce module cale la trace sur les voies
 * d'OpenStreetMap et en tire, pour n'importe quel tronçon de la montée, ce qu'on
 * a sous les pieds, les voies dans l'ordre où on les court, et un tracé qu'on
 * peut dessiner.
 *
 * Tout ici est pur : les voies entrent, lues ailleurs (`geo.ts`) ; rien ne sort
 * vers le réseau.
 */

/** Une voie OpenStreetMap, réduite à ce que le sol en dit. */
export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  /** Ses nœuds dans l'ordre : latitude, longitude. */
  geometry: [number, number][];
}

/** Ce que le calage a besoin d'un point du profil d'une montée. */
export interface TrackPoint {
  /** Distance depuis le pied, m. */
  d: number;
  at: [number, number] | null;
}

/** Une trace calée sur les voies : pour chaque point du profil, la voie suivie. */
export interface MatchedTrack {
  ways: OsmWay[];
  /** Indice de la voie de chaque point dans `ways`, -1 quand aucune n'est à portée. */
  way: number[];
  /** Le nom à dire en chaque point : celui de sa voie, ou de la rue que longe un trottoir sans nom. */
  street: (string | null)[];
  /** Distance depuis le pied de chaque point, m — celle du profil. */
  d: number[];
  /** Quand les voies ont été lues sur OpenStreetMap, ISO. */
  readAt: string;
}

/** L'erreur d'un GPS de montre dans une rue étroite, m : c'est l'échelle du coût de distance. */
const SIGMA_M = 8;
/** Au-delà, une voie n'est pas candidate : le point est hors de toute voie connue. */
const REACH_M = 30;
/** Poids d'une voie qui croise la trace au lieu de la suivre — l'escalier qui débouche sur la rue. */
const HEADING_WEIGHT = 1.5;
/**
 * Ce que coûte de changer de voie. Un carrefour pose un point à deux mètres
 * d'un escalier perpendiculaire : sans ce coût, la trace y ferait un crochet
 * d'un point, et la montée passerait pour une montée à marches.
 */
const SWITCH_COST = 3;
/** Le coût d'un point hors de toute voie : celui d'une voie à la limite de portée. */
const OFF_COST = 0.5 * (REACH_M / SIGMA_M) ** 2;
/** Un trottoir prend le nom de la rue qu'il longe à cette distance au plus, m. */
const NAME_REACH_M = 20;

/** Ce qui n'est pas une voie qu'on court. */
const NOT_RUN = new Set(['platform', 'corridor', 'elevator', 'proposed', 'construction', 'bus_stop', 'razed', 'abandoned']);

// ─────────────────────────────────────────────────────────────────────────────
// Géométrie plane locale
// ─────────────────────────────────────────────────────────────────────────────

interface Plane {
  x: (p: readonly [number, number]) => [number, number];
}

/** Une projection équirectangulaire autour d'une latitude : au mètre près sur quelques kilomètres. */
function planeAt(lat: number, lng: number): Plane {
  const ky = 110_574;
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  return { x: (p) => [(p[1] - lng) * kx, (p[0] - lat) * ky] };
}

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** Distance d'un point à un segment, et direction du segment. */
function toSegment(px: number, py: number, s: Seg): { dist: number; dx: number; dy: number } {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / len2));
  return { dist: Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy)), dx, dy };
}

/** Un point dans un polygone fermé — une place piétonne tracée comme une aire. */
function inside(px: number, py: number, ring: readonly [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const isArea = (w: OsmWay) => {
  const g = w.geometry;
  const closed = g.length > 3 && g[0]![0] === g[g.length - 1]![0] && g[0]![1] === g[g.length - 1]![1];
  return closed && (w.tags.area === 'yes' || w.tags.highway === 'pedestrian');
};

// ─────────────────────────────────────────────────────────────────────────────
// Calage
// ─────────────────────────────────────────────────────────────────────────────

interface Candidate {
  way: number;
  cost: number;
  dist: number;
}

/**
 * Cale une trace sur les voies qui l'entourent.
 *
 * Chaque point choisit sa voie par ce qu'elle a de proche et d'aligné avec la
 * trace ; la suite des choix est celle qui coûte le moins, changer de voie
 * coûtant `SWITCH_COST` (Viterbi). Une voie qui croise la trace dans un
 * carrefour ne l'emporte donc pas sur celle qu'on suit, tandis qu'un escalier
 * qu'on suit sur deux cents mètres ne peut pas passer pour autre chose.
 */
export function matchTrack(profile: readonly TrackPoint[], ways: readonly OsmWay[], readAt: string): MatchedTrack {
  const run = ways.filter((w) => w.tags.highway && !NOT_RUN.has(w.tags.highway) && w.geometry.length >= 2);
  const located = profile.filter((p) => p.at != null);
  const d = profile.map((p) => p.d);
  if (located.length === 0 || run.length === 0) {
    return { ways: run, way: profile.map(() => -1), street: profile.map(() => null), d, readAt };
  }
  const lat0 = located.reduce((s, p) => s + p.at![0], 0) / located.length;
  const lng0 = located.reduce((s, p) => s + p.at![1], 0) / located.length;
  const plane = planeAt(lat0, lng0);

  const shapes = run.map((w) => {
    const pts = w.geometry.map((g) => plane.x(g));
    const segs: Seg[] = [];
    for (let i = 1; i < pts.length; i++) {
      segs.push({ ax: pts[i - 1]![0], ay: pts[i - 1]![1], bx: pts[i]![0], by: pts[i]![1] });
    }
    return { segs, ring: isArea(w) ? pts : null };
  });
  const xy = profile.map((p) => (p.at ? plane.x(p.at) : null));

  // La direction de la trace en un point, lue sur ses voisins à dix mètres.
  const heading = (i: number): [number, number] | null => {
    let a = i;
    let b = i;
    while (a > 0 && d[i]! - d[a]! < 10 && xy[a - 1]) a--;
    while (b < profile.length - 1 && d[b]! - d[i]! < 10 && xy[b + 1]) b++;
    const pa = xy[a];
    const pb = xy[b];
    if (!pa || !pb) return null;
    const hx = pb[0] - pa[0];
    const hy = pb[1] - pa[1];
    const n = Math.hypot(hx, hy);
    return n < 1 ? null : [hx / n, hy / n];
  };

  const candidates: Candidate[][] = profile.map((_, i) => {
    const p = xy[i];
    const off: Candidate = { way: -1, cost: OFF_COST, dist: Infinity };
    if (!p) return [off];
    const h = heading(i);
    const out: Candidate[] = [off];
    shapes.forEach((s, k) => {
      if (s.ring && inside(p[0], p[1], s.ring)) {
        out.push({ way: k, cost: 0, dist: 0 });
        return;
      }
      let best: { dist: number; dx: number; dy: number } | null = null;
      for (const seg of s.segs) {
        const r = toSegment(p[0], p[1], seg);
        if (!best || r.dist < best.dist) best = r;
      }
      if (!best || best.dist > REACH_M) return;
      let misalign = 0;
      const n = Math.hypot(best.dx, best.dy);
      if (h && n > 0 && !s.ring) misalign = 1 - Math.abs((h[0] * best.dx + h[1] * best.dy) / n);
      out.push({ way: k, cost: 0.5 * (best.dist / SIGMA_M) ** 2 + HEADING_WEIGHT * misalign, dist: best.dist });
    });
    return out;
  });

  // Viterbi : le chemin de voies le moins coûteux.
  const cost: number[][] = [];
  const from: number[][] = [];
  candidates.forEach((cands, i) => {
    cost[i] = [];
    from[i] = [];
    cands.forEach((c, k) => {
      if (i === 0) {
        cost[i]![k] = c.cost;
        from[i]![k] = -1;
        return;
      }
      let best = Infinity;
      let arg = 0;
      candidates[i - 1]!.forEach((prev, j) => {
        const v = cost[i - 1]![j]! + (prev.way === c.way ? 0 : SWITCH_COST);
        if (v < best) {
          best = v;
          arg = j;
        }
      });
      cost[i]![k] = best + c.cost;
      from[i]![k] = arg;
    });
  });
  const way = new Array<number>(profile.length).fill(-1);
  const last = cost[profile.length - 1]!;
  let k = last.indexOf(Math.min(...last));
  for (let i = profile.length - 1; i >= 0; i--) {
    way[i] = candidates[i]![k]!.way;
    k = from[i]![k]!;
  }

  const street = way.map((w, i) => (w < 0 ? null : nameAt(i, w)));
  return { ways: run, way, street, d, readAt };

  /** Le nom d'une voie ; pour un trottoir ou une allée sans nom, celui de la voie nommée qu'il longe. */
  function nameAt(i: number, w: number): string | null {
    const own = run[w]!.tags.name;
    if (own) return own;
    const p = xy[i];
    const h = heading(i);
    if (!p) return null;
    let best: { name: string; dist: number } | null = null;
    shapes.forEach((s, k) => {
      const name = run[k]!.tags.name;
      if (!name || k === w) return;
      for (const seg of s.segs) {
        const r = toSegment(p[0], p[1], seg);
        if (r.dist > NAME_REACH_M || (best && r.dist >= best.dist)) continue;
        const n = Math.hypot(r.dx, r.dy);
        if (h && n > 0 && Math.abs((h[0] * r.dx + h[1] * r.dy) / n) < 0.7) continue;
        best = { name, dist: r.dist };
      }
    });
    return best ? (best as { name: string }).name : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ce qu'une voie dit du sol
// ─────────────────────────────────────────────────────────────────────────────

const SURFACE_FR: Record<string, string> = {
  asphalt: 'asphalte', paved: 'revêtement', concrete: 'béton', 'concrete:plates': 'dalles de béton',
  'concrete:lanes': 'béton', paving_stones: 'pavés', sett: 'pavés', unhewn_cobblestone: 'pavés bruts',
  cobblestone: 'pavés', 'cobblestone:flattened': 'pavés', bricks: 'briques', metal: 'métal', wood: 'bois',
  compacted: 'stabilisé', fine_gravel: 'gravier fin', gravel: 'gravier', pebblestone: 'galets', rock: 'rocher',
  ground: 'terre', dirt: 'terre', earth: 'terre', mud: 'boue', sand: 'sable', grass: 'herbe', unpaved: 'non revêtu',
  woodchips: 'copeaux',
};

/** Ce qui se court comme une trace, pas comme une allée. */
const NATURAL = new Set(['ground', 'dirt', 'earth', 'mud', 'sand', 'grass', 'rock', 'pebblestone', 'woodchips']);

const surfaceOf = (tags: Record<string, string>): string | undefined => tags.surface?.split(';')[0]?.trim();

/** La nature d'une voie : route, chemin, sentier, escalier. */
export function kindOf(tags: Record<string, string>): GroundKind {
  const h = tags.highway;
  if (h === 'steps') return 'escalier';
  const surface = surfaceOf(tags);
  if (h === 'path' || h === 'bridleway') return surface && !NATURAL.has(surface) ? 'chemin' : 'sentier';
  if (h === 'track') return surface && NATURAL.has(surface) ? 'sentier' : 'chemin';
  if (h === 'footway' || h === 'cycleway') {
    if (tags.footway === 'sidewalk' || tags.footway === 'crossing') return 'route';
    return surface && NATURAL.has(surface) ? 'sentier' : 'chemin';
  }
  return 'route';
}

/** Les trottoirs d'une voie ; `sidewalk` quand la voie est elle-même un trottoir. */
function sidewalkOf(tags: Record<string, string>): string | undefined {
  if (tags.footway === 'sidewalk') return 'sidewalk';
  const s = tags.sidewalk;
  if (s) return s === 'none' ? 'no' : s;
  const both = tags['sidewalk:both'];
  if (both === 'yes') return 'both';
  if (both === 'separate') return 'separate';
  const left = tags['sidewalk:left'] === 'yes';
  const right = tags['sidewalk:right'] === 'yes';
  if (left && right) return 'both';
  if (left) return 'left';
  if (right) return 'right';
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Un tronçon de la montée
// ─────────────────────────────────────────────────────────────────────────────

interface Piece {
  way: number;
  from: number;
  to: number;
}

/** Les portions de voie entre deux distances du profil, dans l'ordre du pied au haut. */
function piecesBetween(m: MatchedTrack, lo: number, hi: number): Piece[] {
  const out: Piece[] = [];
  const push = (way: number, a: number, b: number) => {
    const from = Math.max(lo, a);
    const to = Math.min(hi, b);
    if (to <= from) return;
    const prev = out[out.length - 1];
    if (prev && prev.way === way && Math.abs(prev.to - from) < 1e-6) prev.to = to;
    else out.push({ way, from, to });
  };
  for (let i = 1; i < m.d.length; i++) {
    const a = m.d[i - 1]!;
    const b = m.d[i]!;
    if (b <= lo || a >= hi) continue;
    const wa = m.way[i - 1]!;
    const wb = m.way[i]!;
    if (wa === wb) push(wa, a, b);
    else {
      const mid = (a + b) / 2;
      push(wa, a, mid);
      push(wb, mid, b);
    }
  }
  return out;
}

/**
 * Le sol entre deux points de la montée, dans le sens de la course : de `fromD`
 * vers `toD`, distances depuis le pied. Une descente va du haut vers le bas, et
 * son sol se lit dans cet ordre.
 */
export function groundBetween(m: MatchedTrack, fromD: number, toD: number): StretchGround & { offM: number } {
  const lo = Math.min(fromD, toD);
  const hi = Math.max(fromD, toD);
  const pieces = piecesBetween(m, lo, hi);
  const ordered = fromD <= toD ? pieces : [...pieces].reverse();
  let offM = 0;
  const runs: GroundRun[] = [];
  for (const p of ordered) {
    const lengthM = p.to - p.from;
    if (p.way < 0) {
      offM += lengthM;
      continue;
    }
    const w = m.ways[p.way]!;
    const prev = runs[runs.length - 1];
    if (prev && prev.way === w.id) {
      prev.lengthM += lengthM;
      continue;
    }
    const name = streetAt(m, p);
    const surface = surfaceOf(w.tags);
    const steps = Number(w.tags.step_count);
    const sidewalk = sidewalkOf(w.tags);
    runs.push({
      kind: kindOf(w.tags),
      lengthM,
      ...(name ? { name: streetName(name) } : {}),
      ...(surface ? { surface: SURFACE_FR[surface] ?? surface } : {}),
      ...(w.tags.highway === 'steps' && Number.isFinite(steps) && steps > 0 ? { steps } : {}),
      ...(sidewalk ? { sidewalk } : {}),
      way: w.id,
    });
  }
  for (const r of runs) {
    // Les marches d'un escalier qu'on ne prend qu'en partie : sa part de la
    // volée, pas la volée entière.
    if (r.steps) {
      const w = m.ways.find((x) => x.id === r.way)!;
      const share = Math.min(1, r.lengthM / Math.max(1, wayLength(w)));
      r.steps = Math.max(1, Math.round(r.steps * share));
    }
    r.lengthM = Math.round(r.lengthM);
  }
  return { runs: runs.filter((r) => r.lengthM > 0), readAt: m.readAt, offM: Math.round(offM) };
}

/** Longueur d'une voie, m, par ses nœuds. */
function wayLength(w: OsmWay): number {
  const g = w.geometry;
  if (g.length < 2) return 0;
  const plane = planeAt(g[0]![0], g[0]![1]);
  let total = 0;
  for (let i = 1; i < g.length; i++) {
    const [ax, ay] = plane.x(g[i - 1]!);
    const [bx, by] = plane.x(g[i]!);
    total += Math.hypot(bx - ax, by - ay);
  }
  return total;
}

/** Le nom le plus porté sur une portion : c'est lui qu'on lit sur la plaque. */
function streetAt(m: MatchedTrack, p: Piece): string | null {
  const count = new Map<string, number>();
  for (let i = 0; i < m.d.length; i++) {
    if (m.d[i]! < p.from - 3 || m.d[i]! > p.to + 3 || m.way[i] !== p.way) continue;
    const s = m.street[i];
    if (s) count.set(s, (count.get(s) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [s, n] of count) if (!best || n > (count.get(best) ?? 0)) best = s;
  return best;
}

/** Longueur minimale d'une voie pour qu'on la cite dans l'itinéraire, m : un carrefour n'est pas une rue. */
const STREET_MIN_M = 25;

/** Pour chaque voie, la variante de son nom qu'on court le plus longtemps. */
function variants(runs: readonly GroundRun[]): Map<string, string> {
  const byName = new Map<string, number>();
  for (const r of runs) if (r.name) byName.set(r.name, (byName.get(r.name) ?? 0) + r.lengthM);
  const best = new Map<string, { name: string; lengthM: number }>();
  for (const [name, lengthM] of byName) {
    const key = streetKey(name);
    const seen = best.get(key);
    if (!seen || lengthM > seen.lengthM) best.set(key, { name, lengthM });
  }
  return new Map([...best].map(([key, v]) => [key, v.name]));
}

/**
 * Les voies d'un tronçon, dans l'ordre où on les court, sans les traversées :
 * une voie courue moins de 25 m n'est qu'un carrefour. Une même rue, qu'elle
 * soit écrite avec ou sans trait d'union, ne se cite qu'une fois.
 */
export function streetsOf(g: StretchGround): string[] {
  const names = variants(g.runs);
  const byKey: { key: string; lengthM: number }[] = [];
  for (const r of g.runs) {
    if (!r.name) continue;
    const key = streetKey(r.name);
    const last = byKey[byKey.length - 1];
    if (last && last.key === key) last.lengthM += r.lengthM;
    else byKey.push({ key, lengthM: r.lengthM });
  }
  const kept = byKey.filter((s) => s.lengthM >= STREET_MIN_M).map((s) => s.key);
  return kept.filter((k, i) => k !== kept[i - 1]).map((k) => names.get(k)!);
}

/**
 * La voie qui nomme une montée : celle qu'on y court le plus longtemps, pourvu
 * qu'elle en porte le tiers. En deçà, aucune ne la nomme, et on ne lui en prête
 * pas.
 */
export function nameOf(m: MatchedTrack, fromD: number, toD: number): string | null {
  const g = groundBetween(m, fromD, toD);
  const total = Math.abs(toD - fromD);
  const names = variants(g.runs);
  const by = new Map<string, number>();
  for (const r of g.runs) if (r.name) by.set(streetKey(r.name), (by.get(streetKey(r.name)) ?? 0) + r.lengthM);
  let best: [string, number] | null = null;
  for (const e of by) if (!best || e[1] > best[1]) best = e;
  return best && total > 0 && best[1] >= total / 3 ? names.get(best[0])! : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Le tracé
// ─────────────────────────────────────────────────────────────────────────────

/** Écart toléré entre le tracé allégé et la trace, m : invisible sur une carte de quartier. */
const TRACK_TOLERANCE_M = 3;

/**
 * Le tracé d'un tronçon : les points du profil entre deux distances, bouts
 * interpolés, allégé sans s'écarter de plus de trois mètres de la trace, dans
 * le sens de la course.
 */
export function trackBetween(profile: readonly TrackPoint[], fromD: number, toD: number): [number, number][] {
  const lo = Math.min(fromD, toD);
  const hi = Math.max(fromD, toD);
  const pts: [number, number][] = [];
  const at = (target: number): [number, number] | null => {
    for (let i = 1; i < profile.length; i++) {
      const a = profile[i - 1]!;
      const b = profile[i]!;
      if (b.d < target || !a.at || !b.at) continue;
      const f = b.d === a.d ? 0 : Math.max(0, Math.min(1, (target - a.d) / (b.d - a.d)));
      return [a.at[0] + f * (b.at[0] - a.at[0]), a.at[1] + f * (b.at[1] - a.at[1])];
    }
    return null;
  };
  const start = at(lo);
  if (start) pts.push(start);
  for (const p of profile) if (p.at && p.d > lo && p.d < hi) pts.push([p.at[0], p.at[1]]);
  const end = at(hi);
  if (end) pts.push(end);
  if (pts.length < 2) return pts.map(round6);
  const plane = planeAt(pts[0]![0], pts[0]![1]);
  const simple = simplify(pts, pts.map((p) => plane.x(p)), TRACK_TOLERANCE_M).map(round6);
  return fromD <= toD ? simple : simple.reverse();
}

const round6 = (p: readonly [number, number]): [number, number] => [
  Math.round(p[0] * 1e6) / 1e6,
  Math.round(p[1] * 1e6) / 1e6,
];

/** Douglas-Peucker, sur les coordonnées planes. */
function simplify(pts: [number, number][], xy: [number, number][], tolerance: number): [number, number][] {
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    let far = -1;
    let dist = 0;
    for (let i = a + 1; i < b; i++) {
      const r = toSegment(xy[i]![0], xy[i]![1], { ax: xy[a]![0], ay: xy[a]![1], bx: xy[b]![0], by: xy[b]![1] });
      if (r.dist > dist) {
        dist = r.dist;
        far = i;
      }
    }
    if (far >= 0 && dist > tolerance) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Distance d'une position à une polyligne de positions, m. */
export function distanceToTrack(p: readonly [number, number], track: readonly (readonly [number, number])[]): number {
  if (track.length === 0) return Infinity;
  const plane = planeAt(p[0], p[1]);
  const [px, py] = plane.x(p);
  const xy = track.map((q) => plane.x(q));
  if (xy.length === 1) return Math.hypot(xy[0]![0] - px, xy[0]![1] - py);
  let best = Infinity;
  for (let i = 1; i < xy.length; i++) {
    const r = toSegment(px, py, { ax: xy[i - 1]![0], ay: xy[i - 1]![1], bx: xy[i]![0], by: xy[i]![1] });
    if (r.dist < best) best = r.dist;
  }
  return best;
}
