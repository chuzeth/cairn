import type { PlannedSession, SessionBlock } from '@cairn/core';
import { climbsBack, sessionDuration, stretchSpan, viaStreets } from '@cairn/core';
import * as db from '@cairn/db';
import { easyClimbRate } from '@cairn/physiology';
import { altitudeIndex } from './altitude.js';
import { withAddresses, withGround, withLoopGround } from './geo.js';
import { OSM_SERVICES, buildRoute, routeBasis, type RouteServices } from './itinerary.js';
import { addDays } from './periodization.js';
import { onTerrain, withHistory } from './presentation.js';
import { currentModel } from './state.js';
import {
  detectClimbs, findLoops, groupRecurring, homeGrounds, lightTrace, type ClimbOccurrence, type LightTrace,
  type OutingStart, type TerrainHint,
} from './terrain.js';

/**
 * Le terrain lu dans la base, et les séances à venir posées dessus.
 *
 * Une séance de terrain se prescrit sur une montée réelle de l'athlète. Le
 * planificateur le fait en écrivant ; une séance déjà écrite, elle, le devient
 * à la relève, sans reconstruction : la même fonction (`onTerrain`) pose la
 * descente sur sa montée, chronomètre sa remontée à la marche, et la première
 * dit ce qu'elle doit ménager. Ce qui change s'écrit dans l'historique de la
 * séance et le journal du plan ; une séance déjà posée ne change plus.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Lit le terrain dans les traces.
 *
 * Seul endroit qui décompresse les flux pour y chercher autre chose que de la
 * physiologie. Une soixantaine de traces se lisent en quelques centaines de
 * millisecondes : à ce prix-là, rien ne justifie d'en garder une copie qui
 * pourrait vieillir à côté des flux.
 */
export async function readTerrain(athleteId: string, from: string, to: string) {
  const activities = await db.listActivities(athleteId, { from, to, limit: 500 });
  const climbs: ClimbOccurrence[] = [];
  const outings: OutingStart[] = [];
  const traces: LightTrace[] = [];
  let traced = 0;
  for (const a of activities) {
    const stored = await db.getStreams(a.id);
    if (!stored) continue;
    traced++;
    const date = a.startDateLocal.slice(0, 10);
    traces.push(lightTrace(a.id, date, stored.streams));
    const start = stored.streams.latlng?.find((p) => p != null);
    if (start) {
      outings.push({
        activityId: a.id,
        date,
        start: [start[0], start[1]],
        elevationGainM: a.totalElevationGainM,
      });
    }
    for (const c of detectClimbs(stored.streams)) {
      climbs.push({ ...c, activityId: a.id, activityName: a.name, date });
    }
  }
  return { activities, traced, climbs, outings, traces };
}

/**
 * Ce que le planificateur sait du terrain : les montées récurrentes de l'année,
 * le sol de celles qu'une séance peut désigner — lu sur OpenStreetMap, gardé en
 * base —, les boucles qu'elles forment, et le départ habituel. C'est par lui
 * qu'une séance de terrain nomme sa montée, qu'une séance rapide évite ses
 * marches, et qu'une rando-course monte par l'une et redescend par l'autre.
 */
export async function terrainHint(athleteId: string, today = iso(new Date())): Promise<TerrainHint> {
  return (await terrainAndTraces(athleteId, today)).terrain;
}

/** Le terrain, et les traces allégées d'où il vient — ce dont l'itinéraire lit le relief. */
export async function terrainAndTraces(
  athleteId: string,
  today = iso(new Date()),
): Promise<{ terrain: TerrainHint; traces: LightTrace[] }> {
  const { climbs, outings, traces } = await readTerrain(athleteId, addDays(today, -365), today);
  const home = homeGrounds(outings)[0]?.center;
  const grounded = await withGround(groupRecurring(climbs), home);
  const loops = await withLoopGround(findLoops(grounded, traces, home));
  return {
    terrain: { climbs: grounded, ...(loops.length > 0 ? { loops } : {}), ...(home ? { home } : {}) },
    traces,
  };
}

/** Séances de descente faites jusqu'à `today` : sans aucune, la prochaine est une première. */
export async function countDescents(athleteId: string, today: string): Promise<number> {
  return (await db.listPlannedSessions(athleteId, addDays(today, -400), today)).filter(
    (s) => s.type === 'downhill' && (s.status === 'completed' || s.status === 'partial'),
  ).length;
}

/** Horizon des séances posées : au-delà, le plan sera reconstruit avant qu'on y arrive. */
const HORIZON_DAYS = 120;

const TERRAIN_TYPES = new Set(['downhill', 'long_trail']);

