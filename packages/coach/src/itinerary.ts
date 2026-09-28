import type {
  AthleteHome, PhysiologyModel, PlannedSession, RouteLeg, RouteStep, SessionBlock, SessionRoute, TerrainPoint,
  TerrainStretch,
} from '@cairn/core';
import {
  climbsBack, groundText, itinerary, ofName, passagesOf, recoveryTimes, sessionDuration, stairsOf, streetKey,
  streetName, toName, viaStreets, withArticle,
} from '@cairn/core';
import { FLAT_RUNNING_COST, descentSpeedCeiling, easySpeedOf, isEasyZone, speedForMetabolicPower } from '@cairn/physiology';
import { profileAlong, reliefOf, resample, smoothed, type AltitudeIndex } from './altitude.js';
import { addressOf, awayFromHome, landmarkAt, roadAt, type Landmark } from './geo.js';
import { footRoute, footTable, type FootRoute, type FootStep } from './routing.js';
import { descentLoopFit, loopTooLongNote } from './sessionLibrary.js';
import { distanceToTrack } from './ground.js';
import { haversineM, type LightTrace, type TerrainHint } from './terrain.js';

/**
 * L'itinéraire de porte à porte d'une séance de terrain.
 *
 * Une séance de terrain dit où se court son motif — la montée, le haut, le
 * demi-tour —, pas comment on y va ni comment on rentre. L'itinéraire le dit :
 * de chez l'athlète au départ du motif, le motif et ses répétitions, puis le
 * retour, une étape par ligne, avec les noms des voies et des repères.
 *
 * Chaque bloc de la séance y garde sa durée : les segments qu'il court font ce
 * qu'il prescrit. Un échauffement de 20 min dure 20 min — quand le chemin
 * jusqu'au départ en prend 12, un détour nommé, aller et retour sur un chemin
 * plat, fait les 8 qui manquent. Un chemin plus long que le bloc n'est pas
 * raccourci : l'itinéraire le dit.
 *
 * Le trajet vient d'OSRM, le moteur d'itinéraire piéton (`routing.ts`), et des
 * traces de l'athlète pour les montées et le chemin d'un haut à l'autre ; les
 * noms d'OpenStreetMap, par géocodage inverse quand OSRM n'en donne pas ; le
 * relief, de ses traces (`altitude.ts`) ; les durées, de son modèle, à l'effort
 * de chaque bloc et pente par pente. Aucun modèle de langage n'y écrit un mot.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Les services
// ─────────────────────────────────────────────────────────────────────────────

/** Ce que l'itinéraire demande au monde : un trajet, des distances, des noms. */
export interface RouteServices {
  route(points: readonly (readonly [number, number])[]): Promise<FootRoute | null>;
  table(from: readonly [number, number], to: readonly (readonly [number, number])[]): Promise<(number | null)[] | null>;
  /** La voie d'un point — jamais demandée près du domicile. */
  road(at: readonly [number, number], home: readonly [number, number]): Promise<string | null>;
  /** « 12 quai Fulchiron » — jamais demandée près du domicile. */
  address(at: readonly [number, number], home: readonly [number, number]): Promise<string | null>;
  landmark(at: readonly [number, number], home: readonly [number, number]): Promise<Landmark | null>;
}

/** OSRM pour le trajet, Nominatim pour les noms, chaque réponse gardée en base. */
export const OSM_SERVICES: RouteServices = {
  route: footRoute,
  table: footTable,
  road: roadAt,
  address: (at, home) => (awayFromHome(at, home) ? addressOf(at) : Promise.resolve(null)),
  landmark: landmarkAt,
};

export interface RouteContext {
  home: AthleteHome;
  model: PhysiologyModel;
  /** Les altitudes des traces de l'athlète. */
  altitude: AltitudeIndex;
  /** Ses traces : c'est par elles qu'un détour suit un chemin qu'il connaît. */
  traces?: readonly LightTrace[];
  /** Ses montées et leurs boucles : c'est par elles qu'une boucle écartée se dit. */
  terrain?: TerrainHint;
  services: RouteServices;
  now?: string;
}

/** Version de la construction : une règle qui change périme les itinéraires construits avant. */
const ROUTE_VERSION = 1;
/** Sous ce manque, pas de détour : une minute se rattrape en chemin, s. */
export const MIN_DETOUR_S = 60;
/** Une manœuvre plus courte ne fait pas une ligne : elle rejoint la suivante, m. */
const TINY_STEP_M = 15;

// ─────────────────────────────────────────────────────────────────────────────
// L'effort d'un bloc, pente par pente
// ─────────────────────────────────────────────────────────────────────────────

interface Effort {
  /** Puissance métabolique de l'effort, W/kg. */
  power: number;
  /** Aisance en descente du modèle (1 : le trailer de référence). */
  skill: number;
}

/**
 * L'effort d'un bloc : sous un plafond de FC, la vitesse que l'athlète y tient
 * sur le terrain du bloc, lue dans ses sorties (`easySpeedOf`) ; sinon le milieu
 * de la fourchette prescrite. Rapportée à la course à plat, c'est une
 * puissance, qui se dépense sur chaque pente.
 */
function effortOf(model: PhysiologyModel, b: Pick<SessionBlock, 'zone' | 'terrain' | 'speedRangeMs'>): Effort {
  const flat = isEasyZone(b.zone)
    ? easySpeedOf(model, b.zone, b.terrain ?? 'flat').speedMs
    : b.speedRangeMs
      ? (b.speedRangeMs[0] + b.speedRangeMs[1]) / 2
      : easySpeedOf(model, 'Z2', 'flat').speedMs;
  return { power: FLAT_RUNNING_COST * flat, skill: model.descentSkill ?? 1 };
}

/** La vitesse à cet effort sur cette pente : la marche dès qu'elle est raide, et en descente, ce que les appuis permettent. */
function speedOn(e: Effort, grade: number): number {
  const g = Math.max(-0.45, Math.min(0.45, grade));
  const v = speedForMetabolicPower(e.power, g);
  return g < -0.01 ? Math.min(v, descentSpeedCeiling(g, 1, e.skill)) : v;
}

