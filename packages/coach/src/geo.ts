import type { PlannedSession, TerrainPoint, TerrainStretch } from '@cairn/core';
import { canonicalAddress, streetKey, streetName } from '@cairn/core';
import * as db from '@cairn/db';
import { distanceToTrack, matchTrack, type OsmWay, type TrackPoint } from './ground.js';
import { HOME_GROUND_RADIUS_M, haversineM, type ClimbLoop, type RecurringClimb } from './terrain.js';

/**
 * OpenStreetMap, lu depuis Cairn.
 *
 * Trois questions, posées à trois services publics et bénévoles :
 *   - Overpass : les voies autour de la trace d'une montée, de quoi en lire le
 *     sol (`ground.ts`) ;
 *   - Nominatim : l'adresse d'un point clé d'une séance — pied, haut, demi-tour
 *     —, le nom d'une voie de l'itinéraire, un repère ;
 *   - OSRM, sur le serveur de FOSSGIS : le trajet à pied d'un point à un autre
 *     (`routing.ts`).
 *
 * Leurs règles d'usage tiennent ici : un User-Agent qui dit qui demande, une
 * requête par seconde au plus à Nominatim et à OSRM, et aucune question posée
 * deux fois — chaque réponse est gardée en base pour toujours (`geo_cache`).
 *
 * Le domicile de l'athlète ne part que vers OSRM, parce qu'il le demande : un
 * itinéraire de porte à porte commence chez lui. Nominatim et Overpass ne
 * reçoivent aucun point à moins de `HOME_PRIVACY_M` de chez lui.
 *
 * Ni clé ni compte. Un service injoignable laisse le sol inconnu : une séance
 * rapide ne se pose alors pas sur la montée, et le dit.
 */

/**
 * Rayon autour du domicile d'où aucun point ne part vers Nominatim ni Overpass,
 * m : plusieurs pâtés de maisons, pour qu'aucune question ne désigne l'immeuble.
 */
export const HOME_PRIVACY_M = 250;

/** Qui demande : l'application, pas une bibliothèque HTTP. */
export const USER_AGENT = 'Cairn/1.0 (coaching trail personnel, mono-utilisateur)';

/**
 * L'instance principale, seule : les instances de secours publiques ne répondaient
 * pas le 23/09, et chacune coûtait trente secondes d'attente par montée.
 */
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

/** Ce qu'on garde d'une voie : ce que le sol et le nom en disent. */
const KEPT_TAGS = [
  'highway', 'name', 'surface', 'step_count', 'footway', 'path', 'tracktype', 'sac_scale', 'sidewalk',
  'sidewalk:both', 'sidewalk:left', 'sidewalk:right', 'area', 'access', 'service', 'incline',
];

/** Rayon autour de la trace où l'on lit les voies, m : l'erreur du GPS, et la voie d'en face. */
const AROUND_M = 30;
/** Pas de la trace envoyée à Overpass, m : une requête courte, un corridor qui couvre la montée. */
const QUERY_STEP_M = 25;
/** Entre deux requêtes Nominatim, ms : une par seconde au plus, avec de la marge. */
const NOMINATIM_GAP_MS = 1100;

// ─────────────────────────────────────────────────────────────────────────────
// Overpass : le sol d'une montée
// ─────────────────────────────────────────────────────────────────────────────

/** La trace d'une montée, un point tous les 25 m : c'est tout ce qu'Overpass reçoit. */
export function queryTrack(profile: readonly TrackPoint[]): [number, number][] {
  const out: [number, number][] = [];
  let last = -Infinity;
  profile.forEach((p, i) => {
    if (!p.at) return;
    if (p.d - last >= QUERY_STEP_M || i === profile.length - 1) {
      out.push([p.at[0], p.at[1]]);
      last = p.d;
    }
  });
  return out;
}

/**
 * Les voies à 30 m de plusieurs traces, avec leurs nœuds, en une seule
 * requête : une relève pose une question à Overpass, pas une par montée.
 */
export function overpassQuery(tracks: readonly (readonly [number, number][])[]): string {
  const parts = tracks.map((track) => {
    const poly = track.map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join(',');
    return `way["highway"](around:${AROUND_M},${poly});`;
  });
  return `[out:json][timeout:40];(${parts.join('')});out tags geom;`;
}

/** Les voies d'une réponse d'Overpass, réduites à ce qu'on en lit. */
export function waysFromOverpass(json: unknown): OsmWay[] {
  const elements = (json as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) throw new Error('Overpass : réponse sans éléments.');
  return elements.flatMap((e): OsmWay[] => {
    const el = e as {
      type?: string; id?: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[];
    };
    if (el.type !== 'way' || typeof el.id !== 'number' || !el.tags?.highway || !Array.isArray(el.geometry)) return [];
    const tags: Record<string, string> = {};
    for (const k of KEPT_TAGS) if (el.tags[k] != null) tags[k] = el.tags[k]!;
    return [{ id: el.id, tags, geometry: el.geometry.map((g) => [g.lat, g.lon] as [number, number]) }];
  });
}

