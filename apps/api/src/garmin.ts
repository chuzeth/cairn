import * as db from '@cairn/db';
import {
  GarminConnect, GarminReauthRequired, GarminUnreachable, SessionFile, addDays, desiredState, garminView, reconcile,
  HORIZON_DAYS, type DesiredState, type GarminApi, type GarminOutcome, type GarminView, type LedgerStore,
  type ReconcileReport,
} from '@cairn/garmin';

/**
 * La liaison Garmin du service : quand réconcilier, et ce qu'on en garde.
 *
 * Le plan change depuis trois processus — l'API, le serveur MCP, le terminal —
 * et aucun ne prévient les autres. Plutôt que d'accrocher un envoi à chaque
 * chemin d'écriture, la boucle relit chaque minute l'état voulu dans la base :
 * une lecture de sept jours de séances, sans un appel à Garmin. Elle ne parle à
 * Garmin que si cet état a changé depuis le dernier passage abouti, ou si la
 * dernière relecture du calendrier a plus d'une heure.
 *
 * Elle ne tourne que dans le service installé. `npm run dev` la coupe
 * (`CAIRN_GARMIN_CHECK_MIN=0`) : deux réconciliateurs sur le même compte se
 * marcheraient dessus comme deux relèves sur la même base.
 */

/** Relecture périodique du calendrier Garmin, par défaut. */
export const DEFAULT_GARMIN_CHECK_MS = 60 * 60_000;
/** La boucle relit la base à cette cadence, en relisant l'heure : un réveil du Mac se rattrape dans la minute. */
const TICK_MS = 60_000;

/** La date du jour sur le calendrier de Pierre — locale, comme celle de Garmin. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function loadDesired(athleteId: string, today: string): Promise<DesiredState> {
  const sessions = await db.listPlannedSessions(athleteId, today, addDays(today, HORIZON_DAYS - 1));
  return desiredState(sessions, today);
}

export function ledgerStore(athleteId: string): LedgerStore {
  return {
    list: () => db.listGarminWorkouts(athleteId),
    insert: (entry) => db.insertGarminWorkout(athleteId, entry),
    update: (workoutId, patch) => db.updateGarminWorkout(workoutId, patch),
  };
}

/** Ce que l'écran affiche : l'état de chaque séance des sept jours, et celui de la liaison. */
export async function garminPlanView(athleteId: string, session = new SessionFile()): Promise<GarminView> {
  const today = localToday();
  const [sessions, ledger, sync] = await Promise.all([
    db.listPlannedSessions(athleteId, today, addDays(today, HORIZON_DAYS - 1)),
    db.listGarminWorkouts(athleteId),
    db.getGarminSync(athleteId),
  ]);
  return garminView({ today, sessions, ledger, sync, connected: session.exists() });
}

export interface GarminRun {
  outcome: GarminOutcome;
  report?: ReconcileReport;
  message: string;
}

/** Un passage complet, et sa trace dans `garmin_sync` quelle qu'en soit l'issue. */
export async function syncGarmin(
  athleteId: string,
  deps: { session?: SessionFile; api?: GarminApi; now?: () => Date } = {},
): Promise<GarminRun> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const state = await loadDesired(athleteId, localToday(now()));
  const before = await db.getGarminSync(athleteId);
  try {
    const api = deps.api ?? new GarminConnect(deps.session ?? new SessionFile());
    const report = await reconcile(api, ledgerStore(athleteId), state, now);
    const message = describeRun(report);
    await db.saveGarminSync(athleteId, {
      outcome: 'ok',
      message,
      lastRunAt: startedAt,
      lastSuccessAt: now().toISOString(),
      signature: state.signature,
      failures: 0,
      watchName: report.watch?.name ?? before?.watchName ?? null,
      watchSyncedAt: report.watch?.syncedAt ?? before?.watchSyncedAt ?? null,
      rejections: report.rejected,
    });
    return { outcome: 'ok', report, message };
  } catch (e) {
    const outcome: GarminOutcome =
      e instanceof GarminReauthRequired ? 'reauth' : e instanceof GarminUnreachable ? 'unreachable' : 'error';
    const message = e instanceof Error ? e.message : String(e);
    await db.saveGarminSync(athleteId, {
      outcome,
      message,
      lastRunAt: startedAt,
      failures: (before?.failures ?? 0) + 1,
    });
    return { outcome, message };
  }
}