interface Run {
  durationS: number;
  distanceM: number;
  gainM: number;
  lossM: number;
  unmeasuredM: number;
}

/** Ce qu'un tracé prend à cet effort, monte et descend : son relief lu sur les traces, lissé sur 60 m. */
function runAlong(track: readonly (readonly [number, number])[], e: Effort, altitude: AltitudeIndex): Run {
  const profile = profileAlong(track, altitude);
  const z = smoothed(profile);
  let durationS = 0;
  for (let k = 1; k < profile.length; k++) {
    const dd = profile[k]!.d - profile[k - 1]!.d;
    if (dd <= 0) continue;
    const a = z[k - 1];
    const b = z[k];
    durationS += dd / speedOn(e, a != null && b != null ? (b - a) / dd : 0);
  }
  const relief = reliefOf(profile);
  return { durationS, distanceM: profile[profile.length - 1]?.d ?? 0, ...relief };
}

/** Un tronçon de montée parcouru à cet effort, à sa pente moyenne — montée (`+1`) ou descendue (`-1`). */
const stretchTime = (w: Pick<TerrainStretch, 'lengthM' | 'grade'>, way: 1 | -1, e: Effort) =>
  w.lengthM / speedOn(e, way * w.grade);

// ─────────────────────────────────────────────────────────────────────────────
// Les indications, rue par rue
// ─────────────────────────────────────────────────────────────────────────────

const cap = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

/** « dans la rue Cléberg », « sur le quai Romain Rolland » : on est dans une rue, sur un quai. */
function along(name: string): string {
  const art = withArticle(name);
  return /^(rue|ruelle|impasse|allée|passage|traboule|cour|galerie|avenue)\b/i.test(name) ? `dans ${art}` : `sur ${art}`;
}

const isCrossing = (name: string) => /^(pont|passerelle|viaduc)\b/i.test(name);

/** « N 6 », « D 489 » : un numéro de route, pas un nom qu'on lit sur une plaque. */
const isRef = (name: string) => /^[A-Z]{1,3}\s?\d+[a-z]?$/.test(name.trim());

/** Une manœuvre d'OSRM, dite comme on la dit à quelqu'un qui court. */
export function maneuverText(type: string, modifier: string | undefined, name: string | null, exit?: number): string {
  const art = name ? withArticle(name) : null;
  const side = modifier?.includes('left') ? 'à gauche' : modifier?.includes('right') ? 'à droite' : null;
  const how = modifier?.startsWith('slight') ? 'légèrement ' : modifier?.startsWith('sharp') ? 'franchement ' : '';
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') {
    return `Au rond-point, prends la ${exit ?? 1}${exit === 1 ? 're' : 'e'} sortie${art ? `, ${art}` : ''}`;
  }
  if (modifier === 'uturn') return `Fais demi-tour${name ? ` ${along(name)}` : ''}`;
  if (type === 'depart') return name ? `Pars ${along(name)}` : 'Pars';
  if (side) {
    const prefix = type === 'end of road' ? 'au bout, ' : type === 'fork' ? 'à la fourche, ' : '';
    const text = name
      ? isCrossing(name)
        ? `${prefix}prends ${how}${side} et traverse ${art}`
        : `${prefix}prends ${how}${side} ${art}`
      : `${prefix}tourne ${how}${side}`;
    return cap(text);
  }
  if (name) return isCrossing(name) ? `Traverse ${art}` : `Continue ${along(name)}`;
  return 'Continue tout droit';
}

interface Line {
  type: string;
  modifier?: string;
  exit?: number;
  name: string | null;
  distanceM: number;
}

/** Une portion plus longue se nomme par trois points, à la majorité : une place voisine ne lui prend pas son nom, m. */
const LONG_STEP_M = 200;

/**
 * Les points d'une manœuvre qui la nomment : au milieu de sa portion, loin des
 * carrefours où une autre voie répondrait à sa place — et, sur une longue
 * portion, au quart et aux trois quarts aussi. À défaut du milieu, le plus
 * proche qui soit assez loin du domicile, entre le cinquième et les quatre
 * cinquièmes de la portion. Aucun près de chez l'athlète : la portion reste
 * sans nom plutôt que d'envoyer où il habite.
 */
function namingPoints(s: FootStep, home: readonly [number, number]): [number, number][] {
  const pts = resample(s.track, 10);
  if (pts.length === 0) return [];
  const len = pts[pts.length - 1]!.d;
  const usable = pts.filter((p) => p.d >= 0.2 * len && p.d <= 0.8 * len && awayFromHome(p.at, home));
  const near = (d: number) => usable.reduce<(typeof usable)[number] | null>((a, p) => (!a || Math.abs(p.d - d) < Math.abs(a.d - d) ? p : a), null);
  const aims = len >= LONG_STEP_M ? [0.5, 0.25, 0.75] : [0.5];
  const out: [number, number][] = [];
  for (const f of aims) {
    const p = near(f * len);
    if (p && !out.some((q) => q[0] === p.at[0] && q[1] === p.at[1])) out.push(p.at);
  }
  return out;
}

/**
 * Le nom d'une portion par géocodage inverse : celui que la majorité de ses
 * points donne, le milieu départageant — ou, `strict`, seulement s'il a la
 * majorité.
 */
async function nameOfStep(
  s: FootStep,
  ctx: Pick<RouteContext, 'home' | 'services'>,
  strict = false,
): Promise<string | null> {
  const names: string[] = [];
  for (const p of namingPoints(s, ctx.home.at)) {
    const n = await ctx.services.road(p, ctx.home.at);
    if (n && !isRef(n)) names.push(n);
  }
  if (names.length === 0) return null;
  const votes = new Map<string, number>();
  for (const n of names) votes.set(streetKey(n), (votes.get(streetKey(n)) ?? 0) + 1);
  const top = Math.max(...votes.values());
  if (strict && top < 2) return null;
  return names.find((n) => votes.get(streetKey(n)) === top) ?? null;
}

