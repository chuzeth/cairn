import type {
  Activity, ActivityAnalysis, ActivityStreams, AthleteProfile, ChatMessage,
  CoachInsight, DailyCheckIn, DeclaredAbsence, LabTest, PhysiologyModel, PlannedSession,
  RaceGoal, TrainingPlan, TrainingWeek,
} from '@cairn/core';
import type { GarminSyncState, LedgerEntry } from '@cairn/garmin';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { getDb, packStreams, unpackStreams } from './client.js';
import * as t from './schema.js';

/** Version du moteur d'analyse. Toute modification invalide les analyses en cache. */
/** 1.2.0 : l'analyse conserve la courbe de descente, pas seulement celle de montée. */
/** 1.3.0 : la durabilité porte la corrélation temps / D+, et ne mesure le dénivelé que là où il ne suit pas le temps. */
export const ENGINE_VERSION = '1.3.0';

const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
const dateKey = (iso: string) => iso.slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Athlète
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertAthlete(profile: AthleteProfile): Promise<void> {
  const db = getDb();
  await db
    .insert(t.athletes)
    .values({
      id: profile.id,
      name: profile.name,
      birthDate: profile.birthDate,
      sex: profile.sex,
      stravaAthleteId: profile.stravaAthleteId ?? null,
      constraints: profile.constraints,
      ambition: profile.ambition ?? null,
      preferences: profile.preferences,
    })
    .onConflictDoUpdate({
      target: t.athletes.id,
      set: {
        name: profile.name,
        stravaAthleteId: profile.stravaAthleteId ?? null,
        constraints: profile.constraints,
        ambition: profile.ambition ?? null,
        preferences: profile.preferences,
        updatedAt: new Date().toISOString(),
      },
    });

  for (const test of profile.labTests) {
    await db
      .insert(t.labTests)
      .values({ id: test.id, athleteId: profile.id, date: test.date, data: test })
      .onConflictDoUpdate({ target: t.labTests.id, set: { data: test } });
  }
}

export async function getAthlete(id: string): Promise<AthleteProfile | null> {
  const db = getDb();
  const [row] = await db.select().from(t.athletes).where(eq(t.athletes.id, id));
  if (!row) return null;
  const tests = await db
    .select()
    .from(t.labTests)
    .where(eq(t.labTests.athleteId, id))
    .orderBy(desc(t.labTests.date));
  return {
    id: row.id,
    name: row.name,
    birthDate: row.birthDate,
    sex: row.sex,
    stravaAthleteId: row.stravaAthleteId ?? undefined,
    labTests: tests.map((x) => x.data as LabTest),
    constraints: row.constraints as AthleteProfile['constraints'],
    ambition: (row.ambition as AthleteProfile['ambition']) ?? undefined,
    preferences: row.preferences as AthleteProfile['preferences'],
  };
}

export async function getAthleteByStravaId(stravaAthleteId: number): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: t.athletes.id })
    .from(t.athletes)
    .where(eq(t.athletes.stravaAthleteId, stravaAthleteId));
  return row?.id ?? null;
}