/** Les voies d'une réponse groupée qui passent à portée d'une trace : ce que la montée garde. */
export function waysNear(ways: readonly OsmWay[], track: readonly [number, number][]): OsmWay[] {
  return ways.filter((w) =>
    track.some((p) => distanceToTrack(p, w.geometry) <= AROUND_M + QUERY_STEP_M / 2),
  );
}

/**
 * Après un échec, Overpass n'est plus sollicité avant cet instant, ms : une
 * instance saturée ne se désature pas en insistant, et la relève suivante —
 * un quart d'heure plus tard — reposera la question.
 */
let overpassRestsUntil = 0;
const OVERPASS_REST_MS = 15 * 60_000;

/** Une requête à la fois : l'instance publique limite les requêtes simultanées. */
let overpassChain: Promise<unknown> = Promise.resolve();

/**
 * Une instance qui refuse pour la charge — 429, trop de requêtes de cette
 * adresse ; 504, trop de requêtes tout court — libère une place en quelques
 * secondes : on repose la question une fois, pas davantage.
 */
const OVERPASS_RETRY_MS = 10_000;

async function overpass(query: string): Promise<OsmWay[] | null> {
  const run = overpassChain.then(async () => {
    if (Date.now() < overpassRestsUntil) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      let status: number | string;
      try {
        const res = await fetch(OVERPASS, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(45_000),
        });
        if (res.ok) return waysFromOverpass(await res.json());
        status = res.status;
      } catch (e) {
        // Injoignable, trop lente ou illisible : la même chose pour nous.
        status = e instanceof Error ? e.name : String(e);
      }
      console.warn(`Overpass : ${status}${attempt === 0 && (status === 429 || status === 504) ? ', nouvel essai dans 10 s' : ''}.`);
      if (attempt > 0 || (status !== 429 && status !== 504)) break;
      await new Promise((resolve) => setTimeout(resolve, OVERPASS_RETRY_MS));
    }
    overpassRestsUntil = Date.now() + OVERPASS_REST_MS;
    return null;
  });
  overpassChain = run.catch(() => null);
  return run;
}

/** Une autre trace, une autre question : la clé est le passage lui-même. */
const passageKey = (c: RecurringClimb) =>
  `osm-ways:v1:${c.latest.activityId}:${c.latest.startIndex}-${c.latest.endIndex}`;

/** Une montée qu'une séance peut désigner : courue deux fois, près du départ habituel. */
const designable = (c: RecurringClimb, home?: readonly [number, number]) =>
  c.outings >= 2 &&
  c.latest.top != null &&
  c.latest.profile.length >= 2 &&
  (!home || haversineM(home, c.start) <= HOME_GROUND_RADIUS_M);

/**
 * Les montées, munies du sol de leur chemin — celles, seulement, qu'une séance
 * peut désigner. Une montée lointaine ne vaut pas une question à Overpass.
 *
 * Ce qui a déjà été lu sort de la base ; le reste part en une requête, et chaque
 * montée garde les voies de sa trace. Une montée qu'Overpass n'a pas pu lire
 * porte `ground: null` : son sol est inconnu, et le reste jusqu'à la relève
 * suivante.
 */
export async function withGround(
  climbs: readonly RecurringClimb[],
  home?: readonly [number, number],
): Promise<RecurringClimb[]> {
  const read = new Map<RecurringClimb, { ways: OsmWay[]; readAt: string }>();
  const missing: RecurringClimb[] = [];
  for (const c of climbs) {
    if (!designable(c, home)) continue;
    const cached = await db.getGeo<{ ways: OsmWay[] }>(passageKey(c));
    if (cached) read.set(c, { ways: cached.value.ways, readAt: cached.fetchedAt });
    else missing.push(c);
  }
  const tracks = missing.map((c) => queryTrack(c.latest.profile)).filter((t) => t.length >= 2);
  if (tracks.length > 0) {
    const ways = await overpass(overpassQuery(tracks));
    if (ways) {
      const readAt = new Date().toISOString();
      for (const c of missing) {
        const own = waysNear(ways, queryTrack(c.latest.profile));
        await db.putGeo(passageKey(c), { ways: own }, readAt);
        read.set(c, { ways: own, readAt });
      }
    }
  }
  return climbs.map((c) => {
    if (!designable(c, home)) return c;
    const r = read.get(c);
    return { ...c, ground: r ? matchTrack(c.latest.profile, r.ways, r.readAt) : null };
  });
}

/** Le raccord d'une boucle, lu comme un passage : la clé est le morceau de trace lui-même. */
const crossingKey = (l: ClimbLoop) => `osm-ways:v1:${l.over.activityId}:${l.over.startIndex}-${l.over.endIndex}`;

