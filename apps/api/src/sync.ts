import type { Activity, PhysiologyModel } from '@cairn/core';
import * as db from '@cairn/db';
import {
  analyzeAndStore, applyAdjustments, describeAdjustments, evaluateAdjustments,
  generateActivityInsight, loadAthleteState, rebuildPhysiologyModel, rematchRecent, type AthleteState,
} from '@cairn/coach';
import { StravaClient, StravaRateLimitError, ingestStreams, isRunLike, mapActivity } from '@cairn/strava';
import { env } from './env.js';

/**
 * Pipeline d'ingestion.
 *
 * C'est la chaîne qui se déclenche à chaque nouvelle séance Strava :
 *
 *   flux bruts → normalisation 1 Hz → stockage → ré-estimation du modèle
 *   physiologique → analyse quantitative → ajustement automatique du plan
 *   → analyse rédigée
 *
 * Chaque étape est indépendante et tolérante : si la rédaction échoue (quota
 * Anthropic, réseau), les chiffres sont déjà en base et consultables. Rien de
 * ce qui est calculé ne dépend du modèle de langage.
 */

export function stravaClientFor(athleteId: string): StravaClient {
  return new StravaClient({
    async get() {
      const t = await db.getStravaTokens(athleteId);
      return t ? { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt } : null;
    },
    async set(tokens) {
      const existing = await db.getStravaTokens(athleteId);
      await db.saveStravaTokens(athleteId, {
        ...tokens,
        stravaAthleteId: tokens.stravaAthleteId || existing?.stravaAthleteId || 0,
      });
    },
  });
}

/** Les règles de charge sur le plan, de deux semaines en arrière à trois devant. */
async function adjustPlan(
  athleteId: string,
  state: AthleteState,
): Promise<{ adjustmentCount: number; adjustmentSummary?: string }> {
  if (!state.plan) return { adjustmentCount: 0 };
  const horizonFrom = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const horizonTo = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const upcoming = await db.listPlannedSessions(athleteId, horizonFrom, horizonTo);
  const adjustments = evaluateAdjustments(state, upcoming);
  const adjustmentCount = await applyAdjustments(athleteId, adjustments, 'new_activity');
  return adjustmentCount > 0 ? { adjustmentCount, adjustmentSummary: describeAdjustments(adjustments) } : { adjustmentCount };
}

export interface IngestResult {
  activityId: string;
  name: string;
  analyzed: boolean;
  insightId?: string;
  adjustments: number;
  adjustmentSummary?: string;
  warnings: string[];
}

/**
 * Ingère une activité Strava et met tout le système à jour.
 * `withInsight: false` permet de traiter un backfill sans consommer de quota LLM.
 */
