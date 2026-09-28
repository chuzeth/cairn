import * as db from '@cairn/db';
import { USER_AGENT } from './geo.js';

/**
 * Le trajet à pied, demandé à un moteur d'itinéraire.
 *
 * OSRM, profil piéton, sur le serveur de FOSSGIS : il calcule sur les voies
 * d'OpenStreetMap le chemin d'un point à un autre, sa longueur, et chaque
 * manœuvre — « tourne à gauche », « au bout, à droite » — avec le nom de la
 * voie quand elle en a un. C'est lui qui trace l'accès, le retour et les
 * détours d'un itinéraire : jamais un modèle de langage.
 *
 * Ses règles d'usage : un User-Agent valide, une requête par seconde au plus,
 * pas d'usage massif, et l'attribution. Chaque réponse est gardée en base pour
 * toujours (`geo_cache`) : un même trajet ne se redemande pas. C'est le seul
 * service qui reçoive le domicile de l'athlète, parce qu'il le demande.
 */

const OSRM = 'https://routing.openstreetmap.de/routed-foot';
/** Entre deux requêtes, ms : une par seconde au plus, avec de la marge. */
const OSRM_GAP_MS = 1100;

/** Une manœuvre du trajet, et la portion qui la suit jusqu'à la suivante. */
export interface FootStep {
  distanceM: number;
  /** Le nom de la voie, tel qu'OpenStreetMap le porte ; vide pour un trottoir ou une passerelle sans nom. */
  name: string;
  /** `depart`, `turn`, `new name`, `continue`, `end of road`, `fork`, `roundabout`, `arrive`… */
  type: string;
  /** `left`, `slight right`, `straight`, `uturn`… */
  modifier?: string;
  /** Sortie d'un rond-point. */
  exit?: number;
  /** Où la manœuvre a lieu. */
  at: [number, number];
  /** La portion, du point de manœuvre au suivant. */
  track: [number, number][];
}

/** Un trajet à pied : sa longueur, son tracé, ses manœuvres. */
export interface FootRoute {
  distanceM: number;
  track: [number, number][];
  steps: FootStep[];
}

const latLng = (c: unknown): [number, number] => {
  const [lng, lat] = c as [number, number];
  return [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6];
};

/** Le trajet d'une réponse OSRM, réduit à ce qu'on en lit ; `null` si elle n'en porte pas. */
export function footRouteFrom(json: unknown): FootRoute | null {
  const j = json as {
    code?: string;
    routes?: {
      distance: number;
      geometry: { coordinates: unknown[] };
      legs: {
        steps: {
          distance: number;
          name?: string;
          geometry: { coordinates: unknown[] };
          maneuver: { type: string; modifier?: string; exit?: number; location: unknown };
        }[];
      }[];
    }[];
  };
  const r = j?.routes?.[0];
  if (j?.code !== 'Ok' || !r) return null;
  const steps: FootStep[] = [];
  r.legs.forEach((leg, li) => {
    for (const s of leg.steps) {
      // Un point de passage n'est ni une arrivée ni un départ : on y continue.
      if (s.maneuver.type === 'arrive' && li < r.legs.length - 1) continue;
      const type = s.maneuver.type === 'depart' && li > 0 ? 'continue' : s.maneuver.type;
      steps.push({
        distanceM: Math.round(s.distance * 10) / 10,
        name: s.name ?? '',
        type,
        ...(s.maneuver.modifier ? { modifier: s.maneuver.modifier } : {}),
        ...(s.maneuver.exit ? { exit: s.maneuver.exit } : {}),
        at: latLng(s.maneuver.location),
        track: s.geometry.coordinates.map(latLng),
      });
    }
  });
  return { distanceM: Math.round(r.distance * 10) / 10, track: r.geometry.coordinates.map(latLng), steps };
}

/** Les distances à pied d'un point vers plusieurs autres, m ; `null` pour un point injoignable. */
export function tableFrom(json: unknown): (number | null)[] | null {
  const j = json as { code?: string; distances?: (number | null)[][] };
  const row = j?.code === 'Ok' ? j.distances?.[0] : undefined;
  return row ? row.slice(1).map((d) => (d == null ? null : Math.round(d))) : null;
}

const coords = (points: readonly (readonly [number, number])[]) =>
  points.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';');

/** La prochaine requête ne part pas avant cet instant, ms. */
let osrmAt = 0;

async function osrmSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, osrmAt);
  osrmAt = at + OSRM_GAP_MS;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

/**
 * Une question à OSRM, gardée en base. L'adresse de la requête porte des
 * coordonnées — parfois celles du domicile — : elle n'est jamais écrite dans un
 * journal.
 */
async function ask<T>(key: string, url: string, read: (json: unknown) => T | null): Promise<T | null> {
  const cached = await db.getGeo<{ value: T | null }>(key);
  if (cached) return cached.value.value;
  await osrmSlot();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.warn(`OSRM : ${res.status}.`);
      return null;
    }
    const value = read(await res.json());
    // Un trajet introuvable l'est encore demain : la réponse se garde comme une autre.
    await db.putGeo(key, { value });
    return value;
  } catch (e) {
    console.warn(`OSRM : ${e instanceof Error ? e.name : 'injoignable'}.`);
    return null;
  }
}

/** Le trajet à pied qui passe par ces points, dans l'ordre. */
export async function footRoute(points: readonly (readonly [number, number])[]): Promise<FootRoute | null> {
  if (points.length < 2) return null;
  const c = coords(points);
  return ask(
    `osrm-foot:v1:route:${c}`,
    `${OSRM}/route/v1/foot/${c}?overview=full&geometries=geojson&steps=true`,
    footRouteFrom,
  );
}

/** Les distances à pied depuis `from` vers chacun de `to`, en une requête. */
export async function footTable(
  from: readonly [number, number],
  to: readonly (readonly [number, number])[],
): Promise<(number | null)[] | null> {
  if (to.length === 0) return [];
  const c = coords([from, ...to]);
  return ask(`osrm-foot:v1:table:${c}`, `${OSRM}/table/v1/foot/${c}?sources=0&annotations=distance`, tableFrom);
}