/**
 * Les lignes d'un trajet OSRM : une manœuvre par ligne, le nom de sa voie —
 * celui d'OSRM, ou, pour un trottoir, un quai ou une passerelle qu'OSRM ne
 * nomme pas, celui que le géocodage inverse donne au milieu de la portion.
 * Les portions de moins de 15 m rejoignent leur voisine ; deux portions sur la
 * même voie n'en font qu'une.
 */
export async function directions(
  route: FootRoute,
  ctx: Pick<RouteContext, 'home' | 'services'>,
  opts: { fromHome?: boolean } = {},
): Promise<RouteStep[]> {
  return render(await namedLines(route, ctx), opts);
}

/** Les manœuvres d'un trajet, nommées et fusionnées : une par ligne à dire. */
async function namedLines(route: FootRoute, ctx: Pick<RouteContext, 'home' | 'services'>): Promise<Line[]> {
  const lines: Line[] = [];
  for (const s of route.steps) {
    if (s.type === 'arrive') continue;
    let name: string | null = s.name && !isRef(s.name) ? streetName(s.name) : null;
    if (s.distanceM >= LONG_STEP_M) {
      // OSRM nomme une portion par la voie où elle commence : 836 m le long de
      // la Saône s'appelaient « place Ennemond Fousseret ». Sur une longue
      // portion, les voies qu'elle longe ont le dernier mot quand elles
      // s'accordent.
      name = (await nameOfStep(s, ctx, true)) ?? name ?? (await nameOfStep(s, ctx));
    } else if (!name && s.distanceM >= TINY_STEP_M) name = await nameOfStep(s, ctx);
    lines.push({
      type: s.type,
      ...(s.modifier ? { modifier: s.modifier } : {}),
      ...(s.exit ? { exit: s.exit } : {}),
      name,
      distanceM: s.distanceM,
    });
  }
  const merged: Line[] = [];
  for (const l of lines) {
    const prev = merged[merged.length - 1];
    if (prev && l.name && prev.name && streetKey(l.name) === streetKey(prev.name) && l.modifier !== 'uturn') {
      prev.distanceM += l.distanceM;
      continue;
    }
    if (prev && l.distanceM < TINY_STEP_M && !l.name) {
      prev.distanceM += l.distanceM;
      continue;
    }
    merged.push({ ...l });
  }
  // Une première portion minuscule — le pas de porte — ne fait pas une ligne.
  if (merged.length > 1 && merged[0]!.type === 'depart' && merged[0]!.distanceM < TINY_STEP_M && !merged[0]!.name) {
    merged[1]!.distanceM += merged.shift()!.distanceM;
  }
  return merged;
}

/** Les lignes dites : au présent, à la deuxième personne ; la première, en sortant de chez soi. */
function render(merged: readonly Line[], opts: { fromHome?: boolean } = {}): RouteStep[] {
  const lines = merged.map((l) => ({ ...l }));
  // Hors de chez soi, les quelques mètres qui mènent à la première vraie voie —
  // descendre du trottoir, contourner une place — ne font pas trois lignes :
  // on rejoint la voie.
  let joined = 0;
  if (!opts.fromHome) {
    const k = lines.findIndex((l) => l.distanceM >= JOIN_M && l.name);
    const lead = lines.slice(0, Math.max(0, k)).reduce((s, l) => s + l.distanceM, 0);
    if (k > 0 && lead <= JOIN_MAX_M) {
      lines[k]!.distanceM += lead;
      lines.splice(0, k);
      joined = k;
    }
  }
  return lines.map((l, i) => {
    let text = maneuverText(l.type, l.modifier, l.name, l.exit);
    if (i === 0 && joined > 0 && l.name) text = `Rejoins ${withArticle(l.name)}`;
    if (i === 0 && opts.fromHome) text = l.type === 'depart' ? `Sors de chez toi${l.name ? ` et pars ${along(l.name)}` : ''}` : `De chez toi, ${text[0]!.toLowerCase()}${text.slice(1)}`;
    return { text: `${text}.`, distanceM: Math.round(l.distanceM) };
  });
}

/** Une première portion plus courte n'est qu'un raccord vers la voie qu'on va suivre, m. */
const JOIN_M = 30;
/** Au-delà, les raccords de tête sont un chemin à dire, pas un détail, m. */
const JOIN_MAX_M = 80;

// ─────────────────────────────────────────────────────────────────────────────
// Les repères
// ─────────────────────────────────────────────────────────────────────────────

/** « près de la tour métallique de Fourvière », « au pont Bonaparte » : un repère dit comme on s'y rend. */
function nearLandmark(l: Landmark): string {
  const named = withArticle(streetName(l.name));
  return l.kind === 'man_made/bridge' ? toName(named) : `près ${ofName(named)}`;
}

/** « jusqu'au n° 49 », « jusqu'à la rue François Vernay », « jusqu'à hauteur de la tour… ». */
const until = (mark: string) => (mark.startsWith('près ') ? `jusqu'à hauteur ${mark.slice(5)}` : `jusqu'${mark}`);

/** Ce qui situe un point clé : son repère, sinon son numéro — « au n° 49 » —, sinon rien. */
async function markOf(p: TerrainPoint, ctx: RouteContext, onStreet?: string): Promise<string | null> {
  const l = await ctx.services.landmark(p.at, ctx.home.at);
  if (l) return nearLandmark(l);
  if (!p.address) return null;
  const m = p.address.match(/^(\d+\s?(?:bis|ter)?)\s+(.*)$/i);
  if (m && onStreet && streetKey(onStreet).endsWith(streetKey(m[2]!))) return `au n° ${m[1]}`;
  if (m) return `au ${p.address}`;
  return onStreet && streetKey(onStreet).endsWith(streetKey(p.address)) ? null : toName(withArticle(p.address));
}

// ─────────────────────────────────────────────────────────────────────────────
// Le tracé coupé
// ─────────────────────────────────────────────────────────────────────────────

