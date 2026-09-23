import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as db from '@cairn/db';
import { directivesFor } from '@cairn/core';
import {
  CHECK_IN_PURPOSE, GLOSSARY, applyAdjustments, chat, checkInEffect, currentModel, describeAdjustments,
  describeDirectives, evaluateAdjustments, executeTool, firstParagraph, generateWeeklyReview, labGaps,
  loadAthleteState, raceDayGapCost, raceDayNotice, rebuildPhysiologyModel, summarizeWeek, type SessionState,
} from '@cairn/coach';
import {
  authorizeUrl, exchangeCode, readOAuthConfig, StravaRateLimitError,
} from '@cairn/strava';
import type { ActivityStreams, DeclaredAbsence, DecisionOrigin, PlannedSession } from '@cairn/core';
import {
  formatDuration, formatPace, hrProvenanceOf, msToKmh, speedProvenanceOf,
} from '@cairn/physiology';
import { env, missingConfig } from './env.js';
import { garminLoopStatus, garminPlanView } from './garmin.js';
import { activityPollerStatus } from './poller.js';
import { lastDeploy, runningVersion } from './release.js';
import { backfill, ingestActivity, processPendingWebhooks, stravaClientFor } from './sync.js';

const dayMs = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * dayMs));

/**
 * Lecture d'une valeur déclarée.
 *
 * Une réponse absente reste absente — `readiness` sait la traiter comme telle
 * et le dira. Une réponse hors bornes physiologiques est écartée plutôt que
 * ramenée de force : une FC de repos à 300 n'est pas une FC de repos.
 */
/** Origines du navigateur de l'application — les mêmes qu'autorise CORS. */
const WEB_ORIGINS = [env.webOrigin, 'http://localhost:3000', 'http://127.0.0.1:3000'];

/**
 * D'où vient un appel qui touche le plan.
 *
 * Le navigateur envoie `Origin` sur toute requête vers l'API : elle est d'une
 * autre origine que la page. `curl`, un script, une session de développement
 * n'en envoient pas. Ce n'est pas une authentification — rien n'empêche de
 * forger l'en-tête, et l'API n'est pas exposée à des tiers ; c'est la
 * distinction que le journal doit porter. « Depuis l'interface » ne dit pas si
 * Pierre a cliqué sur un bouton ou si un développeur a appelé l'API, et les
 * deux ne se relisent pas de la même façon six mois plus tard.
 */
const originOf = (req: { headers: Record<string, unknown> }): DecisionOrigin =>
  typeof req.headers.origin === 'string' && WEB_ORIGINS.includes(req.headers.origin)
    ? 'athlete'
    : 'developer';