/** Ce qui se lit d'une séance : si rien n'en change, elle ne s'écrit pas. */
const readable = (s: PlannedSession) =>
  JSON.stringify([
    s.title, s.intent, s.blocks, s.plannedDurationS, s.plannedLoad, s.plannedMechanicalLoad,
    s.plannedElevationGainM ?? null, s.plannedDistanceM ?? null, s.rationale ?? null, s.history ?? null,
  ]);

const repOf = (s: PlannedSession): SessionBlock | undefined =>
  s.blocks.find((b) => (b.elevationLossM ?? 0) > 0 && climbsBack(b.recovery));

/** Ce que la séance dit des montées écartées pour leurs marches (`skippedNote`), s'il y en a. */
const skippedOf = (b?: SessionBlock): string =>
  b?.notes?.match(/(?:Pas sur |Aucune de tes montées |Le sol de tes montées )[^:]*:[^.]*\./)?.[0] ?? '';

/**
 * Ce que la pose a changé à une descente, en clair : où elle se court, ce que
 * dure la remontée et pourquoi, ce que dure la séance.
 */
function describeLaying(before: PlannedSession, after: PlannedSession, model: Parameters<typeof easyClimbRate>[0]): string {
  const was = repOf(before);
  const now = repOf(after);
  const parts: string[] = [];
  if (now?.where && JSON.stringify(now.where) !== JSON.stringify(was?.where)) {
    parts.push(`Posée sur ${now.where.climb} : ${stretchSpan(now.where)}.`);
    if (was?.where && was.where.climb !== now.where.climb && skippedOf(now)) parts.push(skippedOf(now));
  }
  if (was?.where && !now?.where) parts.push(`Plus posée sur une montée. ${skippedOf(now)}`.trim());
  const gain = now?.recovery?.elevationGainM ?? 0;
  if (was?.recovery && now?.recovery && gain > 0 && was.recovery.durationS !== now.recovery.durationS) {
    const rate = Math.round(easyClimbRate(model, now.where?.grade ?? 0.15).vamMh);
    const asked = Math.round((gain / was.recovery.durationS) * 3600);
    parts.push(
      `Remontée de ${sessionDuration(was.recovery.durationS)} à ${sessionDuration(now.recovery.durationS)}, en ` +
        `marchant : ${gain} m à ${rate} m/h, la marche facile que ton modèle donne sur cette pente — ` +
        `${sessionDuration(was.recovery.durationS)} en demandaient ${asked} m/h.`,
    );
  }
  if (was && !was.effort && now?.effort) {
    parts.push('La descente se pilote à l\'effort et à la technique, plus à la FC ni à une allure à plat.');
  }
  // L'accès n'était compté nulle part : l'échauffement monte au haut, et la
  // dernière descente rentre par le bas au lieu de remonter.
  const up = after.blocks[0]?.elevationGainM ?? 0;
  const down = after.blocks[after.blocks.length - 1]?.elevationLossM ?? 0;
  if (up > 0 && down > 0 && (before.blocks[0]?.elevationGainM ?? 0) === 0) {
    parts.push(
      `L'accès compte, maintenant : ${up} m pour rejoindre le haut, et ${down} m par le bas de la montée ` +
        `pour rentrer après la dernière descente, que tu ne remontes pas. ` +
        `${after.plannedElevationGainM ?? up} m dans chaque sens, au lieu de ${before.plannedElevationGainM ?? 0}.`,
    );
  }
  if (before.plannedDurationS !== after.plannedDurationS) {
    parts.push(`Séance de ${sessionDuration(before.plannedDurationS)} à ${sessionDuration(after.plannedDurationS)}.`);
  }
  return parts.join(' ');
}

/**
 * Ce que la pose a changé à une rando-course, en clair : la montée où elle se
 * court, celle qu'elle évite pour ses marches, et ce qu'elle pèse.
 */
function describeTrail(before: PlannedSession, after: PlannedSession): string {
  const was = before.blocks.find((b) => b.where)?.where;
  const trail = after.blocks.find((b) => b.where) ?? after.blocks[0];
  const now = trail?.where;
  const parts: string[] = [];
  if (now?.back && now.back.climb !== was?.back?.climb) {
    parts.push(`Posée en boucle : tu montes par ${now.climb}, tu redescends par ${viaStreets(now.back)}.`);
  } else if (now && now.climb !== was?.climb) parts.push(`Posée sur ${now.climb}.`);
  if (was?.back && now && !now.back) parts.push(`Plus en boucle : tu redescends par ${now.climb}.`);
  if (was && !now) parts.push(`Plus posée sur ${was.climb}.`);
  if (was?.climb !== now?.climb && skippedOf(trail)) parts.push(skippedOf(trail));
  if (before.plannedLoad !== after.plannedLoad) {
    parts.push(`Charge de ${before.plannedLoad} à ${after.plannedLoad} points, remesurée avec le modèle du jour.`);
  }
  return parts.join(' ');
}