/** Le début d'un tracé, sur `lengthM` mètres ; le dernier point est interpolé. */
export function cutTrack(track: readonly (readonly [number, number])[], lengthM: number): [number, number][] {
  const out: [number, number][] = [];
  let acc = 0;
  for (let k = 0; k < track.length; k++) {
    const p = track[k]!;
    if (k === 0) {
      out.push([p[0], p[1]]);
      continue;
    }
    const a = track[k - 1]!;
    const len = haversineM(a, p);
    if (acc + len >= lengthM) {
      const f = len > 0 ? (lengthM - acc) / len : 0;
      out.push([Math.round((a[0] + f * (p[0] - a[0])) * 1e6) / 1e6, Math.round((a[1] + f * (p[1] - a[1])) * 1e6) / 1e6]);
      return out;
    }
    acc += len;
    out.push([p[0], p[1]]);
  }
  return out;
}

/** Le début d'un trajet OSRM, sur `lengthM` mètres : ses manœuvres jusque-là, la dernière écourtée. */
function cutRoute(route: FootRoute, lengthM: number): FootRoute {
  const steps: FootStep[] = [];
  let acc = 0;
  for (const s of route.steps) {
    if (s.type === 'arrive') continue;
    if (acc + s.distanceM >= lengthM) {
      const rest = lengthM - acc;
      if (rest > 0) steps.push({ ...s, distanceM: rest, track: cutTrack(s.track, rest) });
      break;
    }
    steps.push(s);
    acc += s.distanceM;
  }
  return { distanceM: lengthM, track: cutTrack(route.track, lengthM), steps };
}

