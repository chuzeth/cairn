import * as db from '@cairn/db';
import type { BackfillProgress } from './sync.js';

/**
 * Relève périodique des nouvelles activités.
 *
 * Le webhook Strava suppose une URL publique : pour un athlète unique qui
 * travaille en local, cela veut dire ouvrir cette machine par un tunnel. Une
 * relève à intervalle régulier obtient le même résultat sans rien exposer.
 *
 * ── Cadence : un quart d'heure ────────────────────────────────────────────
 * Le quota Strava est de 100 requêtes par fenêtre de 15 min et 1 000 par jour.
 * Une relève à vide coûte 1 requête (la liste, vide) ; une relève qui trouve
 * une séance en coûte 4 (liste, détail, flux, matériel). À raison d'une par
 * quart d'heure, la relève consomme donc au pire 4 des 100 requêtes de chaque
 * fenêtre courte, et une centaine des 1 000 quotidiennes. Elle ne peut jamais
 * être ce qui sature le quota, et laisse la fenêtre entière disponible pour un
 * import manuel lancé en parallèle.
 *
 * Plus court n'achèterait rien : l'athlète court une fois par jour, et gagner
 * dix minutes sur un évènement quotidien ne change rien tout en triplant la
 * consommation. Plus long repousserait au lendemain l'analyse d'une sortie du
 * soir, donc l'ajustement de la séance du lendemain — qui est précisément ce
 * que la relève sert à rendre possible.
 *
 * ── Tolérance aux pannes ──────────────────────────────────────────────────
 * Quota atteint, réseau coupé, jeton expiré : l'issue est enregistrée et
 * l'horloge continue. Une relève qui échoue n'empêche jamais la suivante ; le
 * seul effet d'un échec est de rester visible dans `/health`.
 */

/** Intervalle par défaut : voir l'argument de cadence ci-dessus. */
export const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;

/**
 * Pendant la veille du Mac, l'heure avance mais rien ne garantit que le délai
 * d'un minuteur compte ce temps : une relève due à 3 h partirait un quart
 * d'heure après le réveil, ou plus. L'attente relit donc l'heure au moins
 * chaque minute, et une échéance dépassée pendant le sommeil se rattrape dans
 * la minute qui suit le réveil.
 */
const WAKE_CHECK_MS = 60_000;

export type PollOutcome = 'ok' | 'rate-limited' | 'error';

export interface PollerStatus {
  enabled: boolean;
  intervalMs: number;
  /** Vrai pendant l'exécution d'une relève. */
  running: boolean;
  /** Instant de la prochaine relève programmée, ou `null` si aucune ne l'est. */
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: PollOutcome | null;
  lastMessage: string | null;
  lastIngested: number;
  /** Relèves effectuées depuis le démarrage du processus. */
  runs: number;
  /** Activités importées par la relève depuis le démarrage. */
  ingested: number;
  /** Échecs consécutifs — remis à zéro dès qu'une relève aboutit. */
  consecutiveFailures: number;
}

/** Signature de `backfill`, injectable pour tester la relève sans réseau. */
export type BackfillFn = (
  athleteId: string,
  opts: { sinceEpoch?: number; maxActivities?: number; withInsights?: boolean },
) => Promise<BackfillProgress>;

export interface PollerOptions {
  athleteId: string;
  /** `0` ou négatif désactive la relève. */
  intervalMs?: number;
  run: BackfillFn;
  /**
   * Instant du dernier import abouti (epoch ms). Il évite de relancer une
   * relève à chaque redémarrage du processus — en développement, `tsx watch`
   * en provoque un à chaque sauvegarde de fichier.
   */
  lastSuccessAt?: () => Promise<number | null>;
  now?: () => number;
  log?: (level: 'info' | 'warn', message: string) => void;
}

const iso = (ms: number | null) => (ms == null ? null : new Date(ms).toISOString());

export class ActivityPoller {
  private readonly athleteId: string;
  private readonly intervalMs: number;
  private readonly run: BackfillFn;
  private readonly lastSuccessAt: () => Promise<number | null>;
  private readonly now: () => number;
  private readonly log: (level: 'info' | 'warn', message: string) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private running = false;
  private nextRunAt: number | null = null;
  private lastRunAt: number | null = null;
  private lastOutcome: PollOutcome | null = null;
  private lastMessage: string | null = null;
  private lastIngested = 0;
  private runs = 0;
  private ingested = 0;
  private consecutiveFailures = 0;