/**
 * Pose les séances de terrain à venir sur les montées de l'athlète, et écrit ce
 * qui a changé. Rend les changements, tels que le journal du plan les garde.
 */
export async function layPlanOnTerrain(
  athleteId: string,
  today = iso(new Date()),
): Promise<{ date: string; before: string; after: string; reason: string }[]> {
  const plan = await db.getActivePlan(athleteId);
  if (!plan) return [];
  const upcoming = await db.listPlannedSessions(athleteId, today, addDays(today, HORIZON_DAYS));
  if (!upcoming.some((s) => TERRAIN_TYPES.has(s.type) && s.status === 'planned')) return [];

  const model = await currentModel(athleteId);
  const terrain = await terrainHint(athleteId, today);
  // Les adresses des bouts de chaque tronçon, avant de comparer : une séance
  // qu'on vient de poser se compare à celle qu'on a écrite, adresses comprises.
  const laid = await withAddresses(
    onTerrain(upcoming, { model, terrain, today, descentsDone: await countDescents(athleteId, today) }),
  );

  const at = new Date().toISOString();
  const changes: { date: string; before: string; after: string; reason: string }[] = [];
  for (let i = 0; i < upcoming.length; i++) {
    const before = upcoming[i]!;
    const after = laid[i]!;
    if (after === before || readable(after) === readable(before)) continue;
    const text =
      before.type === 'downhill'
        ? describeLaying(before, after, model)
        : before.type === 'long_trail'
          ? describeTrail(before, after)
          : '';
    const history = text ? withHistory(after.history, { at, by: 'planner', text }) : after.history;
    await db.updateSession(before.id, {
      title: after.title,
      intent: after.intent,
      blocks: after.blocks,
      plannedDurationS: after.plannedDurationS,
      plannedLoad: after.plannedLoad,
      plannedMechanicalLoad: after.plannedMechanicalLoad,
      plannedElevationGainM: after.plannedElevationGainM ?? null,
      plannedDistanceM: after.plannedDistanceM ?? null,
      rationale: after.rationale ?? null,
      history: history?.length ? history : null,
      ...(after.decision ? { decision: after.decision } : {}),
    } as never);
    changes.push({
      date: before.date,
      before: before.title,
      after: after.title,
      reason: text || 'Montée nommée par sa voie, son sol et ses adresses lus sur OpenStreetMap, son tracé sur la carte.',
    });
  }

  if (changes.length > 0) {
    await db.appendPlanRevision(plan.plan.id, {
      at,
      trigger: 'terrain',
      summary: `${changes.length} séance(s) de terrain posée(s) sur tes montées, sans reconstruction.`,
      changes,
    });
  }
  return changes;
}

/** Horizon des itinéraires, jours : une séance plus lointaine sera reposée d'ici là, et son itinéraire refait. */
const ROUTE_HORIZON_DAYS = 14;

/**
 * Les itinéraires de porte à porte des séances de terrain à venir.
 *
 * Seuls se refont ceux dont la base a changé — domicile, blocs, allures — :
 * un itinéraire à jour ne repose aucune question, et chaque réponse d'OSRM ou
 * de Nominatim est déjà en base. Sans domicile, rien : Cairn ne devine pas où
 * l'athlète habite. Un moteur d'itinéraire injoignable laisse l'ancien
 * itinéraire en base, que sa base périmée tient hors de l'écran.
 */
export async function routeUpcoming(
  athleteId: string,
  today = iso(new Date()),
  services: RouteServices = OSM_SERVICES,
): Promise<{ date: string; built: boolean }[]> {
  const home = await db.getHome(athleteId);
  if (!home) return [];
  await db.purgeSessionRoutes();
  const sessions = (await db.listPlannedSessions(athleteId, today, addDays(today, ROUTE_HORIZON_DAYS))).filter(
    (s) => s.status === 'planned' && s.blocks.some((b) => b.where),
  );
  if (sessions.length === 0) return [];
  const model = await currentModel(athleteId);
  const stored = await db.getSessionRoutes(sessions.map((s) => s.id));
  const stale = sessions.filter((s) => stored.get(s.id)?.basis !== routeBasis(s, home, model));
  if (stale.length === 0) return [];
  const { terrain, traces } = await terrainAndTraces(athleteId, today);
  const altitude = altitudeIndex(traces);
  const out: { date: string; built: boolean }[] = [];
  for (const s of stale) {
    const route = await buildRoute(s, { home, model, altitude, terrain, traces, services });
    if (route) await db.putSessionRoute(s.id, route);
    out.push({ date: s.date, built: route != null });
  }
  return out;
}