export async function ingestActivity(
  athleteId: string,
  stravaId: number,
  opts: { withInsight?: boolean; rebuildModel?: boolean } = {},
): Promise<IngestResult> {
  const client = stravaClientFor(athleteId);
  const warnings: string[] = [];

  const detail = await client.getActivity(stravaId);

  // ── Flux ──────────────────────────────────────────────────────────────────
  let streams = null;
  let elevationLossM: number | undefined;
  let gpsQuality = 'none';
  let hrCoverage = 0;

  try {
    const raw = await client.getStreams(stravaId);
    const ingested = ingestStreams(raw);
    streams = ingested.streams;
    gpsQuality = ingested.gpsQuality;
    hrCoverage = ingested.hrCoverage;
    elevationLossM = ingested.elevation.lossM;
    warnings.push(...ingested.warnings);
  } catch (e) {
    warnings.push(
      `Flux détaillés indisponibles pour l'activité ${stravaId} : ${e instanceof Error ? e.message : String(e)}. ` +
        `Seules les données résumées seront exploitées.`,
    );
  }

  const activity: Activity = mapActivity(detail, athleteId, elevationLossM);
  await db.upsertActivity(activity, detail);

  if (streams && streams.time.length > 0) {
    await db.saveStreams(activity.id, streams, { gpsQuality, hrCoverage });
  }

  // ── Matériel : suivi du kilométrage des chaussures ────────────────────────
  if (detail.gear_id) {
    try {
      const gear = await client.getGear(detail.gear_id);
      await db.upsertGear(athleteId, {
        id: gear.id,
        name: gear.name,
        brandModel: [gear.brand_name, gear.model_name].filter(Boolean).join(' ') || undefined,
        distanceM: gear.distance,
        retired: gear.retired ?? false,
      });
    } catch {
      // Le matériel est un bonus : son indisponibilité n'interrompt rien.
    }
  }

  // ── Modèle physiologique ──────────────────────────────────────────────────
  const runLike = isRunLike(activity.sportType);
  let model =
    (await db.getLatestModel(athleteId)) ?? (await rebuildPhysiologyModel(athleteId, { persist: true }));

  if (runLike && opts.rebuildModel !== false) {
    // On analyse d'abord avec le modèle courant, puis on ré-estime le modèle en
    // tenant compte de cette séance, puis on ré-analyse : sans ce second
    // passage, une performance qui déplace la vitesse critique serait évaluée
    // à l'aune d'un modèle qu'elle vient elle-même de rendre obsolète.
    if (streams) await analyzeAndStore(athleteId, activity.id, model);
    model = await rebuildPhysiologyModel(athleteId);
  }

  const analysis = streams ? await analyzeAndStore(athleteId, activity.id, model) : null;

  // ── Ajustement automatique du plan ────────────────────────────────────────
  const state = await loadAthleteState(athleteId);
  const { adjustmentCount, adjustmentSummary } = await adjustPlan(athleteId, state);

  // ── Analyse rédigée ───────────────────────────────────────────────────────
  let insightId: string | undefined;
  if (analysis && opts.withInsight !== false) {
    const insight = await generateActivityInsight(athleteId, activity, analysis, state);
    if (insight) insightId = insight.id;
    else warnings.push("L'analyse rédigée n'a pas pu être produite ; les métriques restent disponibles.");
  }

  await db.updateSyncState(athleteId, {
    lastActivityEpoch: Math.max(
      Math.floor(new Date(activity.startDate).getTime() / 1000),
      (await db.getSyncState(athleteId))?.lastActivityEpoch ?? 0,
    ),
    lastWebhookAt: new Date().toISOString(),
    status: 'idle',
  });

  return {
    activityId: activity.id,
    name: activity.name,
    analyzed: analysis != null,
    insightId,
    adjustments: adjustmentCount,
    adjustmentSummary,
    warnings,
  };
}

export interface BackfillProgress {
  fetched: number;
  ingested: number;
  skipped: number;
  errors: { stravaId: number; message: string }[];
  rateLimited: boolean;
  message: string;
  /**
   * Message de l'erreur qui a interrompu l'import, le cas échéant. Sans lui,
   * un import avorté est indiscernable d'un import qui n'a rien trouvé — et la
   * relève périodique déclarerait un succès.
   */
  interrupted?: string;
}

/**
 * Import de l'historique.
 *
 * Chaque activité consomme deux appels Strava (détail + flux) et le quota est
 * de 100 requêtes par quart d'heure. On s'arrête proprement avant de le
 * saturer, en enregistrant la progression : la reprise repart d'où on s'est
 * arrêté, sans jamais retélécharger ce qui est déjà en base.
 */
