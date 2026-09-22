import { sql } from 'drizzle-orm';
import { blob, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Schéma. Deux principes :
 *
 *  1. **Tout est conservé.** Les flux bruts sont stockés compressés, jamais
 *     jetés : le moteur d'analyse évolue, et il faut pouvoir recalculer trois
 *     ans d'historique avec un modèle amélioré sans re-télécharger Strava.
 *  2. **Les résultats calculés sont dérivés, jamais autoritaires.** Toute
 *     analyse est reproductible depuis les flux et le modèle du moment ; on
 *     conserve la version du moteur qui l'a produite pour pouvoir invalider
 *     proprement.
 */

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const athletes = sqliteTable('athletes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  birthDate: text('birth_date').notNull(),
  sex: text('sex', { enum: ['M', 'F'] }).notNull(),
  stravaAthleteId: integer('strava_athlete_id'),
  /** AthleteConstraints, sérialisé. */
  constraints: text('constraints', { mode: 'json' }).notNull(),
  /** AthleteAmbition — la direction visée, sans date. Distincte des courses. */
  ambition: text('ambition', { mode: 'json' }),
  preferences: text('preferences', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
});

export const labTests = sqliteTable('lab_tests', {
  id: text('id').primaryKey(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  /** LabTest complet, sérialisé — structure riche et stable. */
  data: text('data', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull().default(now),
});

export const stravaTokens = sqliteTable('strava_tokens', {
  athleteId: text('athlete_id').primaryKey().references(() => athletes.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  /** Expiration du jeton d'accès, epoch en secondes. */
  expiresAt: integer('expires_at').notNull(),
  scope: text('scope'),
  stravaAthleteId: integer('strava_athlete_id').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    stravaId: integer('strava_id'),
    name: text('name').notNull(),
    description: text('description'),
    sportType: text('sport_type').notNull(),
    startDate: text('start_date').notNull(),
    startDateLocal: text('start_date_local').notNull(),
    timezone: text('timezone'),

    distanceM: real('distance_m').notNull(),
    movingTimeS: integer('moving_time_s').notNull(),
    elapsedTimeS: integer('elapsed_time_s').notNull(),
    totalElevationGainM: real('total_elevation_gain_m').notNull(),
    totalElevationLossM: real('total_elevation_loss_m').notNull().default(0),
    elevHighM: real('elev_high_m'),
    elevLowM: real('elev_low_m'),

    averageSpeedMs: real('average_speed_ms').notNull(),
    maxSpeedMs: real('max_speed_ms'),
    averageHr: real('average_hr'),
    maxHr: real('max_hr'),
    averageCadenceSpm: real('average_cadence_spm'),
    averageWatts: real('average_watts'),
    averageTempC: real('average_temp_c'),
    calories: real('calories'),

    sufferScore: real('suffer_score'),
    gearId: text('gear_id'),
    deviceName: text('device_name'),
    trainer: integer('trainer', { mode: 'boolean' }).default(false),
    commute: integer('commute', { mode: 'boolean' }).default(false),
    manual: integer('manual', { mode: 'boolean' }).default(false),

    plannedSessionId: text('planned_session_id'),
    rpe: integer('rpe'),
    feel: integer('feel'),

    /** Réponse Strava brute, conservée intégralement. */
    raw: text('raw', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => ({
    byAthleteDate: index('activities_athlete_date_idx').on(t.athleteId, t.startDateLocal),
    byStravaId: uniqueIndex('activities_strava_id_idx').on(t.stravaId),
  }),
);

export const activityStreams = sqliteTable('activity_streams', {
  activityId: text('activity_id')
    .primaryKey()
    .references(() => activities.id, { onDelete: 'cascade' }),
  /** ActivityStreams normalisés, JSON gzippé — ~50× plus compact que du texte brut. */
  payload: blob('payload').notNull(),
  gpsQuality: text('gps_quality').notNull(),
  hrCoverage: real('hr_coverage').notNull(),
  sampleCount: integer('sample_count').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

export const activityAnalyses = sqliteTable(
  'activity_analyses',
  {
    activityId: text('activity_id')
      .primaryKey()
      .references(() => activities.id, { onDelete: 'cascade' }),
    athleteId: text('athlete_id').notNull(),
    /** ActivityAnalysis complet. */
    data: text('data', { mode: 'json' }).notNull(),
    /** Charges extraites pour l'agrégation rapide du PMC. */
    metabolicLoad: real('metabolic_load').notNull(),
    mechanicalLoad: real('mechanical_load').notNull(),
    dateKey: text('date_key').notNull(),
    /** Version du moteur ayant produit l'analyse — sert à l'invalidation. */
    engineVersion: text('engine_version').notNull(),
    computedAt: text('computed_at').notNull().default(now),
  },
  (t) => ({ byAthleteDate: index('analyses_athlete_date_idx').on(t.athleteId, t.dateKey) }),
);

export const physiologyModels = sqliteTable(
  'physiology_models',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    asOf: text('as_of').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => ({ byAthlete: index('models_athlete_idx').on(t.athleteId, t.asOf) }),
);

export const dailyCheckIns = sqliteTable(
  'daily_check_ins',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    fatigue: integer('fatigue'),
    sleepHours: real('sleep_hours'),
    sleepQuality: integer('sleep_quality'),
    soreness: integer('soreness'),
    stress: integer('stress'),
    motivation: integer('motivation'),
    restingHr: integer('resting_hr'),
    hrvRmssd: real('hrv_rmssd'),
    bodyMassKg: real('body_mass_kg'),
    notes: text('notes'),
    /** Tant que c'est vide, la note libre est en attente : l'application la montre. */
    noteHandledAt: text('note_handled_at'),
    noteHandledAs: text('note_handled_as'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => ({ byAthleteDate: uniqueIndex('checkins_athlete_date_idx').on(t.athleteId, t.date) }),
);

export const raceGoals = sqliteTable(
  'race_goals',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    date: text('date').notNull(),
    priority: text('priority', { enum: ['A', 'B', 'C'] }).notNull(),
    course: text('course', { mode: 'json' }).notNull(),
    target: text('target', { mode: 'json' }),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => ({ byAthleteDate: index('races_athlete_date_idx').on(t.athleteId, t.date) }),
);

export const trainingPlans = sqliteTable(
  'training_plans',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    goalRaceId: text('goal_race_id').notNull(),
    targetRaceDayTsb: real('target_race_day_tsb').notNull(),
    /**
     * TSB mesuré sur le plan produit, à la veille de la course. Nullable : les
     * plans antérieurs à la vérification n'en portent pas, et leur en inventer
     * un serait pire que de l'admettre.
     */
    projectedRaceDayTsb: real('projected_race_day_tsb'),
    /** Ce qui a empêché d'atteindre la cible, quand elle est manquée. */
    raceDayTsbShortfall: text('race_day_tsb_shortfall'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    revisionLog: text('revision_log', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => ({ byAthlete: index('plans_athlete_idx').on(t.athleteId, t.active) }),
);

export const plannedSessions = sqliteTable(
  'planned_sessions',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id').notNull().references(() => trainingPlans.id, { onDelete: 'cascade' }),
    athleteId: text('athlete_id').notNull(),
    date: text('date').notNull(),
    /**
     * Le jour que le plan avait fixé, quand la séance a été réalisée un autre
     * jour. Ajoutée par `ensureSessionColumns`.
     */
    plannedDate: text('planned_date'),
    weekStart: text('week_start').notNull(),
    phase: text('phase').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    intent: text('intent').notNull(),
    blocks: text('blocks', { mode: 'json' }).notNull(),
    plannedLoad: real('planned_load').notNull(),
    plannedMechanicalLoad: real('planned_mechanical_load').notNull().default(0),
    plannedDurationS: integer('planned_duration_s').notNull(),
    plannedDistanceM: real('planned_distance_m'),
    plannedElevationGainM: real('planned_elevation_gain_m'),
    priority: text('priority', { enum: ['key', 'support', 'optional'] }).notNull(),
    status: text('status').notNull().default('planned'),
    completedActivityId: text('completed_activity_id'),
    /** Absence déclarée qui a retiré la séance — renseigné avec le statut `withdrawn`. */
    absenceId: text('absence_id'),
    rationale: text('rationale'),
    /**
     * SessionDecision — ce qui a été décidé sur la séance hors du
     * planificateur, avec sa provenance. C'est ce qui rend une séance encore à
     * venir opposable à une reconstruction : son statut, lui, dit « planned ».
     */
    decision: text('decision', { mode: 'json' }),
    /** Critères de réussite, tels que le dossier les formule. */
    successCriteria: text('success_criteria', { mode: 'json' }),
    /** Directives du dossier qui ont façonné la séance, avec leur extrait. */
    directives: text('directives', { mode: 'json' }),
    /**
     * SessionHistoryEntry[] — ce qui a façonné la séance au-delà de sa phrase de
     * « pourquoi » : raisonnement du coach, ce que le planificateur a cédé.
     * Ajoutée par `ensureSessionColumns`, le service ne passant pas `db:push`.
     */
    history: text('history', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => ({
    byAthleteDate: index('sessions_athlete_date_idx').on(t.athleteId, t.date),
    byPlan: index('sessions_plan_idx').on(t.planId, t.date),
  }),
);

/**
 * Absences déclarées.
 *
 * Une table à part, et non une note dans les contraintes de l'athlète : les
 * contraintes disent une semaine type — des jours, un volume — et n'ont aucun
 * moyen de retenir « du 3 au 13 septembre ». C'est daté, c'est ponctuel, et
 * c'est ce qui décide si une séance non faite est une faute ou un fait.
 */
export const declaredAbsences = sqliteTable(
  'declared_absences',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    /** Bornes incluses. */
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    kind: text('kind').notNull(),
    /** Mot pour mot ce que l'athlète a dit — jamais la reformulation du coach. */
    reason: text('reason').notNull(),
    source: text('source').notNull().default('athlete'),
    declaredAt: text('declared_at').notNull().default(now),
    /** Point du jour d'où vient la phrase, s'il y en a un. */
    checkInDate: text('check_in_date'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => ({ byAthleteDate: index('absences_athlete_date_idx').on(t.athleteId, t.startDate) }),
);

export const coachInsights = sqliteTable(
  'coach_insights',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    refId: text('ref_id'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    actions: text('actions', { mode: 'json' }).notNull(),
    highlights: text('highlights', { mode: 'json' }).notNull(),
    severity: text('severity').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => ({ byAthlete: index('insights_athlete_idx').on(t.athleteId, t.createdAt) }),
);

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    content: text('content').notNull(),
    toolCalls: text('tool_calls', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => ({ byAthlete: index('chat_athlete_idx').on(t.athleteId, t.createdAt) }),
);

export const gear = sqliteTable('gear', {
  id: text('id').primaryKey(),
  athleteId: text('athlete_id').notNull().references(() => athletes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  brandModel: text('brand_model'),
  /** Distance cumulée, m — sert à l'alerte d'usure. */
  distanceM: real('distance_m').notNull().default(0),
  retired: integer('retired', { mode: 'boolean' }).notNull().default(false),
  /** Kilométrage de remplacement conseillé. */
  replaceAtKm: integer('replace_at_km').default(800),
});

export const syncState = sqliteTable('sync_state', {
  athleteId: text('athlete_id').primaryKey().references(() => athletes.id, { onDelete: 'cascade' }),
  /** Date de début de la dernière activité importée (epoch s). */
  lastActivityEpoch: integer('last_activity_epoch').notNull().default(0),
  lastFullSyncAt: text('last_full_sync_at'),
  lastWebhookAt: text('last_webhook_at'),
  /** Identifiant de la souscription webhook Strava. */
  webhookSubscriptionId: integer('webhook_subscription_id'),
  status: text('status').notNull().default('idle'),
  message: text('message'),
});

export const webhookEvents = sqliteTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    objectType: text('object_type').notNull(),
    objectId: integer('object_id').notNull(),
    aspectType: text('aspect_type').notNull(),
    ownerId: integer('owner_id').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    processedAt: text('processed_at'),
    error: text('error'),
    receivedAt: text('received_at').notNull().default(now),
  },
  (t) => ({ byProcessed: index('webhooks_processed_idx').on(t.processedAt) }),
);

/**
 * Les séances que Cairn a créées sur Garmin Connect.
 *
 * C'est ce registre, et lui seul, qui dit ce qui appartient à Cairn sur le
 * calendrier Garmin : une séance absente d'ici n'est jamais modifiée ni
 * supprimée, quel que soit son nom. Une ligne par séance Garmin, identifiée par
 * son numéro chez Garmin ; une séance retirée garde sa ligne, marquée
 * `deleted`.
 *
 * Pas de clef étrangère ni de valeur par défaut calculée : la table décrit un
 * état extérieur qui ne disparaît pas avec l'athlète, et elle est créée au
 * démarrage par `ensureGarminTables` à partir de cette définition même.
 */
export const garminWorkouts = sqliteTable(
  'garmin_workouts',
  {
    workoutId: integer('workout_id').primaryKey(),
    athleteId: text('athlete_id').notNull(),
    /** Séance du plan au moment de l'envoi — une reconstruction peut en changer l'identifiant. */
    sessionId: text('session_id').notNull(),
    date: text('date').notNull(),
    /** Empreinte du contenu envoyé (`fingerprintOf`) : c'est elle qu'on compare au plan. */
    fingerprint: text('fingerprint').notNull(),
    name: text('name').notNull(),
    scheduleId: integer('schedule_id'),
    /** sending | verified | mismatch | deleted */
    state: text('state').notNull(),
    /** Écarts relevés à la relecture, en toutes lettres. */
    discrepancies: text('discrepancies', { mode: 'json' }),
    sentAt: text('sent_at'),
    verifiedAt: text('verified_at'),
    deletedAt: text('deleted_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byAthleteDate: index('garmin_workouts_athlete_date_idx').on(t.athleteId, t.date) }),
);

/** L'issue du dernier passage du réconciliateur Garmin, une ligne par athlète. */
export const garminSync = sqliteTable('garmin_sync', {
  athleteId: text('athlete_id').primaryKey(),
  /** ok | unreachable | reauth | error */
  outcome: text('outcome'),
  message: text('message'),
  lastRunAt: text('last_run_at'),
  lastSuccessAt: text('last_success_at'),
  /** Résumé de l'état voulu au dernier passage abouti : il change dès que le plan change. */
  signature: text('signature'),
  /** Échecs consécutifs — ils espacent les nouvelles tentatives. */
  failures: integer('failures').notNull(),
  watchName: text('watch_name'),
  watchSyncedAt: text('watch_synced_at'),
  /** Séances refusées par Garmin au dernier passage, et ce qu'il en a dit. */
  rejections: text('rejections', { mode: 'json' }),
});

export type AthleteRow = typeof athletes.$inferSelect;
export type ActivityRow = typeof activities.$inferSelect;
export type PlannedSessionRow = typeof plannedSessions.$inferSelect;
export type DeclaredAbsenceRow = typeof declaredAbsences.$inferSelect;
export type RaceGoalRow = typeof raceGoals.$inferSelect;