export async function updateConstraints(
  athleteId: string,
  constraints: AthleteProfile['constraints'],
): Promise<void> {
  await getDb()
    .update(t.athletes)
    .set({ constraints, updatedAt: new Date().toISOString() })
    .where(eq(t.athletes.id, athleteId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Jetons Strava & état de synchronisation
// ─────────────────────────────────────────────────────────────────────────────

export interface StravaTokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  stravaAthleteId: number;
}

export async function saveStravaTokens(athleteId: string, tokens: StravaTokenSet): Promise<void> {
  const db = getDb();
  await db
    .insert(t.stravaTokens)
    .values({ athleteId, ...tokens, scope: tokens.scope ?? null })
    .onConflictDoUpdate({
      target: t.stravaTokens.athleteId,
      set: { ...tokens, scope: tokens.scope ?? null, updatedAt: new Date().toISOString() },
    });
  await db
    .update(t.athletes)
    .set({ stravaAthleteId: tokens.stravaAthleteId })
    .where(eq(t.athletes.id, athleteId));
}

export async function getStravaTokens(athleteId: string): Promise<StravaTokenSet | null> {
  const [row] = await getDb().select().from(t.stravaTokens).where(eq(t.stravaTokens.athleteId, athleteId));
  if (!row) return null;
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scope: row.scope ?? undefined,
    stravaAthleteId: row.stravaAthleteId,
  };
}

export async function getSyncState(athleteId: string) {
  const [row] = await getDb().select().from(t.syncState).where(eq(t.syncState.athleteId, athleteId));
  return row ?? null;
}

export async function updateSyncState(
  athleteId: string,
  patch: Partial<typeof t.syncState.$inferInsert>,
): Promise<void> {
  const db = getDb();
  await db
    .insert(t.syncState)
    .values({ athleteId, ...patch })
    .onConflictDoUpdate({ target: t.syncState.athleteId, set: patch });
}

// ─────────────────────────────────────────────────────────────────────────────
// Activités
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertActivity(activity: Activity, raw?: unknown): Promise<void> {
  const values = {
    id: activity.id,
    athleteId: activity.athleteId,
    stravaId: activity.stravaId ?? null,
    name: activity.name,
    description: activity.description ?? null,
    sportType: activity.sportType,
    startDate: activity.startDate,
    startDateLocal: activity.startDateLocal,
    timezone: activity.timezone ?? null,
    distanceM: activity.distanceM,
    movingTimeS: activity.movingTimeS,
    elapsedTimeS: activity.elapsedTimeS,
    totalElevationGainM: activity.totalElevationGainM,
    totalElevationLossM: activity.totalElevationLossM,
    elevHighM: activity.elevHighM ?? null,
    elevLowM: activity.elevLowM ?? null,
    averageSpeedMs: activity.averageSpeedMs,
    maxSpeedMs: activity.maxSpeedMs ?? null,
    averageHr: activity.averageHr ?? null,
    maxHr: activity.maxHr ?? null,
    averageCadenceSpm: activity.averageCadenceSpm ?? null,
    averageWatts: activity.averageWatts ?? null,
    averageTempC: activity.averageTempC ?? null,
    calories: activity.calories ?? null,
    sufferScore: activity.sufferScore ?? null,
    gearId: activity.gearId ?? null,
    deviceName: activity.deviceName ?? null,
    trainer: activity.trainer ?? false,
    commute: activity.commute ?? false,
    manual: activity.manual ?? false,
    plannedSessionId: activity.plannedSessionId ?? null,
    rpe: activity.rpe ?? null,
    feel: activity.feel ?? null,
    raw: raw ?? null,
  };
  await getDb().insert(t.activities).values(values).onConflictDoUpdate({
    target: t.activities.id,
    set: values,
  });
}

function rowToActivity(row: typeof t.activities.$inferSelect): Activity {
  return {
    id: row.id,
    stravaId: row.stravaId ?? undefined,
    athleteId: row.athleteId,
    name: row.name,
    description: row.description ?? undefined,
    sportType: row.sportType as Activity['sportType'],
    startDate: row.startDate,
    startDateLocal: row.startDateLocal,
    timezone: row.timezone ?? undefined,
    distanceM: row.distanceM,
    movingTimeS: row.movingTimeS,
    elapsedTimeS: row.elapsedTimeS,
    totalElevationGainM: row.totalElevationGainM,
    totalElevationLossM: row.totalElevationLossM,
    elevHighM: row.elevHighM ?? undefined,
    elevLowM: row.elevLowM ?? undefined,
    averageSpeedMs: row.averageSpeedMs,
    maxSpeedMs: row.maxSpeedMs ?? undefined,
    averageHr: row.averageHr ?? undefined,
    maxHr: row.maxHr ?? undefined,
    averageCadenceSpm: row.averageCadenceSpm ?? undefined,
    averageWatts: row.averageWatts ?? undefined,
    averageTempC: row.averageTempC ?? undefined,
    calories: row.calories ?? undefined,
    sufferScore: row.sufferScore ?? undefined,
    gearId: row.gearId ?? undefined,
    deviceName: row.deviceName ?? undefined,
    trainer: row.trainer ?? false,
    commute: row.commute ?? false,
    manual: row.manual ?? false,
    plannedSessionId: row.plannedSessionId ?? undefined,
    rpe: row.rpe ?? undefined,
    feel: (row.feel ?? undefined) as Activity['feel'],
  };
}

export async function getActivity(id: string): Promise<Activity | null> {
  const [row] = await getDb().select().from(t.activities).where(eq(t.activities.id, id));
  return row ? rowToActivity(row) : null;
}

export async function getActivityByStravaId(stravaId: number): Promise<Activity | null> {
  const [row] = await getDb().select().from(t.activities).where(eq(t.activities.stravaId, stravaId));
  return row ? rowToActivity(row) : null;
}

export async function listActivities(
  athleteId: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<Activity[]> {
  const filters = [eq(t.activities.athleteId, athleteId)];
  if (opts.from) filters.push(gte(t.activities.startDateLocal, opts.from));
  if (opts.to) filters.push(lte(t.activities.startDateLocal, `${opts.to}T23:59:59`));
  const rows = await getDb()
    .select()
    .from(t.activities)
    .where(and(...filters))
    .orderBy(desc(t.activities.startDateLocal))
    .limit(opts.limit ?? 500);
  return rows.map(rowToActivity);
}

export async function deleteActivity(stravaId: number): Promise<void> {
  await getDb().delete(t.activities).where(eq(t.activities.stravaId, stravaId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Flux & analyses
// ─────────────────────────────────────────────────────────────────────────────

export async function saveStreams(
  activityId: string,
  streams: ActivityStreams,
  meta: { gpsQuality: string; hrCoverage: number },
): Promise<void> {
  const payload = packStreams(streams);
  await getDb()
    .insert(t.activityStreams)
    .values({
      activityId,
      payload,
      gpsQuality: meta.gpsQuality,
      hrCoverage: meta.hrCoverage,
      sampleCount: streams.time.length,
    })
    .onConflictDoUpdate({
      target: t.activityStreams.activityId,
      set: { payload, gpsQuality: meta.gpsQuality, hrCoverage: meta.hrCoverage, sampleCount: streams.time.length },
    });
}

export async function getStreams(
  activityId: string,
): Promise<{ streams: ActivityStreams; gpsQuality: string; hrCoverage: number } | null> {
  const [row] = await getDb()
    .select()
    .from(t.activityStreams)
    .where(eq(t.activityStreams.activityId, activityId));
  if (!row) return null;
  return {
    streams: unpackStreams<ActivityStreams>(row.payload as Buffer),
    gpsQuality: row.gpsQuality,
    hrCoverage: row.hrCoverage,
  };
}

export async function saveAnalysis(
  athleteId: string,
  activityDateLocal: string,
  analysis: ActivityAnalysis,
): Promise<void> {
  const values = {
    activityId: analysis.activityId,
    athleteId,
    data: analysis,
    metabolicLoad: analysis.load.metabolic,
    mechanicalLoad: analysis.load.mechanical,
    dateKey: dateKey(activityDateLocal),
    engineVersion: ENGINE_VERSION,
    computedAt: analysis.computedAt,
  };
  await getDb().insert(t.activityAnalyses).values(values).onConflictDoUpdate({
    target: t.activityAnalyses.activityId,
    set: values,
  });
}

export async function getAnalysis(activityId: string): Promise<ActivityAnalysis | null> {
  const [row] = await getDb()
    .select()
    .from(t.activityAnalyses)
    .where(eq(t.activityAnalyses.activityId, activityId));
  return row ? (row.data as ActivityAnalysis) : null;
}

export async function getAnalyses(activityIds: string[]): Promise<Map<string, ActivityAnalysis>> {
  if (activityIds.length === 0) return new Map();
  const rows = await getDb()
    .select()
    .from(t.activityAnalyses)
    .where(inArray(t.activityAnalyses.activityId, activityIds));
  return new Map(rows.map((r) => [r.activityId, r.data as ActivityAnalysis]));
}

/** Charges quotidiennes agrégées — entrée directe du PMC. */
export async function getDailyLoads(
  athleteId: string,
  from?: string,
): Promise<{ date: string; metabolic: number; mechanical: number }[]> {
  const filters = [eq(t.activityAnalyses.athleteId, athleteId)];
  if (from) filters.push(gte(t.activityAnalyses.dateKey, from));
  const rows = await getDb()
    .select({
      date: t.activityAnalyses.dateKey,
      metabolic: sql<number>`sum(${t.activityAnalyses.metabolicLoad})`,
      mechanical: sql<number>`sum(${t.activityAnalyses.mechanicalLoad})`,
    })
    .from(t.activityAnalyses)
    .where(and(...filters))
    .groupBy(t.activityAnalyses.dateKey)
    .orderBy(asc(t.activityAnalyses.dateKey));
  return rows.map((r) => ({ date: r.date, metabolic: r.metabolic ?? 0, mechanical: r.mechanical ?? 0 }));
}

/** Activités dont l'analyse est absente ou produite par une version périmée du moteur. */
export async function findStaleAnalyses(athleteId: string, limit = 200): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ id: t.activities.id, version: t.activityAnalyses.engineVersion })
    .from(t.activities)
    .leftJoin(t.activityAnalyses, eq(t.activities.id, t.activityAnalyses.activityId))
    .where(eq(t.activities.athleteId, athleteId))
    .orderBy(desc(t.activities.startDateLocal))
    .limit(limit);
  return rows.filter((r) => r.version !== ENGINE_VERSION).map((r) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Modèle physiologique
// ─────────────────────────────────────────────────────────────────────────────

export async function saveModel(athleteId: string, model: PhysiologyModel): Promise<void> {
  await getDb().insert(t.physiologyModels).values({
    id: uid('mdl'),
    athleteId,
    asOf: model.asOf,
    data: model,
  });
}

export async function getLatestModel(athleteId: string): Promise<PhysiologyModel | null> {
  const [row] = await getDb()
    .select()
    .from(t.physiologyModels)
    .where(eq(t.physiologyModels.athleteId, athleteId))
    .orderBy(desc(t.physiologyModels.createdAt))
    .limit(1);
  return row ? (row.data as PhysiologyModel) : null;
}

export async function getModelHistory(athleteId: string, limit = 40): Promise<PhysiologyModel[]> {
  const rows = await getDb()
    .select()
    .from(t.physiologyModels)
    .where(eq(t.physiologyModels.athleteId, athleteId))
    .orderBy(desc(t.physiologyModels.createdAt))
    .limit(limit);
  return rows.map((r) => r.data as PhysiologyModel);
}

// ─────────────────────────────────────────────────────────────────────────────
// Check-ins quotidiens
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertCheckIn(checkIn: DailyCheckIn): Promise<void> {
  // L'état de la note est écrit explicitement, à null quand il n'est pas fourni :
  // une note réécrite redevient une note dont rien n'a été fait, et l'appelant
  // doit reporter l'état s'il veut le conserver.
  const row = {
    ...checkIn,
    notes: checkIn.notes ?? null,
    noteHandledAt: checkIn.noteHandledAt ?? null,
    noteHandledAs: checkIn.noteHandledAs ?? null,
  };
  await getDb()
    .insert(t.dailyCheckIns)
    .values({ id: uid('chk'), ...row })
    .onConflictDoUpdate({ target: [t.dailyCheckIns.athleteId, t.dailyCheckIns.date], set: row });
}

export async function listCheckIns(athleteId: string, from?: string): Promise<DailyCheckIn[]> {
  const filters = [eq(t.dailyCheckIns.athleteId, athleteId)];
  if (from) filters.push(gte(t.dailyCheckIns.date, from));
  const rows = await getDb()
    .select()
    .from(t.dailyCheckIns)
    .where(and(...filters))
    .orderBy(asc(t.dailyCheckIns.date));
  return rows.map((r) => ({
    date: r.date,
    athleteId: r.athleteId,
    fatigue: r.fatigue ?? undefined,
    sleepHours: r.sleepHours ?? undefined,
    sleepQuality: r.sleepQuality ?? undefined,
    soreness: r.soreness ?? undefined,
    stress: r.stress ?? undefined,
    motivation: r.motivation ?? undefined,
    restingHr: r.restingHr ?? undefined,
    hrvRmssd: r.hrvRmssd ?? undefined,
    bodyMassKg: r.bodyMassKg ?? undefined,
    notes: r.notes ?? undefined,
    noteHandledAt: r.noteHandledAt ?? undefined,
    noteHandledAs: r.noteHandledAs ?? undefined,
  }));
}

/**
 * Sort une note de l'attente.
 *
 * `upsertCheckIn` ne peut pas le faire : il écrit ce que l'athlète déclare le
 * matin, et une note modifiée redevient à traiter. Ce qu'on marque ici, c'est
 * qu'on en a fait quelque chose.
 */
export async function markCheckInNoteHandled(
  athleteId: string,
  date: string,
  handledAs: string,
): Promise<void> {
  await getDb()
    .update(t.dailyCheckIns)
    .set({ noteHandledAt: new Date().toISOString(), noteHandledAs: handledAs })
    .where(and(eq(t.dailyCheckIns.athleteId, athleteId), eq(t.dailyCheckIns.date, date)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Absences déclarées
// ─────────────────────────────────────────────────────────────────────────────

function rowToAbsence(row: typeof t.declaredAbsences.$inferSelect): DeclaredAbsence {
  return {
    id: row.id,
    athleteId: row.athleteId,
    startDate: row.startDate,
    endDate: row.endDate,
    kind: row.kind as DeclaredAbsence['kind'],
    reason: row.reason,
    source: row.source as DeclaredAbsence['source'],
    declaredAt: row.declaredAt,
    checkInDate: row.checkInDate ?? undefined,
  };
}

export async function createAbsence(
  absence: Omit<DeclaredAbsence, 'id' | 'declaredAt'> & { id?: string; declaredAt?: string },
): Promise<DeclaredAbsence> {
  const row = {
    id: absence.id ?? uid('abs'),
    athleteId: absence.athleteId,
    startDate: absence.startDate,
    endDate: absence.endDate,
    kind: absence.kind,
    reason: absence.reason,
    source: absence.source,
    declaredAt: absence.declaredAt ?? new Date().toISOString(),
    checkInDate: absence.checkInDate ?? null,
  };
  await getDb().insert(t.declaredAbsences).values(row);
  return rowToAbsence({ ...row, createdAt: row.declaredAt });
}

/** Absences qui touchent la fenêtre demandée — bornes incluses des deux côtés. */
export async function listAbsences(
  athleteId: string,
  opts: { from?: string; to?: string } = {},
): Promise<DeclaredAbsence[]> {
  const filters = [eq(t.declaredAbsences.athleteId, athleteId)];
  // Une absence chevauche la fenêtre dès qu'elle ne s'achève pas avant son
  // début et ne commence pas après sa fin : filtrer sur `startDate` seul
  // perdrait une coupure en cours, c'est-à-dire le cas qui compte.
  if (opts.from) filters.push(gte(t.declaredAbsences.endDate, opts.from));
  if (opts.to) filters.push(lte(t.declaredAbsences.startDate, opts.to));
  const rows = await getDb()
    .select()
    .from(t.declaredAbsences)
    .where(and(...filters))
    .orderBy(asc(t.declaredAbsences.startDate));
  return rows.map(rowToAbsence);
}

export async function getAbsence(id: string): Promise<DeclaredAbsence | null> {
  const [row] = await getDb().select().from(t.declaredAbsences).where(eq(t.declaredAbsences.id, id));
  return row ? rowToAbsence(row) : null;
}

export async function deleteAbsence(id: string): Promise<void> {
  await getDb().delete(t.declaredAbsences).where(eq(t.declaredAbsences.id, id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Objectifs de course
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertRaceGoal(goal: RaceGoal): Promise<string> {
  const id = goal.id || uid('race');
  const values = {
    id,
    athleteId: goal.athleteId,
    name: goal.name,
    date: goal.date,
    priority: goal.priority,
    course: goal.course,
    target: goal.target ?? null,
    notes: goal.notes ?? null,
    updatedAt: new Date().toISOString(),
  };
  await getDb().insert(t.raceGoals).values(values).onConflictDoUpdate({
    target: t.raceGoals.id,
    set: values,
  });
  return id;
}

function rowToGoal(row: typeof t.raceGoals.$inferSelect): RaceGoal {
  return {
    id: row.id,
    athleteId: row.athleteId,
    name: row.name,
    date: row.date,
    priority: row.priority,
    course: row.course as RaceGoal['course'],
    target: (row.target ?? undefined) as RaceGoal['target'],
    notes: row.notes ?? undefined,
  };
}

export async function listRaceGoals(athleteId: string, fromDate?: string): Promise<RaceGoal[]> {
  const filters = [eq(t.raceGoals.athleteId, athleteId)];
  if (fromDate) filters.push(gte(t.raceGoals.date, fromDate));
  const rows = await getDb()
    .select()
    .from(t.raceGoals)
    .where(and(...filters))
    .orderBy(asc(t.raceGoals.date));
  return rows.map(rowToGoal);
}

export async function getRaceGoal(id: string): Promise<RaceGoal | null> {
  const [row] = await getDb().select().from(t.raceGoals).where(eq(t.raceGoals.id, id));
  return row ? rowToGoal(row) : null;
}

export async function deleteRaceGoal(id: string): Promise<void> {
  await getDb().delete(t.raceGoals).where(eq(t.raceGoals.id, id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans d'entraînement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ajoute aux séances les colonnes que le schéma déclare et que la base n'a pas
 * encore.
 *
 * Le service ne passe pas `db:push` : une colonne ajoutée au schéma manquerait
 * à la base réelle, et Drizzle, qui nomme toutes les colonnes qu'il connaît,
 * ferait tomber la première lecture du plan. Chaque processus — service,
 * serveur MCP, commandes — s'en assure donc lui-même, une fois, avant de lire
 * ou d'écrire une séance. Seule une colonne libre s'ajoute ainsi : c'est la
 * seule qu'un `ALTER TABLE` sait poser sur une table qui a déjà des lignes, et
 * en refuser une autre vaut mieux que la créer autrement que le schéma la dit.
 */
export async function ensureSessionColumns(): Promise<string[]> {
  const db = getDb();
  const c = getTableConfig(t.plannedSessions);
  const present = new Set(
    (await db.all<{ name: string }>(sql.raw(`PRAGMA table_info("${c.name}")`))).map((r) => r.name),
  );
  // Une table absente n'est pas une table en retard : c'est une base à créer.
  if (present.size === 0) return [];
  const added: string[] = [];
  for (const col of c.columns) {
    if (present.has(col.name)) continue;
    if (col.notNull || col.hasDefault || col.primary) {
      throw new Error(`${c.name}.${col.name} : colonne contrainte absente de la base — lance db:push.`);
    }
    await db.run(sql.raw(`ALTER TABLE "${c.name}" ADD COLUMN "${col.name}" ${col.getSQLType()}`));
    added.push(col.name);
  }
  return added;
}

let sessionColumnsReady: Promise<unknown> | null = null;
/** Une fois par processus ; un échec se retente à l'appel suivant. */
function sessionColumns(): Promise<unknown> {
  sessionColumnsReady ??= ensureSessionColumns().catch((e) => {
    sessionColumnsReady = null;
    throw e;
  });
  return sessionColumnsReady;
}

export async function savePlan(plan: TrainingPlan, weeks: TrainingWeek[]): Promise<void> {
  await sessionColumns();
  const db = getDb();

  // Les plans précédents sont supprimés, pas seulement désactivés — leurs
  // séances partent avec eux (cascade). Les conserver produirait des doublons
  // dans toutes les vues, qui interrogent par athlète et par date : on verrait
  // trois fois la même journée après trois reconstructions. L'historique des
  // décisions est porté par `revisionLog`, reporté d'un plan au suivant, et par
  // les séances elles-mêmes : celles qui portent une décision sont reprises
  // dans le plan neuf (`carryDecisions`) avant d'arriver ici. Ce qui n'y est
  // pas au moment de l'appel est perdu — cette fonction ne rattrape rien.
  await db
    .delete(t.trainingPlans)
    .where(and(eq(t.trainingPlans.athleteId, plan.athleteId), ne(t.trainingPlans.id, plan.id)));
  await db
    .insert(t.trainingPlans)
    .values({
      id: plan.id,
      athleteId: plan.athleteId,
      goalRaceId: plan.goalRaceId,
      targetRaceDayTsb: plan.targetRaceDayTsb,
      projectedRaceDayTsb: plan.projectedRaceDayTsb ?? null,
      raceDayTsbShortfall: plan.raceDayTsbShortfall ?? null,
      active: true,
      revisionLog: plan.revisionLog,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: t.trainingPlans.id,
      set: {
        active: true,
        projectedRaceDayTsb: plan.projectedRaceDayTsb ?? null,
        raceDayTsbShortfall: plan.raceDayTsbShortfall ?? null,
        revisionLog: plan.revisionLog,
        updatedAt: new Date().toISOString(),
      },
    });

  await db.delete(t.plannedSessions).where(eq(t.plannedSessions.planId, plan.id));
  const rows = weeks.flatMap((w) => w.sessions.map((s) => sessionRow(plan.id, plan.athleteId, s, w)));
  // SQLite plafonne le nombre de variables liées : on insère par lots.
  for (let i = 0; i < rows.length; i += 40) {
    const batch = rows.slice(i, i + 40);
    if (batch.length) await db.insert(t.plannedSessions).values(batch);
  }
}

/**
 * Ajoute une séance au plan en place, dans sa semaine.
 *
 * Seules les règles de charge écrivent ainsi une séance hors reconstruction :
 * le lendemain d'une séance clef réalisée un autre jour, quand il est vide.
 */
export async function insertSession(
  planId: string,
  s: PlannedSession,
  week: Pick<TrainingWeek, 'weekStart' | 'phase'>,
): Promise<void> {
  await sessionColumns();
  await getDb().insert(t.plannedSessions).values(sessionRow(planId, s.athleteId, s, week));
}

function sessionRow(
  planId: string,
  athleteId: string,
  s: PlannedSession,
  week: Pick<TrainingWeek, 'weekStart' | 'phase'>,
): typeof t.plannedSessions.$inferInsert {
  return {
    id: s.id,
    planId,
    athleteId,
    date: s.date,
    plannedDate: s.plannedDate ?? null,
    weekStart: week.weekStart,
    phase: week.phase,
    type: s.type,
    title: s.title,
    intent: s.intent,
    blocks: s.blocks,
    plannedLoad: s.plannedLoad,
    plannedMechanicalLoad: s.plannedMechanicalLoad,
    plannedDurationS: s.plannedDurationS,
    plannedDistanceM: s.plannedDistanceM ?? null,
    plannedElevationGainM: s.plannedElevationGainM ?? null,
    priority: s.priority,
    status: s.status,
    completedActivityId: s.completedActivityId ?? null,
    absenceId: s.absenceId ?? null,
    rationale: s.rationale ?? null,
    decision: s.decision ?? null,
    successCriteria: s.successCriteria ?? null,
    directives: s.directives ?? null,
    history: s.history?.length ? s.history : null,
  };
}

export async function getActivePlan(
  athleteId: string,
): Promise<{ plan: TrainingPlan; weeks: TrainingWeek[] } | null> {
  await sessionColumns();
  const db = getDb();
  const [planRow] = await db
    .select()
    .from(t.trainingPlans)
    .where(and(eq(t.trainingPlans.athleteId, athleteId), eq(t.trainingPlans.active, true)))
    .limit(1);
  if (!planRow) return null;

  const sessions = await db
    .select()
    .from(t.plannedSessions)
    .where(eq(t.plannedSessions.planId, planRow.id))
    .orderBy(asc(t.plannedSessions.date));

  const byWeek = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byWeek.get(s.weekStart) ?? [];
    list.push(s);
    byWeek.set(s.weekStart, list);
  }

  const weeks: TrainingWeek[] = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, list], index) => ({
      weekStart,
      index,
      phase: (list[0]?.phase ?? 'base') as TrainingWeek['phase'],
      targetLoad: list.reduce((a, s) => a + s.plannedLoad, 0),
      plannedDurationS: list
        .filter((s) => s.type !== 'race')
        .reduce((a, s) => a + s.plannedDurationS, 0),
      targetElevationGainM: list.reduce((a, s) => a + (s.plannedElevationGainM ?? 0), 0),
      intensityDistribution: { low: 0, moderate: 0, high: 0 },
      isDeload: false,
      focus: '',
      sessions: list.map(rowToSession),
    }));

  return {
    plan: {
      id: planRow.id,
      athleteId: planRow.athleteId,
      createdAt: planRow.createdAt,
      updatedAt: planRow.updatedAt,
      goalRaceId: planRow.goalRaceId,
      weeks,
      targetRaceDayTsb: planRow.targetRaceDayTsb,
      projectedRaceDayTsb: planRow.projectedRaceDayTsb ?? undefined,
      raceDayTsbShortfall: planRow.raceDayTsbShortfall ?? undefined,
      revisionLog: planRow.revisionLog as TrainingPlan['revisionLog'],
    },
    weeks,
  };
}

function rowToSession(row: typeof t.plannedSessions.$inferSelect): PlannedSession {
  return {
    id: row.id,
    athleteId: row.athleteId,
    date: row.date,
    plannedDate: row.plannedDate ?? undefined,
    type: row.type as PlannedSession['type'],
    title: row.title,
    intent: row.intent,
    blocks: row.blocks as PlannedSession['blocks'],
    plannedLoad: row.plannedLoad,
    plannedMechanicalLoad: row.plannedMechanicalLoad,
    plannedDurationS: row.plannedDurationS,
    plannedDistanceM: row.plannedDistanceM ?? undefined,
    plannedElevationGainM: row.plannedElevationGainM ?? undefined,
    priority: row.priority,
    status: row.status as PlannedSession['status'],
    completedActivityId: row.completedActivityId ?? undefined,
    absenceId: row.absenceId ?? undefined,
    rationale: row.rationale ?? undefined,
    decision: (row.decision as PlannedSession['decision']) ?? undefined,
    successCriteria: (row.successCriteria as PlannedSession['successCriteria']) ?? undefined,
    directives: (row.directives as PlannedSession['directives']) ?? undefined,
    history: (row.history as PlannedSession['history']) ?? undefined,
  };
}

export async function listPlannedSessions(
  athleteId: string,
  from: string,
  to: string,
): Promise<PlannedSession[]> {
  await sessionColumns();
  const db = getDb();
  // Double sécurité : on ne renvoie que les séances du plan actif, même si un
  // plan orphelin subsistait en base.
  const [active] = await db
    .select({ id: t.trainingPlans.id })
    .from(t.trainingPlans)
    .where(and(eq(t.trainingPlans.athleteId, athleteId), eq(t.trainingPlans.active, true)))
    .limit(1);
  if (!active) return [];

  const rows = await db
    .select()
    .from(t.plannedSessions)
    .where(
      and(
        eq(t.plannedSessions.planId, active.id),
        gte(t.plannedSessions.date, from),
        lte(t.plannedSessions.date, to),
      ),
    )
    .orderBy(asc(t.plannedSessions.date));
  return rows.map(rowToSession);
}

export async function updateSession(id: string, patch: Partial<typeof t.plannedSessions.$inferInsert>): Promise<void> {
  await sessionColumns();
  await getDb()
    .update(t.plannedSessions)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(t.plannedSessions.id, id));
}

export async function appendPlanRevision(
  planId: string,
  revision: TrainingPlan['revisionLog'][number],
): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(t.trainingPlans).where(eq(t.trainingPlans.id, planId));
  if (!row) return;
  const log = [...((row.revisionLog as TrainingPlan['revisionLog']) ?? []), revision];
  await db
    .update(t.trainingPlans)
    .set({ revisionLog: log, updatedAt: new Date().toISOString() })
    .where(eq(t.trainingPlans.id, planId));
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyses du coach & conversation
// ─────────────────────────────────────────────────────────────────────────────

export async function saveInsight(insight: Omit<CoachInsight, 'id'> & { id?: string }): Promise<string> {
  const id = insight.id ?? uid('ins');
  await getDb().insert(t.coachInsights).values({
    id,
    athleteId: insight.athleteId,
    scope: insight.scope,
    refId: insight.refId ?? null,
    title: insight.title,
    body: insight.body,
    actions: insight.actions,
    highlights: insight.highlights,
    severity: insight.severity,
    createdAt: insight.createdAt,
  });
  return id;
}

export async function listInsights(athleteId: string, limit = 30): Promise<CoachInsight[]> {
  const rows = await getDb()
    .select()
    .from(t.coachInsights)
    .where(eq(t.coachInsights.athleteId, athleteId))
    .orderBy(desc(t.coachInsights.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    athleteId: r.athleteId,
    createdAt: r.createdAt,
    scope: r.scope as CoachInsight['scope'],
    refId: r.refId ?? undefined,
    title: r.title,
    body: r.body,
    actions: r.actions as string[],
    highlights: r.highlights as CoachInsight['highlights'],
    severity: r.severity as CoachInsight['severity'],
  }));
}

export async function getInsightForActivity(activityId: string): Promise<CoachInsight | null> {
  const [row] = await getDb()
    .select()
    .from(t.coachInsights)
    .where(and(eq(t.coachInsights.scope, 'activity'), eq(t.coachInsights.refId, activityId)))
    .orderBy(desc(t.coachInsights.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    athleteId: row.athleteId,
    createdAt: row.createdAt,
    scope: 'activity',
    refId: row.refId ?? undefined,
    title: row.title,
    body: row.body,
    actions: row.actions as string[],
    highlights: row.highlights as CoachInsight['highlights'],
    severity: row.severity as CoachInsight['severity'],
  };
}

export async function appendChatMessage(msg: Omit<ChatMessage, 'id'> & { id?: string }): Promise<string> {
  const id = msg.id ?? uid('msg');
  await getDb().insert(t.chatMessages).values({
    id,
    athleteId: msg.athleteId,
    role: msg.role,
    content: msg.content,
    toolCalls: msg.toolCalls ?? null,
    createdAt: msg.createdAt,
  });
  return id;
}

export async function listChatMessages(athleteId: string, limit = 60): Promise<ChatMessage[]> {
  const rows = await getDb()
    .select()
    .from(t.chatMessages)
    .where(eq(t.chatMessages.athleteId, athleteId))
    .orderBy(desc(t.chatMessages.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    athleteId: r.athleteId,
    role: r.role,
    content: r.content,
    createdAt: r.createdAt,
    toolCalls: (r.toolCalls ?? undefined) as ChatMessage['toolCalls'],
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Matériel & webhooks
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertGear(
  athleteId: string,
  g: { id: string; name: string; brandModel?: string; distanceM: number; retired?: boolean },
): Promise<void> {
  const values = {
    id: g.id,
    athleteId,
    name: g.name,
    brandModel: g.brandModel ?? null,
    distanceM: g.distanceM,
    retired: g.retired ?? false,
  };
  await getDb().insert(t.gear).values(values).onConflictDoUpdate({ target: t.gear.id, set: values });
}

export async function listGear(athleteId: string) {
  return getDb().select().from(t.gear).where(eq(t.gear.athleteId, athleteId));
}

export async function recordWebhookEvent(event: {
  objectType: string;
  objectId: number;
  aspectType: string;
  ownerId: number;
  payload: unknown;
}): Promise<string> {
  const id = uid('whk');
  await getDb().insert(t.webhookEvents).values({ id, ...event });
  return id;
}

export async function markWebhookProcessed(id: string, error?: string): Promise<void> {
  await getDb()
    .update(t.webhookEvents)
    .set({ processedAt: new Date().toISOString(), error: error ?? null })
    .where(eq(t.webhookEvents.id, id));
}

export async function pendingWebhookEvents(limit = 25) {
  return getDb()
    .select()
    .from(t.webhookEvents)
    .where(isNull(t.webhookEvents.processedAt))
    .orderBy(asc(t.webhookEvents.receivedAt))
    .limit(limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// Garmin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Crée les tables Garmin si elles manquent.
 *
 * Le service ne passe pas `db:push` : une table ajoutée au schéma n'existerait
 * pas sur la base réelle, et la première lecture ferait tomber /api/plan. Les
 * instructions sont écrites depuis la définition Drizzle elle-même — une seule
 * description de la table, pas deux qui divergeraient.
 */
export async function ensureGarminTables(): Promise<void> {
  const db = getDb();
  for (const table of [t.garminWorkouts, t.garminSync]) {
    for (const statement of createStatements(table)) await db.run(sql.raw(statement));
  }
}

/** Les tables Garmin existent-elles ? Une commande qui ne fait que lire n'a pas à les créer. */
export async function hasGarminTables(): Promise<boolean> {
  const rows = await getDb().all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' and name in ('garmin_workouts', 'garmin_sync')`,
  );
  return rows.length === 2;
}

/** `CREATE TABLE IF NOT EXISTS` et ses index, lus sur une table Drizzle sans valeur par défaut. */
export function createStatements(table: SQLiteTable): string[] {
  const c = getTableConfig(table);
  const columns = c.columns.map((col) => {
    // Une clef entière est l'alias du rowid : Drizzle la dit « par défaut », SQLite la fournit.
    if (col.hasDefault && !col.primary) {
      throw new Error(`${c.name}.${col.name} : une valeur par défaut ne se recopie pas ici.`);
    }
    return `"${col.name}" ${col.getSQLType()}${col.primary ? ' PRIMARY KEY' : ''}${col.notNull ? ' NOT NULL' : ''}`;
  });
  return [
    `CREATE TABLE IF NOT EXISTS "${c.name}" (${columns.join(', ')})`,
    ...c.indexes.map((i) => {
      const on = i.config.columns.map((col) => `"${(col as SQLiteColumn).name}"`).join(', ');
      return `CREATE ${i.config.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${i.config.name}" ON "${c.name}" (${on})`;
    }),
  ];
}

function rowToLedger(row: typeof t.garminWorkouts.$inferSelect): LedgerEntry {
  return {
    workoutId: row.workoutId,
    scheduleId: row.scheduleId ?? null,
    sessionId: row.sessionId,
    date: row.date,
    fingerprint: row.fingerprint,
    name: row.name,
    state: row.state as LedgerEntry['state'],
    discrepancies: (row.discrepancies as string[] | null) ?? null,
    sentAt: row.sentAt ?? null,
    verifiedAt: row.verifiedAt ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

/** Les séances que Cairn a créées sur Garmin et qui y sont encore — ou toutes, historique compris. */
export async function listGarminWorkouts(
  athleteId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<LedgerEntry[]> {
  const filters = [eq(t.garminWorkouts.athleteId, athleteId)];
  if (!opts.includeDeleted) filters.push(ne(t.garminWorkouts.state, 'deleted'));
  const rows = await getDb()
    .select()
    .from(t.garminWorkouts)
    .where(and(...filters))
    .orderBy(asc(t.garminWorkouts.date), asc(t.garminWorkouts.createdAt));
  return rows.map(rowToLedger);
}

export async function insertGarminWorkout(athleteId: string, entry: LedgerEntry): Promise<void> {
  const at = new Date().toISOString();
  await getDb().insert(t.garminWorkouts).values({ ...entry, athleteId, createdAt: at, updatedAt: at });
}

export async function updateGarminWorkout(workoutId: number, patch: Partial<LedgerEntry>): Promise<void> {
  const { workoutId: _ignored, ...rest } = patch;
  await getDb()
    .update(t.garminWorkouts)
    .set({ ...rest, updatedAt: new Date().toISOString() })
    .where(eq(t.garminWorkouts.workoutId, workoutId));
}

export interface GarminSyncRow extends GarminSyncState {
  signature: string | null;
  failures: number;
}

export async function getGarminSync(athleteId: string): Promise<GarminSyncRow | null> {
  const [row] = await getDb().select().from(t.garminSync).where(eq(t.garminSync.athleteId, athleteId));
  if (!row) return null;
  return {
    outcome: (row.outcome as GarminSyncRow['outcome']) ?? null,
    message: row.message ?? null,
    lastRunAt: row.lastRunAt ?? null,
    lastSuccessAt: row.lastSuccessAt ?? null,
    signature: row.signature ?? null,
    failures: row.failures,
    watchName: row.watchName ?? null,
    watchSyncedAt: row.watchSyncedAt ?? null,
    rejections: (row.rejections as GarminSyncRow['rejections'] | null) ?? [],
  };
}

export async function saveGarminSync(athleteId: string, patch: Partial<GarminSyncRow>): Promise<void> {
  const values = { failures: 0, ...patch, athleteId };
  await getDb()
    .insert(t.garminSync)
    .values(values)
    .onConflictDoUpdate({ target: t.garminSync.athleteId, set: patch });
}