export async function backfill(
  athleteId: string,
  opts: { sinceEpoch?: number; maxActivities?: number; withInsights?: boolean } = {},
): Promise<BackfillProgress> {
  const client = stravaClientFor(athleteId);
  const progress: BackfillProgress = {
    fetched: 0, ingested: 0, skipped: 0, errors: [], rateLimited: false, message: '',
  };

  const syncState = await db.getSyncState(athleteId);
  const since = opts.sinceEpoch ?? syncState?.lastActivityEpoch ?? 0;
  const max = opts.maxActivities ?? 40;

  await db.updateSyncState(athleteId, { status: 'syncing', message: 'Import en cours…' });
  const ingestedIds: string[] = [];

  try {
    for await (const summary of client.iterateActivities(since)) {
      progress.fetched++;

      const existing = await db.getActivityByStravaId(summary.id);
      if (existing) {
        const hasStreams = await db.getStreams(existing.id);
        if (hasStreams) {
          progress.skipped++;
          continue;
        }
      }

      // On garde une marge : sous 8 requêtes disponibles, on s'arrête net.
      if (client.remainingShortTerm() < 8) {
        progress.rateLimited = true;
        break;
      }

      try {
        const result = await ingestActivity(athleteId, summary.id, {
          withInsight: opts.withInsights ?? false,
          // Ré-estimer le modèle à chaque activité d'un backfill serait
          // quadratique : on le fait une fois à la fin.
          rebuildModel: false,
        });
        ingestedIds.push(result.activityId);
        progress.ingested++;
      } catch (e) {
        if (e instanceof StravaRateLimitError) {
          progress.rateLimited = true;
          break;
        }
        progress.errors.push({ stravaId: summary.id, message: e instanceof Error ? e.message : String(e) });
      }

      if (progress.ingested >= max) break;
    }

    // Ré-estimation unique en fin d'import, puis ré-analyse des séances avec
    // le modèle consolidé.
    let model: PhysiologyModel | null = null;
    if (progress.ingested > 0) {
      model = await rebuildPhysiologyModel(athleteId);
      // Les séances qui viennent d'entrer ont été analysées avec le modèle
      // précédent. Elles ne sont pas « périmées » au sens du moteur — même
      // version — mais elles ont été jugées à l'aune d'un modèle qu'elles
      // viennent elles-mêmes de déplacer : c'est le second passage.
      const stale = await db.findStaleAnalyses(athleteId, 400);
      for (const id of new Set([...ingestedIds, ...stale])) await analyzeAndStore(athleteId, id, model);
    }

    // Le rattachement des sept derniers jours se refait à chaque relève, qu'elle
    // ait importé ou non : une séance courue la veille ou le lendemain de sa
    // date se reconnaît sans réimport. Une séance qui vient d'en réaliser une
    // autre emporte ses voisines : les règles les réévaluent tout de suite,
    // comme après une activité importée.
    model ??= await db.getLatestModel(athleteId);
    if (model) {
      const matched = await rematchRecent(athleteId, model, new Date().toISOString().slice(0, 10));
      if (matched.length > 0) await adjustPlan(athleteId, await loadAthleteState(athleteId));
    }

    progress.message = progress.rateLimited
      ? `Quota Strava presque atteint : ${progress.ingested} activité(s) importée(s). Relance l'import dans un quart d'heure pour continuer.`
      : `${progress.ingested} activité(s) importée(s), ${progress.skipped} déjà présente(s).`;

    await db.updateSyncState(athleteId, {
      status: 'idle',
      lastFullSyncAt: new Date().toISOString(),
      message: progress.message,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    progress.interrupted = message;
    progress.message = `Import interrompu : ${message}`;
    await db.updateSyncState(athleteId, { status: 'error', message });
  }

  return progress;
}

/** Traite les événements webhook en attente. */
export async function processPendingWebhooks(): Promise<number> {
  const events = await db.pendingWebhookEvents(20);
  let processed = 0;

  for (const event of events) {
    try {
      const athleteId = (await db.getAthleteByStravaId(event.ownerId)) ?? env.athleteId;

      if (event.objectType === 'activity') {
        if (event.aspectType === 'delete') {
          await db.deleteActivity(event.objectId);
        } else {
          await ingestActivity(athleteId, event.objectId, { withInsight: true });
        }
      }
      await db.markWebhookProcessed(event.id);
      processed++;
    } catch (e) {
      await db.markWebhookProcessed(event.id, e instanceof Error ? e.message : String(e));
    }
  }
  return processed;
}