/** Les services, sans géocodage près du domicile : le point ne part pas, la réponse est « rien ». */
function guarded(s: RouteServices, home: readonly [number, number]): RouteServices {
  return {
    route: s.route,
    table: s.table,
    road: (at, h) => (awayFromHome(at, home) ? s.road(at, h) : Promise.resolve(null)),
    address: (at, h) => (awayFromHome(at, home) ? s.address(at, h) : Promise.resolve(null)),
    landmark: (at, h) => (awayFromHome(at, home) ? s.landmark(at, h) : Promise.resolve(null)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Le détour
// ─────────────────────────────────────────────────────────────────────────────

/** Un point à `r` mètres de `p`, dans la direction `deg` (0 : nord). */
function offset(p: readonly [number, number], r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const lat = p[0] + (r * Math.cos(a)) / 111_320;
  const lng = p[1] + (r * Math.sin(a)) / (111_320 * Math.cos((p[0] * Math.PI) / 180));
  return [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6];
}

const BEARINGS = Array.from({ length: 12 }, (_, i) => i * 30);
/** Une trace passe par le départ d'un détour quand elle en approche à 30 m. */
const TRACE_REACH_M = 30;
/** Deux destinations à moins de ça l'une de l'autre sont la même direction, m. */
const SAME_TARGET_M = 150;
/** Directions tracées au plus : chacune coûte une question à OSRM la première fois. */
const MAX_TARGETS = 6;

/**
 * Où mènent, à `half` mètres, les chemins que l'athlète a pris depuis `from` :
 * sur chaque trace qui y passe, dans un sens et dans l'autre, le point atteint
 * après cette distance. Ce sont ses chemins — les quais qu'il longe, pas une
 * direction tirée au hasard dans la ville.
 */
function traceTargets(
  from: readonly [number, number],
  half: number,
  traces: readonly LightTrace[],
): [number, number][] {
  const out: [number, number][] = [];
  for (const t of traces) {
    for (let k = 0; k < t.at.length; k++) {
      if (haversineM(t.at[k]!, from) > TRACE_REACH_M) continue;
      while (k + 1 < t.at.length && haversineM(t.at[k + 1]!, from) < haversineM(t.at[k]!, from)) k++;
      for (const way of [1, -1] as const) {
        let j = k;
        while (j + way >= 0 && j + way < t.at.length && Math.abs(t.d[j]! - t.d[k]!) < half) j += way;
        if (Math.abs(t.d[j]! - t.d[k]!) >= half * 0.95 && !out.some((p) => haversineM(p, t.at[j]!) < SAME_TARGET_M)) {
          out.push(t.at[j]!);
        }
      }
      // Le passage suivant par le même point, plus loin dans la trace.
      while (k + 1 < t.at.length && haversineM(t.at[k + 1]!, from) <= TRACE_REACH_M) k++;
    }
  }
  return out;
}

/**
 * Le détour qui rallonge un bloc de `extraS` secondes, depuis `from` : un
 * aller-retour sur un chemin plat, jusqu'à un point qui se nomme.
 *
 * Les directions viennent d'abord des traces de l'athlète — où mènent les
 * chemins qu'il a pris depuis ce point —, à défaut de douze directions dont une
 * seule question à OSRM donne les distances. Chacune est tracée par OSRM, coupée
 * à la moitié de ce qui manque, et jugée sur son relief — lu sur les traces —,
 * sur ce que l'athlète y a déjà couru, sur ce qu'elle repasse par où la séance
 * passe déjà, et sur le nombre de ses manœuvres : un détour se suit sans
 * réfléchir. Le demi-tour se place pour que l'aller et le retour fassent
 * exactement ce qui manque, à l'effort du bloc.
 */
async function detour(
  from: readonly [number, number],
  extraS: number,
  e: Effort,
  ctx: RouteContext,
  avoid: readonly (readonly [number, number])[][],
  taken: readonly (readonly [number, number])[][] = [],
): Promise<{ route: FootRoute; run: Run; turn: [number, number] } | null> {
  const half = (extraS * speedOn(e, 0)) / 2;
  if (!(half > 30)) return null;
  const known = traceTargets(from, half, ctx.traces ?? []).slice(0, MAX_TARGETS);
  // Les directions que ses traces ne prennent pas — l'autre rive, l'aval —
  // restent candidates : un second détour doit pouvoir aller ailleurs.
  const ring = Math.max(200, Math.ceil(half / 100) * 100);
  const targets = BEARINGS.map((deg) => offset(from, ring, deg));
  const reach = (await ctx.services.table(from, targets)) ?? [];
  const around = targets
    .map((t, i) => ({ t, d: reach[i] }))
    .filter((x): x is { t: [number, number]; d: number } => x.d != null && x.d >= half && x.d <= 3 * ring)
    .filter((x) => !known.some((k) => haversineM(k, x.t) < SAME_TARGET_M))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.t);
  const viable = [...known, ...around];
  let best: { route: FootRoute; run: Run; turn: [number, number]; score: number } | null = null;
  for (const t of viable) {
    const full = await ctx.services.route([from, t]);
    if (!full || full.distanceM < half) continue;
    // Le demi-tour se place pour que l'aller-retour fasse ce qui manque : un
    // aller en pente ne se court pas à la vitesse du plat.
    let length = half;
    let cut = cutRoute(full, length);
    let run = runAlong(cut.track, e, ctx.altitude);
    for (let k = 0; k < 2 && run.durationS > 0; k++) {
      const back = runAlong([...cut.track].reverse(), e, ctx.altitude);
      length = Math.min(full.distanceM, (length * extraS) / (run.durationS + back.durationS));
      cut = cutRoute(full, length);
      run = runAlong(cut.track, e, ctx.altitude);
    }
    const samples = resample(cut.track, 20);
    const share = (tracks: readonly (readonly [number, number])[][]) =>
      samples.filter((s) => tracks.some((a) => a.length > 1 && distanceToTrack(s.at, a) <= 20)).length /
      Math.max(1, samples.length);
    // Repasser par la séance se tolère — on longe le quai qu'on vient de
    // prendre ; refaire un détour déjà fait, non : ce serait le même deux fois.
    const overlap = share(avoid) + 4 * share(taken);
    const covered = 1 - run.unmeasuredM / Math.max(1, run.distanceM);
    const turns = cut.steps.filter((s) => s.distanceM >= TINY_STEP_M).length;
    // Un parking, une bretelle, une autoroute : OSRM y passe à pied, personne n'y court.
    const hostile = cut.steps.filter((s) => HOSTILE.test(s.name)).length * 100;
    // Un détour complète une durée à plat : une côte y changerait la séance.
    const hilly = run.gainM > Math.max(FLAT_DETOUR_M, 0.015 * run.distanceM) ? 200 : 0;
    const score = run.gainM + run.lossM + hilly + hostile + 40 * overlap + 60 * (1 - covered) + 1.5 * turns;
    if (!best || score < best.score) best = { route: cut, run, turn: cut.track[cut.track.length - 1]!, score };
  }
  return best && { route: best.route, run: best.run, turn: best.turn };
}

/** Au-delà de ce dénivelé, un détour n'est plus plat, m. */
const FLAT_DETOUR_M = 10;
/** Des voies où l'on ne court pas, même quand un trottoir les longe. */
const HOSTILE = /parking|autoroute|bretelle|tunnel|périphérique|trémie/i;
/** Plus long, l'aller d'un détour ne se suit plus sans réfléchir : on en fait un second, ailleurs, m. */
const MAX_DETOUR_HALF_M = 3000;

type Detour = { route: FootRoute; run: Run; turn: [number, number]; extraS: number };

/**
 * Les détours qui rallongent un bloc de `extraS` secondes : un seul tant que
 * son aller tient en 3 km, sinon autant qu'il en faut, à parts égales, chacun
 * dans une direction que les précédents n'ont pas prise.
 */
async function detours(
  from: readonly [number, number],
  extraS: number,
  e: Effort,
  ctx: RouteContext,
  avoid: readonly (readonly [number, number])[][],
  taken: (readonly [number, number])[][],
): Promise<Detour[]> {
  const maxS = (2 * MAX_DETOUR_HALF_M) / speedOn(e, 0);
  const n = Math.max(1, Math.ceil(extraS / maxS));
  const out: Detour[] = [];
  for (let k = 0; k < n; k++) {
    const share = k === n - 1 ? extraS - out.reduce((s, d) => s + d.extraS, 0) : Math.round(extraS / n);
    if (share < MIN_DETOUR_S) break;
    const d = await detour(from, share, e, ctx, avoid, taken);
    if (!d) break;
    out.push({ ...d, extraS: share });
    taken.push(d.route.track);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Les segments
// ─────────────────────────────────────────────────────────────────────────────

const isRunning = (b: SessionBlock) => !b.kind && !b.circuit;

/** Le bloc qui se répète : celui dont le tronçon porte des répétitions, ou des passages. */
export function motifIndex(blocks: readonly SessionBlock[]): number {
  const repeated = blocks.findIndex((b) => b.where && (b.repeat ?? 1) > 1);
  if (repeated >= 0) return repeated;
  const passages = blocks.findIndex((b) => b.where && (b.elevationGainM ?? 0) > 0 && passagesOf(b, b.where) > 1);
  if (passages >= 0) return passages;
  return blocks.findIndex((b) => b.where);
}

/** Où le motif commence et où il finit. */
function motifEnds(b: SessionBlock): { start: TerrainPoint; end: TerrainPoint } {
  const w = b.where!;
  // Des descentes dont la remontée sépare les répétitions finissent en bas, au demi-tour.
  if ((b.repeat ?? 1) > 1 && b.recovery && climbsBack(b.recovery) && b.recovery.betweenReps) return { start: w.from, end: w.to };
  // Tout le reste revient d'où il est parti : des côtes redescendues, des passages, une boucle.
  return { start: w.from, end: w.from };
}

const sum = (legs: readonly RouteLeg[], k: 'durationS' | 'distanceM' | 'gainM' | 'lossM') =>
  legs.reduce((s, l) => s + l[k], 0);

/** Un segment sur un trajet OSRM. */
async function walkLeg(
  route: FootRoute,
  base: { label: string; block: number; kind: RouteLeg['kind'] },
  e: Effort,
  ctx: RouteContext,
  arrival: string,
  opts: { fromHome?: boolean } = {},
): Promise<RouteLeg> {
  const run = runAlong(route.track, e, ctx.altitude);
  const steps = await directions(route, ctx, opts);
  return {
    ...base,
    durationS: Math.round(run.durationS),
    distanceM: Math.round(route.distanceM),
    gainM: run.gainM,
    lossM: run.lossM,
    ...(run.unmeasuredM > 0.1 * route.distanceM ? { unmeasuredM: run.unmeasuredM } : {}),
    steps: [...steps, { text: arrival, distanceM: 0 }],
    track: route.track,
  };
}

/** Un segment sur un tronçon de montée de la séance, avec les chiffres que la séance en donne. */
function stretchLeg(
  b: SessionBlock,
  block: number,
  w: TerrainStretch,
  way: 1 | -1,
  e: Effort,
  label: string,
): RouteLeg {
  const drop = Math.round(w.grade * w.lengthM);
  const ground = w.ground ? groundText(w.ground) : '';
  return {
    label,
    block,
    kind: 'climb',
    durationS: Math.round(stretchTime(w, way, e)),
    distanceM: w.lengthM,
    gainM: way > 0 ? drop : 0,
    lossM: way < 0 ? drop : 0,
    steps: [{ text: `${itinerary({ ...b, where: w })}${ground ? ` ${cap(ground)}.` : ''}`, distanceM: w.lengthM }],
    track: w.track ?? [w.from.at, w.to.at],
  };
}

/** Un bloc qui ne se déplace pas — des gammes en haut, la souplesse chez soi. */
const stillLeg = (b: SessionBlock, block: number, where: string): RouteLeg => ({
  label: b.label,
  block,
  kind: 'still',
  durationS: Math.round((b.durationS ?? 0) * (b.repeat ?? 1)),
  distanceM: 0,
  gainM: 0,
  lossM: 0,
  steps: [{ text: `${where} : ${b.label.toLocaleLowerCase('fr')}, ${sessionDuration((b.durationS ?? 0) * (b.repeat ?? 1))}.`, distanceM: 0 }],
  track: [],
});

/**
 * Le motif et ses répétitions, avec ce que la séance en prescrit : des
 * descentes et leurs remontées gardent leurs durées ; des passages ou les tours
 * d'une boucle se chronomètrent à l'effort du bloc.
 */
async function motifLeg(b: SessionBlock, block: number, e: Effort, ctx: RouteContext): Promise<RouteLeg> {
  const w = b.where!;
  const top = await markOf(w.to.role === 'haut' ? w.to : w.from, ctx, w.climb);
  const repeat = b.repeat ?? 1;
  const track = [...(w.track ?? []), ...(w.back?.track ?? [])];

  // Des répétitions sur le tronçon : descentes ou côtes, avec leur récupération.
  if (repeat > 1) {
    const r = b.recovery;
    const times = recoveryTimes(b);
    const back = w.back ?? w;
    const goesDown = w.from.role === 'haut';
    const turn = await markOf(w.to, ctx, w.climb);
    const effort = `${w.lengthM} m, ${sessionDuration(b.durationS ?? 0)}`;
    const say = [
      `${goesDown ? 'Descends' : 'Monte'} ${w.climb}${turn ? ` ${until(turn)}` : ''} : ${effort}.`,
    ];
    if (r) {
      const recovery = sessionDuration(r.durationS);
      say.push(
        climbsBack(r)
          ? `Fais demi-tour et remonte ${w.back ? `à pied par ${viaStreets(w.back)}` : 'en marchant'} jusqu'en haut` +
              `${top ? `, ${top}` : ''} : ${recovery}.`
          : `Fais demi-tour et ${(r.elevationLossM ?? 0) > 0 ? 'redescends en trottinant' : 'récupère'} : ${recovery}.`,
      );
    }
    say.push(`${repeat} fois${r?.betweenReps ? ' ; après la dernière, tu ne remontes pas' : ''}.`);
    return {
      label: b.label,
      block,
      kind: 'motif',
      repeat,
      durationS: Math.round(repeat * (b.durationS ?? 0) + times * (r?.durationS ?? 0)),
      distanceM: Math.round(repeat * (b.distanceM ?? w.lengthM) + (r && (climbsBack(r) || (r.elevationLossM ?? 0) > 0) ? times * back.lengthM : 0)),
      gainM: Math.round(repeat * (b.elevationGainM ?? 0) + times * (r?.elevationGainM ?? 0)),
      lossM: Math.round(repeat * (b.elevationLossM ?? 0) + times * (r?.elevationLossM ?? 0)),
      steps: say.map((text) => ({ text, distanceM: 0 })),
      track,
    };
  }

  // Des passages, ou les tours d'une boucle : monter, redescendre, recommencer.
  const n = passagesOf(b, w);
  const back = w.back;
  const up = stretchTime(w, 1, e);
  const down = stretchTime(back ?? w, -1, e);
  const perGain = Math.round(back ? back.grade * back.lengthM : w.grade * w.lengthM);
  const { steps: marches, lengthM: stairsM } = stairsOf(w.ground);
  const climbText =
    `${stairsM > 0 ? `Monte à pied ${w.climb}${marches > 0 ? ` et ses ${marches} marches` : ''}` : `Monte ${w.climb}`}` +
    ` jusqu'en haut${top ? `, ${top}` : ''}.`;
  const downText = back
    ? `Redescends en courant par ${viaStreets(back)}, jusqu'au pied.`
    : 'Redescends par le même chemin, jusqu\'au pied.';
  return {
    label: b.label,
    block,
    kind: 'motif',
    repeat: n,
    durationS: Math.round(n * (up + down)),
    distanceM: Math.round(n * (w.lengthM + (back ?? w).lengthM)),
    gainM: n * perGain,
    lossM: n * perGain,
    steps: [
      { text: climbText, distanceM: w.lengthM },
      { text: downText, distanceM: (back ?? w).lengthM },
      { text: `${n} ${back ? 'tours' : 'passages'} en tout.`, distanceM: 0 },
    ],
    track,
  };
}

/** Le segment d'un détour : l'aller jusqu'au demi-tour, qui se nomme, et le retour. */
async function detourLeg(d: Detour, block: number, ctx: RouteContext, backTo: string): Promise<RouteLeg> {
  const lines = await namedLines(d.route, ctx);
  const steps = render(lines);
  const landmark = await ctx.services.landmark(d.turn, ctx.home.at);
  const address = landmark ? null : await ctx.services.address(d.turn, ctx.home.at);
  const at = landmark
    ? cap(nearLandmark(landmark))
    : address
      ? /^\d/.test(address) ? `Au ${address}` : cap(toName(withArticle(streetName(address))))
      : 'Là';
  const one = Math.round(d.route.distanceM);
  // Le détour se nomme par la voie où il passe le plus de temps : « par le quai Pierre Scize ».
  const main = lines.filter((l) => l.name).sort((a, b) => b.distanceM - a.distanceM)[0]?.name;
  return {
    label: main ? `Détour par ${withArticle(main)}` : 'Détour',
    block,
    kind: 'detour',
    durationS: Math.round(d.extraS),
    distanceM: 2 * one,
    gainM: d.run.gainM + d.run.lossM,
    lossM: d.run.gainM + d.run.lossM,
    ...(d.run.unmeasuredM > 0.1 * one ? { unmeasuredM: 2 * d.run.unmeasuredM } : {}),
    steps: [...steps, { text: `${at}, fais demi-tour et reviens par le même chemin jusqu'${backTo}.`, distanceM: one }],
    track: d.route.track,
  };
}

/**
 * Les segments d'un bloc font sa durée : au-delà d'une minute de manque, un
 * détour ; en deçà, les segments à plat — un trajet d'OSRM, une estimation —
 * prennent la minute à leur compte. Au-delà, l'itinéraire le dit.
 */
function settle(legs: RouteLeg[], block: number, prescribedS: number, label: string, notes: string[]): void {
  const own = legs.filter((l) => l.block === block);
  const natural = own.reduce((s, l) => s + l.durationS, 0);
  const gap = prescribedS - natural;
  const flat = own.filter((l) => l.kind === 'access' || l.kind === 'home' || l.kind === 'detour');
  if (gap < 0 && -gap >= MIN_DETOUR_S) {
    notes.push(
      `${label} : ${sessionDuration(natural)} par ce chemin, ${sessionDuration(-gap)} de plus que les ` +
        `${sessionDuration(prescribedS)} prescrites.`,
    );
    return;
  }
  if (gap === 0 || flat.length === 0) return;
  const total = flat.reduce((s, l) => s + l.durationS, 0);
  let left = gap;
  flat.forEach((l, i) => {
    const share = i === flat.length - 1 ? left : Math.round((gap * l.durationS) / Math.max(1, total));
    l.durationS += share;
    left -= share;
  });
}

/**
 * La base d'un itinéraire : ce dont il dépend. Qu'une de ces choses change —
 * le domicile, un bloc, une allure —, il se refait.
 */
export function routeBasis(s: Pick<PlannedSession, 'blocks'>, home: AthleteHome, model: PhysiologyModel): string {
  const speeds = (['Z1', 'Z2'] as const).flatMap((z) =>
    (['flat', 'trail'] as const).map((t) => Math.round(easySpeedOf(model, z, t).speedMs * 100)),
  );
  const blocks = s.blocks.map((b) => [
    b.label, b.zone, b.terrain ?? null, b.kind ?? null, b.durationS ?? null, b.repeat ?? null, b.distanceM ?? null,
    b.elevationGainM ?? null, b.elevationLossM ?? null, b.recovery?.durationS ?? null,
    b.recovery?.elevationGainM ?? null, b.recovery?.betweenReps ?? null,
    b.where ? [b.where.from.at, b.where.to.at, b.where.lengthM, b.where.back?.lengthM ?? null] : null,
  ]);
  const text = JSON.stringify([ROUTE_VERSION, home.at, home.address, speeds, model.descentSkill ?? null, blocks]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * L'itinéraire d'une séance, de chez l'athlète à chez lui — `null` pour une
 * séance qu'aucun tronçon ne situe, ou quand le moteur d'itinéraire ne répond
 * pas.
 *
 * Avant le motif, l'accès : le premier bloc — l'échauffement — mène de chez
 * lui au départ du motif, par la montée quand il la monte, et un détour
 * complète sa durée ; les blocs suivants se font sur place. Sans échauffement,
 * l'accès et le détour sont pris sur le temps du motif. Après le motif, le
 * premier bloc couru rentre à la maison, par le bas de la montée quand il le
 * porte ; ce qui ne se court pas — souplesse, respiration — se fait chez soi.
 */
export async function buildRoute(
  session: Pick<PlannedSession, 'blocks'>,
  given: RouteContext,
): Promise<SessionRoute | null> {
  // Le domicile ne part que vers le moteur d'itinéraire : quel que soit le
  // service branché, aucun point à moins de `HOME_PRIVACY_M` de chez l'athlète
  // n'est demandé à un géocodeur.
  const ctx: RouteContext = { ...given, services: guarded(given.services, given.home.at) };
  const blocks = session.blocks;
  const m = motifIndex(blocks);
  if (m < 0) return null;
  const mb = blocks[m]!;
  const { start, end } = motifEnds(mb);
  const home = ctx.home.at;
  const legs: RouteLeg[] = [];
  const notes: string[] = [];
  const avoid: [number, number][][] = [];

  // ── Jusqu'au départ du motif ─────────────────────────────────────────────
  const lead = blocks.slice(0, m).map((b, i) => ({ b, i })).filter(({ b }) => isRunning(b));
  const first = lead[0];
  const accessBlock = first ?? { b: mb, i: m };
  const accessEffort = effortOf(ctx.model, accessBlock.b);
  const climb = first?.b.where;
  const accessTo = climb ? climb.from : start;
  const accessRoute = await ctx.services.route([home, accessTo.at]);
  if (!accessRoute) return null;
  const toFoot = accessTo.role === 'pied' ? `au pied de ${mb.where!.climb}` : accessTo.role === 'haut' ? 'en haut' : 'au départ';
  const place = accessTo.address && !streetKey(mb.where!.climb).endsWith(streetKey(accessTo.address)) ? `, ${accessTo.address}` : '';
  legs.push(
    await walkLeg(
      accessRoute,
      { label: `Jusqu'${toFoot}`, block: accessBlock.i, kind: 'access' },
      accessEffort,
      ctx,
      `Tu es ${toFoot}${place}.`,
      { fromHome: true },
    ),
  );
  avoid.push(accessRoute.track);
  if (climb && first) {
    legs.push(stretchLeg(first.b, first.i, climb, 1, accessEffort, first.b.label));
    avoid.push(climb.track ?? []);
  }
  for (const { b, i } of lead.slice(1)) {
    if (b.where) legs.push(stretchLeg(b, i, b.where, b.where.to.role === 'haut' ? 1 : -1, effortOf(ctx.model, b), b.label));
    else legs.push(stillLeg(b, i, climb?.to.role === 'haut' ? 'En haut' : 'Sur place'));
  }

  // ── Le motif ─────────────────────────────────────────────────────────────
  const motif = await motifLeg(mb, m, effortOf(ctx.model, mb), ctx);
  avoid.push(motif.track);

  // Le bloc qui mène au départ se complète au pied, avant de monter : c'est là
  // qu'on a du plat à courir.
  const accessPrescribedS = first ? (first.b.durationS ?? 0) : (mb.durationS ?? 0);
  const accessNatural = legs.filter((l) => l.block === accessBlock.i).reduce((s, l) => s + l.durationS, 0) +
    (first ? 0 : motif.durationS);
  const missing = accessPrescribedS - accessNatural;
  const tours = motif.repeat ?? 1;
  const oneDetourS = (2 * MAX_DETOUR_HALF_M) / speedOn(accessEffort, 0);
  if (missing >= MIN_DETOUR_S && !first && tours > 1 && missing > oneDetourS) {
    // Des passages sans échauffement, et trop de temps pour un détour : le plat
    // se répartit dans chaque tour, au pied, avant de monter — comme un
    // sentier alterne le plat, la montée et la descente —, par un seul chemin
    // qu'on refait à chaque tour.
    const perTour = Math.round(missing / tours);
    const d = await detour(accessTo.at, perTour, accessEffort, ctx, avoid);
    if (d) {
      const flat = await detourLeg({ ...d, extraS: perTour }, accessBlock.i, ctx, toFoot);
      legs.push({
        ...flat,
        repeat: tours,
        durationS: tours * flat.durationS,
        distanceM: tours * flat.distanceM,
        gainM: tours * flat.gainM,
        lossM: tours * flat.lossM,
        ...(flat.unmeasuredM ? { unmeasuredM: tours * flat.unmeasuredM } : {}),
        steps: [{ text: `À chaque tour, avant de monter : ${sessionDuration(perTour)} à plat.`, distanceM: 0 }, ...flat.steps],
      });
      const by = flat.label.replace(/^Détour ?/, '');
      motif.steps = [
        ...motif.steps.slice(0, -1),
        { text: `${tours} tours en tout, chacun après le détour${by ? ` ${by}` : ''}.`, distanceM: 0 },
      ];
    }
  } else if (missing >= MIN_DETOUR_S) {
    // Au pied, avant de monter : c'est là qu'on a du plat à courir.
    let at = 1;
    for (const d of await detours(accessTo.at, missing, accessEffort, ctx, avoid, [])) {
      legs.splice(at++, 0, await detourLeg(d, accessBlock.i, ctx, toFoot));
    }
  }
  legs.push(motif);
  settle(legs, accessBlock.i, accessPrescribedS, first ? first.b.label : mb.label, notes);

  // Une descente qui remonte à pied aurait pu remonter par une boucle : si elle
  // ne tient pas dans la récupération prescrite, on dit pourquoi on n'y va pas.
  if ((mb.elevationLossM ?? 0) > 0 && mb.recovery && climbsBack(mb.recovery) && !mb.where!.back) {
    const fit = descentLoopFit(ctx.model, ctx.terrain, mb.elevationLossM!, mb.recovery.durationS);
    if (fit && !fit.fits) notes.push(loopTooLongNote(fit, mb.recovery.durationS));
  }

  // ── Le retour ────────────────────────────────────────────────────────────
  const tail = blocks.map((b, i) => ({ b, i })).filter(({ b, i }) => i > m && isRunning(b));
  const last = tail[0] ?? { b: mb, i: m };
  const tailEffort = effortOf(ctx.model, last.b);
  let from = end;
  if (tail[0]?.b.where) {
    const w = tail[0].b.where;
    legs.push(stretchLeg(tail[0].b, tail[0].i, w, w.to.role === 'haut' ? 1 : -1, tailEffort, tail[0].b.label));
    avoid.push(w.track ?? []);
    from = w.to;
  }
  const homeRoute = await ctx.services.route([from.at, home]);
  if (!homeRoute) return null;
  const homeLeg = await walkLeg(homeRoute, { label: 'Retour à la maison', block: last.i, kind: 'home' }, tailEffort, ctx, 'Tu es chez toi.');
  if (tail[0]) {
    const prescribed = tail[0].b.durationS ?? 0;
    const natural = legs.filter((l) => l.block === last.i).reduce((s, l) => s + l.durationS, 0) + homeLeg.durationS;
    const gap = prescribed - natural;
    if (gap >= MIN_DETOUR_S) {
      const back = from.role === 'pied' ? `au pied de ${mb.where!.climb}` : 'au demi-tour';
      for (const d of await detours(from.at, gap, tailEffort, ctx, [...avoid, homeRoute.track], [])) {
        legs.push(await detourLeg(d, last.i, ctx, back));
      }
    }
    legs.push(homeLeg);
    settle(legs, last.i, prescribed, tail[0].b.label, notes);
  } else {
    legs.push(homeLeg);
    notes.push(`Le retour à la maison n'est dans aucun bloc de la séance : ${sessionDuration(homeLeg.durationS)} de plus.`);
  }
  for (const { b, i } of blocks.map((b, i) => ({ b, i })).filter(({ b, i }) => i > m && !isRunning(b))) {
    legs.push(stillLeg(b, i, 'Chez toi'));
  }
  for (const { b, i } of tail.slice(1)) legs.push(stillLeg(b, i, 'Au retour'));

  return {
    basis: routeBasis(session, ctx.home, ctx.model),
    computedAt: ctx.now ?? new Date().toISOString(),
    home: ctx.home,
    legs,
    durationS: sum(legs, 'durationS'),
    distanceM: legs.reduce((s, l) => s + l.distanceM, 0),
    gainM: legs.reduce((s, l) => s + l.gainM, 0),
    lossM: legs.reduce((s, l) => s + l.lossM, 0),
    notes,
  };
}