const numeric = (v: unknown, min: number, max: number): number | undefined => {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const scale = (v: unknown): number | undefined => {
  const n = numeric(v, 1, 5);
  return n == null ? undefined : Math.round(n);
};

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: WEB_ORIGINS,
    credentials: true,
  });

  const A = env.athleteId;

  // ═══════════════════════════════════════════════════════════════════════════
  // Santé & configuration
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/health', async () => {
    const tokens = await db.getStravaTokens(A);
    const sync = await db.getSyncState(A);
    const activityCount = (await db.listActivities(A, { limit: 1 })).length;
    return {
      ok: true,
      athleteId: A,
      stravaConnected: tokens != null,
      missingConfig: missingConfig(),
      sync: sync ?? null,
      // `sync` dit ce que le dernier import a fait ; `poll` dit si l'horloge
      // qui les déclenche tourne encore. Sans le second, une relève morte
      // ressemble à une relève sans rien à faire.
      poll: activityPollerStatus(),
      // La liaison Garmin : si la boucle tourne ici, et ce que dit son dernier passage.
      garmin: {
        loop: garminLoopStatus(),
        ...(await garminPlanView(A).then((v) => v.overview).catch(() => null)),
      },
      hasActivities: activityCount > 0,
      // La version qui répond, à laquelle l'app se compare ; et la dernière
      // mise à jour tentée, qu'elle affiche quand elle a été refusée.
      version: runningVersion(),
      deploy: lastDeploy(),
    };
  });

  /**
   * Un écran dont le rendu a échoué, rapporté par sa frontière d'erreur.
   *
   * Rien en base : l'erreur va au journal du service, avec l'écran, la version
   * de la page et la pile — de quoi retrouver le code qui a cassé sans avoir à
   * reproduire la panne sur le téléphone.
   */
  app.post('/api/errors', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined);
    const digest = text(body.digest, 100);
    req.log.error(
      { err: { stack: text(body.stack, 8000) } },
      `rendu en échec sur ${text(body.screen, 200) ?? 'un écran inconnu'}, version ${text(body.commit, 40) ?? 'inconnue'}` +
        `${digest ? ` (digest ${digest})` : ''} : ${text(body.message, 1000) ?? 'erreur sans message'}`,
    );
    return reply.code(204).send();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // OAuth Strava
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/auth/strava', async (req, reply) => {
    try {
      const config = readOAuthConfig();
      return reply.redirect(authorizeUrl(config, A));
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get<{ Querystring: { code?: string; error?: string; state?: string; scope?: string } }>(
    '/auth/strava/callback',
    async (req, reply) => {
      const { code, error, scope } = req.query;
      if (error || !code) {
        return reply
          .type('text/html; charset=utf-8')
          .send(page('Connexion refusée', `Strava a renvoyé : <code>${escapeHtml(error ?? 'aucun code')}</code>.`));
      }
      try {
        const config = readOAuthConfig();
        const tokens = await exchangeCode(config, code);
        const athleteId = req.query.state ?? A;

        await db.saveStravaTokens(athleteId, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_at,
          scope: tokens.scope ?? scope,
          stravaAthleteId: tokens.athlete?.id ?? 0,
        });

        // Le premier import démarre en tâche de fond : la page doit répondre
        // immédiatement, l'import peut durer plusieurs minutes.
        void backfill(athleteId, { maxActivities: 60, withInsights: false }).catch((e) =>
          app.log.error({ err: e }, 'échec du premier import'),
        );

        return reply.type('text/html; charset=utf-8').send(
          page(
            'Strava connecté',
            `Compte <strong>${escapeHtml(tokens.athlete?.firstname ?? '')} ${escapeHtml(tokens.athlete?.lastname ?? '')}</strong> relié.<br>
             L'import de ton historique a démarré en arrière-plan.<br><br>
             <a href="${env.webOrigin}">Ouvrir Cairn →</a>`,
          ),
        );
      } catch (e) {
        return reply
          .type('text/html; charset=utf-8')
          .send(page('Échec de la connexion', escapeHtml(e instanceof Error ? e.message : String(e))));
      }
    },
  );

  app.get('/auth/status', async () => {
    const tokens = await db.getStravaTokens(A);
    return {
      connected: tokens != null,
      stravaAthleteId: tokens?.stravaAthleteId ?? null,
      scope: tokens?.scope ?? null,
      expiresAt: tokens?.expiresAt ?? null,
      authorizeUrl: (() => {
        try {
          return authorizeUrl(readOAuthConfig(), A);
        } catch {
          return null;
        }
      })(),
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Webhooks Strava
  // ═══════════════════════════════════════════════════════════════════════════

  // Handshake de validation : Strava appelle cette URL en GET à la création
  // de la souscription et attend l'écho du challenge.
  app.get<{ Querystring: Record<string, string> }>('/webhook/strava', async (req, reply) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === env.webhookVerifyToken) {
      return reply.send({ 'hub.challenge': challenge });
    }
    return reply.code(403).send({ error: 'Jeton de vérification invalide.' });
  });

  app.post('/webhook/strava', async (req, reply) => {
    const body = req.body as {
      object_type?: string; object_id?: number; aspect_type?: string; owner_id?: number;
    };
    // Strava exige une réponse sous 2 s : on enregistre puis on traite après coup.
    if (body?.object_type && body.object_id != null && body.aspect_type && body.owner_id != null) {
      await db.recordWebhookEvent({
        objectType: body.object_type,
        objectId: body.object_id,
        aspectType: body.aspect_type,
        ownerId: body.owner_id,
        payload: body,
      });
      setImmediate(() => {
        processPendingWebhooks().catch((e) => app.log.error({ err: e }, 'échec du traitement webhook'));
      });
    }
    return reply.code(200).send({ received: true });
  });

  app.post('/webhook/subscribe', async (req, reply) => {
    try {
      const client = stravaClientFor(A);
      const callback = `${env.publicBaseUrl}/webhook/strava`;
      const existing = await client.listSubscriptions();
      for (const sub of existing) {
        if (sub.callback_url !== callback) await client.deleteSubscription(sub.id);
      }
      const already = existing.find((s) => s.callback_url === callback);
      const sub = already ?? (await client.createSubscription(callback, env.webhookVerifyToken));
      await db.updateSyncState(A, { webhookSubscriptionId: sub.id });
      return { subscription: sub, callback };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/webhook/status', async (reply) => {
    try {
      const subs = await stravaClientFor(A).listSubscriptions();
      return { subscriptions: subs, expectedCallback: `${env.publicBaseUrl}/webhook/strava` };
    } catch (e) {
      return { subscriptions: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Synchronisation
  // ═══════════════════════════════════════════════════════════════════════════

  app.post<{ Body: { maxActivities?: number; sinceEpoch?: number; withInsights?: boolean } }>(
    '/api/sync',
    async (req, reply) => {
      try {
        const result = await backfill(A, req.body ?? {});
        return result;
      } catch (e) {
        if (e instanceof StravaRateLimitError) {
          return reply.code(429).send({ error: e.message, retryAfterMs: e.retryAfterMs });
        }
        return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.post<{ Params: { stravaId: string } }>('/api/sync/activity/:stravaId', async (req, reply) => {
    try {
      return await ingestActivity(A, Number(req.params.stravaId), { withInsight: true });
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/api/model/rebuild', async (req, reply) => {
    try {
      return await rebuildPhysiologyModel(A);
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Lecture
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/state', async (req, reply) => {
    try {
      const s = await loadAthleteState(A);
      return {
        athlete: {
          id: s.profile.id,
          name: s.profile.name,
          constraints: s.profile.constraints,
          ambition: s.profile.ambition ?? null,
        },
        model: {
          ...s.model,
          criticalSpeedKmh: round2(msToKmh(s.model.criticalSpeedMs)),
          criticalPace: formatPace(s.model.criticalSpeedMs),
          vmaKmh: round2(msToKmh(s.model.vmaMs)),
          vt1Kmh: round2(msToKmh(s.model.vt1.speedMs)),
          vt2Kmh: round2(msToKmh(s.model.vt2.speedMs)),
        },
        // Une zone ouverte vers le haut rend `null`, pas un nombre : Z5 n'a pas
        // de plafond que quoi que ce soit de mesuré fonde, et l'écran doit
        // pouvoir écrire « au-delà de » plutôt qu'un chiffre inventé.
        zones: s.zones.map((z) => ({
          ...z,
          speedMinKmh: round2(msToKmh(z.speedMinMs)),
          speedMaxKmh: z.speedMaxMs == null ? null : round2(msToKmh(z.speedMaxMs)),
          paceMin: z.speedMaxMs == null ? null : formatPace(z.speedMaxMs),
          paceMax: formatPace(z.speedMinMs),
          speedProvenance: speedProvenanceOf(z),
          hrProvenance: hrProvenanceOf(z),
        })),
        today: s.today,
        readiness: s.readiness,
        checkIn: s.todayCheckIn ?? null,
        // Ce que Pierre a écrit et dont rien n'a encore été fait. Le tableau de
        // bord le montre : une note qui reste dans sa colonne n'a servi à rien.
        pendingNotes: s.pendingNotes,
        absences: await withWithdrawnCounts(A, s.absences),
        weeklyTotals: s.weeklyTotals,
        upcomingRaces: s.upcomingRaces.map((r) => ({
          ...r,
          daysUntil: Math.round((new Date(r.date).getTime() - Date.now()) / dayMs),
        })),
        hasPlan: s.plan != null,
        labTest: s.profile.labTests[0] ?? null,
        // Pourquoi un paramètre n'est plus celui du test, paramètre par paramètre.
        labGaps: s.profile.labTests[0] ? labGaps(s.model, s.profile.labTests[0]) : {},
        // Ce que le point du jour change, dit avant qu'on y réponde.
        checkInPurpose: CHECK_IN_PURPOSE,
        // Ce que le planificateur lit du dossier, et l'extrait qui le fonde.
        directives: directivesFor(s.profile),
      };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Les mots techniques qui restent à l'écran et leur définition : une seule
  // table, celle de `presentation.ts`.
  app.get('/api/glossary', async () => GLOSSARY);

  app.get('/api/pmc', async (req, reply) => {
    const q = req.query as { days?: string };
    const days = Number(q.days ?? 180);
    try {
      const s = await loadAthleteState(A);
      const cutoff = daysAgo(days);
      return {
        metabolic: s.pmc.metabolic.filter((p) => p.date >= cutoff),
        mechanical: s.pmc.mechanical.filter((p) => p.date >= cutoff),
        acwr: s.pmc.acwr.filter((p) => p.date >= cutoff),
        rampRate: s.pmc.rampRate.filter((p) => p.date >= cutoff),
        monotony: s.pmc.monotony.filter((p) => p.date >= cutoff),
      };
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/curves', async (req, reply) => {
    try {
      const result = await executeTool(A, 'get_performance_curves', {});
      return result.content;
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/activities', async (req) => {
    const q = req.query as { from?: string; to?: string; limit?: string };
    const activities = await db.listActivities(A, {
      from: q.from ?? daysAgo(90),
      to: q.to,
      limit: Number(q.limit ?? 100),
    });
    const analyses = await db.getAnalyses(activities.map((a) => a.id));
    return activities.map((a) => {
      const an = analyses.get(a.id);
      return {
        ...a,
        distanceKm: round2(a.distanceM / 1000),
        durationLabel: formatDuration(a.movingTimeS),
        pace: formatPace(a.averageSpeedMs),
        load: an?.load ?? null,
        zones: an?.zones.threeZone ?? null,
        decoupling: an?.decoupling.pctDrift ?? null,
        intervalCount: an?.intervals.length ?? 0,
        flags: an?.flags.filter((f) => f.severity !== 'info').length ?? 0,
      };
    });
  });

  app.get<{ Params: { id: string } }>('/api/activities/:id', async (req, reply) => {
    const activity = await db.getActivity(req.params.id);
    if (!activity) return reply.code(404).send({ error: 'Activité introuvable.' });
    const analysis = await db.getAnalysis(req.params.id);
    const insight = await db.getInsightForActivity(req.params.id);
    const streams = await db.getStreams(req.params.id);
    return {
      activity,
      analysis,
      insight,
      // Flux sous-échantillonnés : suffisant pour tracer, sans envoyer 3 Mo au navigateur.
      streams: streams ? downsample(streams.streams, 900) : null,
    };
  });

  app.get('/api/plan', async (req) => {
    const q = req.query as { from?: string; weeks?: string };
    const from = q.from ?? daysAgo(7);
    const weeks = Number(q.weeks ?? 6);
    const to = iso(new Date(new Date(`${from}T00:00:00Z`).getTime() + weeks * 7 * dayMs));
    const plan = await db.getActivePlan(A);
    const sessions = await db.listPlannedSessions(A, from, to);
    const activities = await db.listActivities(A, { from, to: iso(new Date()), limit: 200 });
    const absences = await db.listAbsences(A, { from, to });
    const profile = await db.getAthlete(A);
    const dossier = profile ? directivesFor(profile) : [];
    // L'état Garmin de chaque séance des sept jours. Une liaison illisible ne
    // doit pas coûter le plan : sans elle, l'écran n'affirme simplement rien.
    const garmin = await garminPlanView(A).catch((e) => {
      req.log.warn({ err: e }, 'état Garmin illisible');
      return null;
    });
    return {
      plan: plan?.plan ?? null,
      raceDay: plan ? await raceDayView(plan.plan) : null,
      weekSummaries: plan?.weeks.map(summarizeWeek) ?? [],
      // Ce qu'une directive produit se lit sur le contenu actuel de la séance.
      sessions: sessions.map((s) => ({
        ...(s.directives ? { ...s, directives: describeDirectives(s, dossier) } : s),
        garmin: garmin?.bySession[s.id] ?? null,
      })),
      garmin: garmin?.overview ?? null,
      absences,
      completedByDate: Object.fromEntries(
        activities.map((a) => [a.startDateLocal.slice(0, 10), { id: a.id, name: a.name }]),
      ),
    };
  });

  app.get('/api/insights', async (req) => {
    const q = req.query as { limit?: string };
    return db.listInsights(A, Number(q.limit ?? 25));
  });

  app.get('/api/races', async () => db.listRaceGoals(A));

  app.post('/api/races', async (req, reply) => {
    try {
      const result = await executeTool(A, 'upsert_race', req.body);
      return result.content;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/races/:id', async (req) => {
    await db.deleteRaceGoal(req.params.id);
    return { deleted: req.params.id };
  });

  app.post('/api/predict', async (req, reply) => {
    try {
      const result = await executeTool(A, 'predict_race', req.body);
      return result.content;
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Sans `apply: true`, rien n'est touché : la réponse est l'aperçu de ce que
  // la reconstruction conserverait, remplacerait et écrirait. L'application
  // le montre avant de confirmer — l'action est irréversible. Une clé que le
  // schéma de l'outil ne déclare pas est refusée par l'outil lui-même.
  app.post<{ Body: { race_id: string; reason?: string; start_date?: string; apply?: boolean } }>(
    '/api/plan/rebuild',
    async (req, reply) => {
      try {
        const result = await executeTool(
          A,
          'rebuild_plan',
          { ...req.body, reason: req.body.reason ?? 'Reconstruction demandée.' },
          originOf(req),
        );
        return result.content;
      } catch (e) {
        return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  );

  app.post('/api/checkin', async (req, reply) => {
    try {
      const body = req.body as Record<string, unknown>;
      const date = typeof body.date === 'string' ? body.date : iso(new Date());
      const note = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : undefined;

      const fields = {
        fatigue: scale(body.fatigue),
        sleepHours: numeric(body.sleepHours, 0, 24),
        sleepQuality: scale(body.sleepQuality),
        soreness: scale(body.soreness),
        stress: scale(body.stress),
        motivation: scale(body.motivation),
        restingHr: numeric(body.restingHr, 25, 120),
        hrvRmssd: numeric(body.hrvRmssd, 1, 400),
        bodyMassKg: numeric(body.bodyMassKg, 30, 200),
      };

      const answered = Object.values(fields).some((v) => v != null) || (note ?? '') !== '';
      if (!answered) {
        return reply.code(400).send({ error: 'Point du jour vide : aucune réponse à enregistrer.' });
      }

      // Ce que les réponses vont changer se mesure contre l'état d'avant :
      // la disponibilité, et la séance que les règles peuvent toucher.
      const before = (await loadAthleteState(A)).readiness;
      const today = iso(new Date());
      const tomorrow = iso(new Date(Date.now() + dayMs));
      const watched = (await db.listPlannedSessions(A, today, tomorrow))
        .filter((s) => s.date >= today && s.date <= tomorrow && s.status === 'planned' && s.type !== 'rest')
        .sort((a, b) => a.date.localeCompare(b.date))[0];

      // Un point du jour se complète : deux envois successifs s'ajoutent, le
      // second n'efface pas ce que le premier avait déclaré.
      const existing = (await db.listCheckIns(A, date)).find((c) => c.date === date);
      const defined = <T,>(next: T | undefined, prev: T | undefined) => next ?? prev;
      const keptNote = note === undefined ? existing?.notes : note || undefined;
      await db.upsertCheckIn({
        athleteId: A,
        date,
        fatigue: defined(fields.fatigue, existing?.fatigue),
        sleepHours: defined(fields.sleepHours, existing?.sleepHours),
        sleepQuality: defined(fields.sleepQuality, existing?.sleepQuality),
        soreness: defined(fields.soreness, existing?.soreness),
        stress: defined(fields.stress, existing?.stress),
        motivation: defined(fields.motivation, existing?.motivation),
        restingHr: defined(fields.restingHr, existing?.restingHr),
        hrvRmssd: defined(fields.hrvRmssd, existing?.hrvRmssd),
        bodyMassKg: defined(fields.bodyMassKg, existing?.bodyMassKg),
        // Une note absente du corps se conserve ; une note vidée s'efface —
        // sans quoi on ne pourrait pas revenir sur ce qu'on a écrit.
        notes: keptNote,
        // Ce qui a été fait d'une note ne vaut que pour le texte sur lequel on
        // l'a fait : réécrire la note la remet en attente.
        ...(keptNote === existing?.notes
          ? { noteHandledAt: existing?.noteHandledAt, noteHandledAs: existing?.noteHandledAs }
          : {}),
      });

      // Un relevé peut changer la disponibilité du jour : on réévalue tout de suite.
      const state = await loadAthleteState(A);
      const upcoming = await db.listPlannedSessions(A, iso(new Date()), iso(new Date(Date.now() + 14 * dayMs)));
      const adjustments = evaluateAdjustments(state, upcoming);
      const applied = await applyAdjustments(A, adjustments, 'readiness');
      const after = watched
        ? (await db.listPlannedSessions(A, today, iso(new Date(Date.now() + 14 * dayMs)))).find((s) => s.id === watched.id)
        : undefined;
      return {
        readiness: state.readiness,
        checkIn: state.todayCheckIn ?? null,
        adjustments: applied,
        adjustmentSummary: applied > 0 ? describeAdjustments(adjustments) : null,
        // Ce que les réponses ont changé, en une phrase.
        effect: checkInEffect({
          before,
          after: state.readiness,
          today,
          session: watched ? { before: sessionState(watched), after: after ? sessionState(after) : null } : null,
        }),
      };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.get('/api/checkins', async (req) => {
    const q = req.query as { from?: string };
    return db.listCheckIns(A, q.from ?? daysAgo(30));
  });

  /**
   * Sort une note de l'attente sans rien en déduire.
   *
   * Toutes les notes n'appellent pas une décision : celle qui n'en appelle pas
   * doit pouvoir être classée, sinon la seule façon de faire taire le bandeau
   * serait d'effacer ce qu'on a écrit.
   */
  app.post<{ Params: { date: string }; Body: { as?: string } }>(
    '/api/checkins/:date/note/handled',
    async (req, reply) => {
      const { date } = req.params;
      const existing = (await db.listCheckIns(A, date)).find((c) => c.date === date);
      if (!existing) return reply.code(404).send({ error: `Aucun point du jour au ${date}.` });
      if (!existing.notes?.trim()) {
        return reply.code(400).send({ error: `Le point du ${date} ne porte aucune note.` });
      }
      // Déjà traitée : on ne réécrit pas ce qui en avait été fait. Un second
      // clic effacerait « absence déclarée du 3 au 13 » au profit d'un classement.
      if (existing.noteHandledAt) {
        return { date, handledAs: existing.noteHandledAs ?? null, alreadyHandled: true };
      }
      const as = typeof req.body?.as === 'string' && req.body.as.trim()
        ? req.body.as.trim().slice(0, 300)
        : 'Lue et classée, sans suite à donner.';
      await db.markCheckInNoteHandled(A, date, as);
      return { date, handledAs: as };
    },
  );

  app.get('/api/absences', async (req) => {
    const q = req.query as { from?: string };
    return db.listAbsences(A, { from: q.from ?? daysAgo(120) });
  });

  app.get('/api/gear', async () => {
    const gear = await db.listGear(A);
    return gear.map((g) => ({
      ...g,
      distanceKm: Math.round(g.distanceM / 1000),
      wearPct: g.replaceAtKm ? Math.round((g.distanceM / 1000 / g.replaceAtKm) * 100) : null,
    }));
  });

  app.post('/api/review/weekly', async (req, reply) => {
    try {
      const insight = await generateWeeklyReview(A);
      if (!insight) return reply.code(503).send({ error: "Analyse hebdomadaire indisponible." });
      return insight;
    } catch (e) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Chat
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/chat/history', async (req) => {
    const q = req.query as { limit?: string };
    return db.listChatMessages(A, Number(q.limit ?? 50));
  });

  /**
   * Diffusion du chat en Server-Sent Events. Les appels d'outils sont émis au
   * fil de l'eau : l'athlète voit sur quelles données le coach s'appuie pendant
   * qu'il réfléchit, ce qui rend le raisonnement vérifiable plutôt que magique.
   */
  app.post<{ Body: { message: string } }>('/api/chat', async (req, reply) => {
    const message = req.body?.message?.trim();
    if (!message) return reply.code(400).send({ error: 'Message vide.' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': env.webOrigin,
    });

    const send = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Battement pour empêcher les proxys de couper une réflexion longue.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    try {
      for await (const event of chat({ athleteId: A, message })) {
        send(event);
      }
    } catch (e) {
      send({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
    return reply;
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────

/** Ce qu'une séance est, pour dire ce qu'un point du jour en a fait. */
const sessionState = (s: PlannedSession): SessionState => ({
  type: s.type, status: s.status, date: s.date, durationS: s.plannedDurationS, load: s.plannedLoad,
});

/**
 * La fraîcheur du jour de la course, telle que l'écran du plan la dit.
 *
 * Le plan enregistré porte sa cible, ce que ses charges produisent et, quand il
 * la manque, pourquoi. Ce que l'écart coûte se relit ici, avec le modèle du
 * jour, contre la précision de la prédiction qui le chiffre : sous elle,
 * l'écart n'est pas une information, et l'écran n'en dit rien — ni encart, ni
 * deux chiffres dont on lirait la différence. `notice` est donc à la fois
 * l'encart et le signal qu'il y a un écart à lire.
 */
async function raceDayView(plan: {
  goalRaceId: string; targetRaceDayTsb: number; projectedRaceDayTsb?: number; raceDayTsbShortfall?: string;
}) {
  const target = plan.targetRaceDayTsb;
  const projected = plan.projectedRaceDayTsb ?? null;
  const shortfall = plan.raceDayTsbShortfall;
  if (projected == null || !shortfall) return { target, projected, notice: null };
  const race = await db.getRaceGoal(plan.goalRaceId);
  // Sans course à chiffrer, l'écart se dit tel que le plan l'a écrit.
  if (!race) return { target, projected, notice: firstParagraph(shortfall) };
  const cost = raceDayGapCost(await currentModel(env.athleteId), race.course, target, projected);
  return { target, projected, notice: raceDayNotice(shortfall, { target, projected, ...cost }) };
}

/**
 * Combien de séances chaque absence a retirées.
 *
 * Compté en base plutôt que déduit de la fenêtre affichée : une coupure qui
 * dépasse d'un jour la fenêtre du tableau de bord perdrait une séance, et
 * l'athlète lirait un chiffre faux là où il vient d'en accepter un.
 */
async function withWithdrawnCounts(athleteId: string, absences: DeclaredAbsence[]) {
  if (absences.length === 0) return [];
  const from = absences.reduce((m, a) => (a.startDate < m ? a.startDate : m), absences[0]!.startDate);
  const to = absences.reduce((m, a) => (a.endDate > m ? a.endDate : m), absences[0]!.endDate);
  const counts = new Map<string, number>();
  for (const s of await db.listPlannedSessions(athleteId, from, to)) {
    if (s.absenceId) counts.set(s.absenceId, (counts.get(s.absenceId) ?? 0) + 1);
  }
  return absences.map((a) => ({ ...a, withdrawnSessions: counts.get(a.id) ?? 0 }));
}

/** Sous-échantillonne les flux pour l'affichage. */
function downsample(input: ActivityStreams, target: number): Record<string, unknown> {
  const streams = input as unknown as Record<string, unknown>;
  const time = streams.time as number[] | undefined;
  if (!time || time.length <= target) return streams;
  const step = Math.ceil(time.length / target);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(streams)) {
    if (!Array.isArray(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value.filter((_, i) => i % step === 0);
  }
  return out;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Cairn</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0c10;color:#e8eaed;
font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:34rem;padding:2.5rem;background:#12151c;border:1px solid #232833;border-radius:14px;text-align:center}
h1{margin:0 0 1rem;font-size:1.35rem;letter-spacing:-.01em}
code{background:#1c212b;padding:.15em .4em;border-radius:4px;font-size:.9em}
a{color:#7dd3a0;text-decoration:none;font-weight:600}a:hover{text-decoration:underline}
</style></head><body><div class="card"><h1>${title}</h1><div>${body}</div></div></body></html>`;
}