/**
 * Les boucles, munies du sol du chemin qui relie leurs hauts — lu sur
 * OpenStreetMap comme celui d'une montée, en une requête pour tous ceux qui
 * manquent. Un raccord qu'Overpass n'a pas pu lire porte `ground: null`, et sa
 * boucle ne se court pas en descendant (`loopRefusal`).
 */
export async function withLoopGround(loops: readonly ClimbLoop[]): Promise<ClimbLoop[]> {
  const read = new Map<string, { ways: OsmWay[]; readAt: string }>();
  const missing: ClimbLoop[] = [];
  for (const l of loops) {
    const key = crossingKey(l);
    if (read.has(key) || missing.some((m) => crossingKey(m) === key)) continue;
    const cached = await db.getGeo<{ ways: OsmWay[] }>(key);
    if (cached) read.set(key, { ways: cached.value.ways, readAt: cached.fetchedAt });
    else missing.push(l);
  }
  const tracks = missing.map((l) => queryTrack(l.over.profile)).filter((t) => t.length >= 2);
  if (tracks.length > 0) {
    const ways = await overpass(overpassQuery(tracks));
    if (ways) {
      const readAt = new Date().toISOString();
      for (const l of missing) {
        const own = waysNear(ways, queryTrack(l.over.profile));
        await db.putGeo(crossingKey(l), { ways: own }, readAt);
        read.set(crossingKey(l), { ways: own, readAt });
      }
    }
  }
  return loops.map((l) => {
    const r = read.get(crossingKey(l));
    return { ...l, over: { ...l.over, ground: r ? matchTrack(l.over.profile, r.ways, r.readAt) : null } };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Nominatim : l'adresse d'un point
// ─────────────────────────────────────────────────────────────────────────────

/** Ce qu'on garde d'une réponse Nominatim. */
export interface NominatimHit {
  road?: string;
  houseNumber?: string;
}

/** La voie et le numéro d'une réponse Nominatim. */
export function hitFrom(json: unknown): NominatimHit {
  const j = json as { address?: Record<string, string>; category?: string; name?: string };
  const a = j.address ?? {};
  const road =
    a.road ?? a.pedestrian ?? a.footway ?? a.path ?? a.cycleway ?? a.square ?? a.steps ??
    (j.category === 'highway' ? j.name : undefined);
  return { ...(road ? { road } : {}), ...(a.house_number ? { houseNumber: a.house_number } : {}) };
}

/**
 * L'adresse lisible d'un point : la voie où il est (zoom 17, la voie la plus
 * proche) et le numéro de la maison (zoom 18) quand elle donne sur cette voie.
 * Le bâtiment le plus proche peut être sur la rue d'à côté — « Lycée Aux
 * Lazaristes, montée du Garillan » pour un point de la montée
 * Saint-Barthélémy — : son numéro ne situerait rien.
 */
export function addressFrom(street: NominatimHit | null, house: NominatimHit | null): string | null {
  const road = street?.road ?? house?.road;
  if (!road) return null;
  const onRoad = house?.road != null && streetKey(house.road) === streetKey(road);
  const number = onRoad ? house.houseNumber?.split(/[;,]/)[0]?.trim() : undefined;
  return number ? `${number} ${streetName(road)}` : streetName(road);
}

/** La prochaine requête Nominatim ne part pas avant cet instant, ms. */
let nominatimAt = 0;

async function nominatimSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nominatimAt);
  nominatimAt = at + NOMINATIM_GAP_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

async function reverse(at: readonly [number, number], zoom: 17 | 18): Promise<NominatimHit | null> {
  const key = `nominatim:v1:${zoom}:${at[0].toFixed(5)},${at[1].toFixed(5)}`;
  const cached = await db.getGeo<NominatimHit>(key);
  if (cached) return cached.value;
  await nominatimSlot();
  try {
    const url =
      `${NOMINATIM}?format=jsonv2&lat=${at[0].toFixed(6)}&lon=${at[1].toFixed(6)}&zoom=${zoom}` +
      `&addressdetails=1&accept-language=fr`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const hit = hitFrom(await res.json());
    await db.putGeo(key, hit);
    return hit;
  } catch {
    return null;
  }
}

/** L'adresse d'un point d'une montée, ou `null` quand Nominatim ne la donne pas. */
export async function addressOf(at: readonly [number, number]): Promise<string | null> {
  const street = await reverse(at, 17);
  const house = await reverse(at, 18);
  return addressFrom(street, house);
}

/** Le point est-il assez loin du domicile pour partir vers Nominatim ou Overpass ? */
export const awayFromHome = (at: readonly [number, number], home: readonly [number, number] | null | undefined) =>
  !home || haversineM(at, home) >= HOME_PRIVACY_M;

/**
 * La voie où passe un point de l'itinéraire, par géocodage inverse — `null` à
 * moins de `HOME_PRIVACY_M` du domicile : ce point-là ne part pas.
 */
export async function roadAt(
  at: readonly [number, number],
  home: readonly [number, number] | null | undefined,
): Promise<string | null> {
  if (!awayFromHome(at, home)) return null;
  const hit = await reverse(at, 17);
  return hit?.road ? streetName(hit.road) : null;
}

/** Un repère : un lieu qu'on reconnaît en courant, et sa distance au point, m. */
export interface Landmark {
  name: string;
  /** Ce que c'est, pour OpenStreetMap : `man_made/tower`, `amenity/courthouse`… */
  kind: string;
  distanceM: number;
}

/**
 * Ce qui fait un repère : un pont, un monument, un bâtiment public, une gare,
 * un parc. Un restaurant ou un parking change d'enseigne ou ne se voit pas ;
 * une poubelle n'est pas un lieu.
 */
const LANDMARK_KINDS = new Set([
  'amenity/courthouse', 'amenity/place_of_worship', 'amenity/townhall', 'amenity/theatre', 'amenity/library',
  'amenity/university', 'amenity/college', 'amenity/school', 'amenity/hospital', 'amenity/fountain',
  'amenity/arts_centre', 'amenity/cinema', 'man_made/tower', 'man_made/bridge', 'man_made/lighthouse',
  'railway/station', 'railway/halt', 'railway/funicular', 'leisure/park', 'leisure/garden', 'leisure/stadium',
  'tourism/museum', 'tourism/attraction', 'tourism/viewpoint', 'historic/monument', 'historic/memorial',
  'historic/church', 'historic/castle', 'historic/building', 'building/church', 'building/cathedral',
  'place/square',
]);
/** Au-delà, le repère n'est plus au point : on ne le voit pas en y passant, m. */
const LANDMARK_REACH_M = 45;

/** Le repère d'une réponse Nominatim, s'il en est un. */
export function landmarkFrom(json: unknown, at: readonly [number, number]): Landmark | null {
  const j = json as { category?: string; type?: string; name?: string; lat?: string; lon?: string };
  const kind = `${j.category}/${j.type}`;
  if (!j.name || !LANDMARK_KINDS.has(kind) || j.lat == null || j.lon == null) return null;
  const distanceM = Math.round(haversineM(at, [Number(j.lat), Number(j.lon)]));
  return distanceM <= LANDMARK_REACH_M ? { name: j.name, kind, distanceM } : null;
}

/** Le repère le plus proche d'un point de l'itinéraire, s'il en est un — jamais près du domicile. */
export async function landmarkAt(
  at: readonly [number, number],
  home: readonly [number, number] | null | undefined,
): Promise<Landmark | null> {
  if (!awayFromHome(at, home)) return null;
  const key = `nominatim-poi:v1:${at[0].toFixed(5)},${at[1].toFixed(5)}`;
  const cached = await db.getGeo<{ landmark: Landmark | null }>(key);
  if (cached) return cached.value.landmark;
  await nominatimSlot();
  try {
    const url =
      `${NOMINATIM}?format=jsonv2&lat=${at[0].toFixed(6)}&lon=${at[1].toFixed(6)}&zoom=18&layer=poi` +
      `&accept-language=fr`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const landmark = landmarkFrom(await res.json(), at);
    await db.putGeo(key, { landmark });
    return landmark;
  } catch {
    return null;
  }
}

/** Le point, muni de son adresse, écrite comme le tronçon écrit déjà ses voies. */
async function addressed(p: TerrainPoint, w: TerrainStretch): Promise<TerrainPoint> {
  if (p.address) return p;
  const address = await addressOf(p.at);
  if (!address) return p;
  const names = [...(w.streets ?? []), w.climb.replace(/^(?:la |le |les |l')/, '')];
  return { ...p, address: canonicalAddress(address, names) };
}

/**
 * Les séances, chaque bout de leurs tronçons muni de son adresse. Seuls les
 * points des tronçons partent vers Nominatim ; un point déjà adressé ne repart
 * pas, et une adresse déjà obtenue sort de la base.
 */
export async function withAddresses<S extends Pick<PlannedSession, 'blocks'>>(sessions: readonly S[]): Promise<S[]> {
  const out: S[] = [];
  for (const s of sessions) {
    if (!s.blocks.some((b) => b.where && (!b.where.from.address || !b.where.to.address))) {
      out.push(s);
      continue;
    }
    const blocks = [];
    for (const b of s.blocks) {
      const w = b.where;
      blocks.push(w ? { ...b, where: { ...w, from: await addressed(w.from, w), to: await addressed(w.to, w) } } : b);
    }
    out.push({ ...s, blocks });
  }
  return out;
}