export function describeRun(r: ReconcileReport): string {
  const parts = [
    r.created && `${r.created} créée${r.created > 1 ? 's' : ''}`,
    r.removed && `${r.removed} retirée${r.removed > 1 ? 's' : ''}`,
    r.mismatched && `${r.mismatched} en écart`,
    r.rejected.length && `${r.rejected.length} refusée${r.rejected.length > 1 ? 's' : ''} par Garmin`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : `rien à changer (${r.kept} en place)`;
}

/**
 * Faut-il parler à Garmin maintenant ?
 *
 * Après un échec, les tentatives s'espacent — 2, 4, 8… minutes, une heure au
 * plus : un quota atteint ne se lève pas en insistant. Une session morte
 * n'est retentée que lorsque le fichier de session a changé : seul Pierre
 * peut la rétablir, et le dire toutes les minutes à Garmin n'y changerait rien.
 */
export function garminDue(input: {
  signature: string;
  sync: db.GarminSyncRow | null;
  now: number;
  checkEveryMs: number;
  sessionWrittenAt: number | null;
}): boolean {
  const { sync, now } = input;
  if (!sync?.outcome || !sync.lastRunAt) return true;
  const since = now - Date.parse(sync.lastRunAt);
  if (sync.outcome === 'reauth') return (input.sessionWrittenAt ?? 0) > Date.parse(sync.lastRunAt);
  if (sync.outcome !== 'ok') return since >= Math.min(60, 2 ** Math.max(1, sync.failures)) * 60_000;
  return sync.signature !== input.signature || since >= input.checkEveryMs;
}

export class GarminLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastTickAt: number | null = null;

  constructor(
    private readonly opts: {
      athleteId: string;
      checkEveryMs: number;
      session?: SessionFile;
      now?: () => number;
      log?: (level: 'info' | 'warn', message: string) => void;
    },
  ) {}

  get enabled(): boolean {
    return this.opts.checkEveryMs > 0;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    const loop = () => {
      this.timer = setTimeout(() => void this.tick().finally(loop), TICK_MS);
      this.timer.unref?.();
    };
    void this.tick().finally(loop);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      lastTickAt: this.lastTickAt == null ? null : new Date(this.lastTickAt).toISOString(),
    };
  }

  async tick(): Promise<GarminRun | null> {
    if (this.running) return null;
    const session = this.opts.session ?? new SessionFile();
    const now = this.opts.now ?? Date.now;
    this.lastTickAt = now();
    // Jamais connecté : rien à dire à Garmin, rien à affirmer.
    if (!session.exists() && (await db.listGarminWorkouts(this.opts.athleteId)).length === 0) return null;
    this.running = true;
    try {
      const [state, sync] = await Promise.all([
        loadDesired(this.opts.athleteId, localToday(new Date(now()))),
        db.getGarminSync(this.opts.athleteId),
      ]);
      const due = garminDue({
        signature: state.signature,
        sync,
        now: now(),
        checkEveryMs: this.opts.checkEveryMs,
        sessionWrittenAt: session.mtimeMs(),
      });
      if (!due) return null;
      const run = await syncGarmin(this.opts.athleteId, { session, now: () => new Date(now()) });
      if (run.outcome !== 'ok') this.opts.log?.('warn', `Garmin : ${run.message}`);
      else if (run.report && (run.report.created || run.report.removed)) this.opts.log?.('info', `Garmin : ${run.message}`);
      return run;
    } catch (e) {
      this.opts.log?.('warn', `Garmin : ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}

let active: GarminLoop | null = null;

export function startGarminLoop(opts: ConstructorParameters<typeof GarminLoop>[0]): GarminLoop {
  active?.stop();
  active = new GarminLoop(opts);
  active.start();
  return active;
}

export function stopGarminLoop(): void {
  active?.stop();
  active = null;
}

export function garminLoopStatus() {
  return active?.status() ?? null;
}
