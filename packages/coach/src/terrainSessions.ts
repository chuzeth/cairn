import type { PlannedSession, SessionBlock } from '@cairn/core';
import { climbsBack, sessionDuration, stretchSpan } from '@cairn/core';
import * as db from '@cairn/db';
import { easyClimbRate } from '@cairn/physiology';
import { addDays } from './periodization.js';
import { onTerrain, withHistory } from './presentation.js';
import { currentModel } from './state.js';
import {
  detectClimbs, groupRecurring, homeGrounds, type ClimbOccurrence, type OutingStart, type TerrainHint,
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
  let traced = 0;
  for (const a of activities) {
    const stored = await db.getStreams(a.id);
    if (!stored) continue;
    traced++;
    const date = a.startDateLocal.slice(0, 10);
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
  return { activities, traced, climbs, outings };
}

/**
 * Ce que le planificateur sait du terrain : les montées récurrentes de l'année
 * et le départ habituel. C'est par lui qu'une séance de terrain nomme sa montée.
 */
export async function terrainHint(athleteId: string, today = iso(new Date())): Promise<TerrainHint> {
  const { climbs, outings } = await readTerrain(athleteId, addDays(today, -365), today);
  const home = homeGrounds(outings)[0]?.center;
  return { climbs: groupRecurring(climbs), ...(home ? { home } : {}) };
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
  }
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
  if (before.plannedDurationS !== after.plannedDurationS) {
    parts.push(`Séance de ${sessionDuration(before.plannedDurationS)} à ${sessionDuration(after.plannedDurationS)}.`);
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
  const laid = onTerrain(upcoming, { model, terrain, today, descentsDone: await countDescents(athleteId, today) });

  const at = new Date().toISOString();
  const changes: { date: string; before: string; after: string; reason: string }[] = [];
  for (let i = 0; i < upcoming.length; i++) {
    const before = upcoming[i]!;
    const after = laid[i]!;
    if (after === before || readable(after) === readable(before)) continue;
    const text = before.type === 'downhill' ? describeLaying(before, after, model) : '';
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
      reason: text || 'Montée désignée : du pied au haut, chaque bout ouvert sur la carte.',
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
