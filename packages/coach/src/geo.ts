import type { PlannedSession, TerrainPoint, TerrainStretch } from '@cairn/core';
import { canonicalAddress, streetKey, streetName } from '@cairn/core';
import * as db from '@cairn/db';
import { distanceToTrack, matchTrack, type OsmWay, type TrackPoint } from './ground.js';
import { HOME_GROUND_RADIUS_M, haversineM, type RecurringClimb } from './terrain.js';

/**
 * OpenStreetMap, lu depuis Cairn.
 *
 * Deux questions, posées à deux services publics et bénévoles :
 *   - Overpass : les voies autour de la trace d'une montée, de quoi en lire le
 *     sol (`ground.ts`) ;
 *   - Nominatim : l'adresse d'un point clé d'une séance — pied, haut, demi-tour.
 *
 * Leurs règles d'usage tiennent ici : un User-Agent qui dit qui demande, une
 * requête Nominatim par seconde au plus, et aucune question posée deux fois —
 * chaque réponse est gardée en base pour toujours (`geo_cache`). On n'envoie
 * que des points des montées, jamais le domicile de l'athlète : son départ
 * habituel sert à choisir les montées proches, il ne quitte pas ce processus.
 *
 * Ni clé ni compte. Un service injoignable laisse le sol inconnu : une séance
 * rapide ne se pose alors pas sur la montée, et le dit.
 */

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