  constructor(opts: PollerOptions) {
    this.athleteId = opts.athleteId;
    this.intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.run = opts.run;
    this.lastSuccessAt =
      opts.lastSuccessAt ??
      (async () => {
        const state = await db.getSyncState(this.athleteId);
        const at = state?.lastFullSyncAt ? Date.parse(state.lastFullSyncAt) : NaN;
        return Number.isFinite(at) ? at : null;
      });
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  /**
   * Démarre l'horloge. La première relève part tout de suite, sauf si un import
   * a déjà abouti il y a moins d'un intervalle : dans ce cas on attend le reste
   * de l'intervalle, pour qu'un redémarrage ne se paie pas en quota.
   */
  async start(): Promise<void> {
    if (!this.enabled || !this.stopped) return;
    this.stopped = false;

    let delay = 0;
    try {
      const last = await this.lastSuccessAt();
      if (last != null) {
        const elapsed = this.now() - last;
        if (elapsed >= 0 && elapsed < this.intervalMs) delay = this.intervalMs - elapsed;
      }
    } catch {
      // Base illisible : on relève quand même, c'est le comportement le plus sûr.
    }

    this.schedule(delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  status(): PollerStatus {
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      running: this.running,
      nextRunAt: iso(this.nextRunAt),
      lastRunAt: iso(this.lastRunAt),
      lastOutcome: this.lastOutcome,
      lastMessage: this.lastMessage,
      lastIngested: this.lastIngested,
      runs: this.runs,
      ingested: this.ingested,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Effectue une relève. Renvoie `null` si une autre est déjà en cours : un
   * import qui dure plus qu'un intervalle ne doit pas se dédoubler.
   */
  async runOnce(): Promise<PollOutcome | null> {
    if (this.running) return null;
    this.running = true;
    const startedAt = this.now();

    try {
      // `withInsights: false` : la relève ne doit dépendre d'aucune clé
      // Anthropic. Les chiffres entrent en base sans elle ; seule la rédaction
      // de l'analyse, déclenchée ailleurs, en a besoin.
      const progress = await this.run(this.athleteId, { withInsights: false });
      const outcome: PollOutcome = progress.interrupted
        ? 'error'
        : progress.rateLimited
          ? 'rate-limited'
          : 'ok';
      this.record(startedAt, outcome, progress.interrupted ?? progress.message, progress.ingested);
      return outcome;
    } catch (e) {
      // Réseau, jeton, base : tout est rattrapé ici, jamais propagé à l'horloge.
      this.record(startedAt, 'error', e instanceof Error ? e.message : String(e), 0);
      return 'error';
    } finally {
      this.running = false;
    }
  }

  private record(startedAt: number, outcome: PollOutcome, message: string, ingested: number): void {
    this.runs++;
    this.lastRunAt = startedAt;
    this.lastOutcome = outcome;
    this.lastMessage = message || null;
    this.lastIngested = ingested;
    this.ingested += ingested;
    // Le quota atteint n'est pas une panne : c'est le frein prévu, et la relève
    // suivante reprend là où celle-ci s'est arrêtée.
    this.consecutiveFailures = outcome === 'error' ? this.consecutiveFailures + 1 : 0;

    if (outcome === 'error') {
      this.log('warn', `Relève Strava en échec (${this.consecutiveFailures} d'affilée) : ${message}`);
    } else if (ingested > 0) {
      this.log('info', `Relève Strava : ${message}`);
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.nextRunAt = this.now() + delay;
    this.wait();
  }

  /** Attend l'échéance par pas d'une minute au plus, en relisant l'heure à chaque pas. */
  private wait(): void {
    const due = this.nextRunAt;
    if (this.stopped || due == null) return;
    this.timer = setTimeout(
      () => (this.now() >= due ? void this.tick() : this.wait()),
      Math.min(Math.max(due - this.now(), 0), WAKE_CHECK_MS),
    );
    // La relève ne doit pas, à elle seule, empêcher le processus de s'arrêter.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    this.timer = null;
    this.nextRunAt = null;
    try {
      await this.runOnce();
    } finally {
      // Quelle que soit l'issue, la relève suivante est reprogrammée.
      this.schedule(this.intervalMs);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Relève du processus courant — celle que `/health` donne à lire.
// ─────────────────────────────────────────────────────────────────────────────

let active: ActivityPoller | null = null;

export async function startActivityPoller(opts: PollerOptions): Promise<ActivityPoller> {
  active?.stop();
  active = new ActivityPoller(opts);
  await active.start();
  return active;
}

export function stopActivityPoller(): void {
  active?.stop();
  active = null;
}

/** État de la relève, ou `null` si aucune ne tourne dans ce processus. */
export function activityPollerStatus(): PollerStatus | null {
  return active?.status() ?? null;
}
