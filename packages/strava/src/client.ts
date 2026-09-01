import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOAuthConfig, refreshAccessToken, type StravaOAuthConfig } from './oauth.js';
import type {
  StravaAthlete, StravaGear, StravaStreamSet, StravaSubscription,
  StravaSummaryActivity, StravaTokenResponse,
} from './types.js';

const API = 'https://www.strava.com/api/v3';

/** Flux demandés — on prend tout ce que l'API sait donner, sans exception. */
export const STREAM_KEYS = [
  'time', 'distance', 'altitude', 'velocity_smooth', 'heartrate',
  'cadence', 'watts', 'temp', 'latlng', 'moving', 'grade_smooth',
] as const;

export interface TokenStore {
  get(): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null>;
  set(tokens: { accessToken: string; refreshToken: string; expiresAt: number; scope?: string; stravaAthleteId: number }): Promise<void>;
}

export interface RateLimitState {
  shortTermUsage: number;
  shortTermLimit: number;
  dailyUsage: number;
  dailyLimit: number;
  /** Instant à partir duquel on peut reprendre, si un 429 a été reçu. */
  retryAfter: number | null;
}

export class StravaRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Quota Strava atteint. Reprise possible dans ${Math.ceil(retryAfterMs / 1000)} s.`);
    this.name = 'StravaRateLimitError';
  }
}

/**
 * Client Strava.
 *
 * Trois responsabilités que l'on ne veut surtout pas éparpiller dans le reste
 * du code : le renouvellement transparent du jeton, le respect du quota
 * (100 requêtes / 15 min et 1 000 / jour par défaut), et les reprises sur
 * erreur transitoire.
 */
export class StravaClient {
  private rateLimit: RateLimitState = {
    shortTermUsage: 0, shortTermLimit: 100, dailyUsage: 0, dailyLimit: 1000, retryAfter: null,
  };
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly store: TokenStore,
    private readonly config: StravaOAuthConfig = readOAuthConfig(),
  ) {}

  getRateLimit(): RateLimitState {
    return { ...this.rateLimit };
  }

  /** Marge de sécurité restante avant d'atteindre le quota court terme. */
  remainingShortTerm(): number {
    return Math.max(0, this.rateLimit.shortTermLimit - this.rateLimit.shortTermUsage);
  }

  private async accessToken(): Promise<string> {
    const tokens = await this.store.get();
    if (!tokens) throw new Error('Aucun jeton Strava enregistré. Lance la connexion OAuth depuis /auth/strava.');

    // Marge de 120 s : on renouvelle avant expiration plutôt que de subir un 401.
    if (tokens.expiresAt * 1000 - Date.now() > 120_000) return tokens.accessToken;

    // Un seul renouvellement concurrent, quel que soit le nombre d'appels en vol.
    this.refreshing ??= (async () => {
      try {
        const fresh: StravaTokenResponse = await refreshAccessToken(this.config, tokens.refreshToken);
        await this.store.set({
          accessToken: fresh.access_token,
          refreshToken: fresh.refresh_token,
          expiresAt: fresh.expires_at,
          scope: fresh.scope,
          stravaAthleteId: fresh.athlete?.id ?? 0,
        });
        return fresh.access_token;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private trackHeaders(res: Response): void {
    const limit = res.headers.get('x-ratelimit-limit');
    const usage = res.headers.get('x-ratelimit-usage');
    if (limit) {
      const [short, daily] = limit.split(',').map((v) => Number(v.trim()));
      if (Number.isFinite(short)) this.rateLimit.shortTermLimit = short as number;
      if (Number.isFinite(daily)) this.rateLimit.dailyLimit = daily as number;
    }
    if (usage) {
      const [short, daily] = usage.split(',').map((v) => Number(v.trim()));
      if (Number.isFinite(short)) this.rateLimit.shortTermUsage = short as number;
      if (Number.isFinite(daily)) this.rateLimit.dailyUsage = daily as number;
    }
  }

  private async request<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    if (this.rateLimit.retryAfter && Date.now() < this.rateLimit.retryAfter) {
      throw new StravaRateLimitError(this.rateLimit.retryAfter - Date.now());
    }

    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));

    // Capture et rejeu : entièrement inertes tant qu'aucune des deux variables
    // n'est définie — pas même le calcul de la clé.
    const captureDir = process.env.CAIRN_CAPTURE_DIR;
    const replayDir = process.env.CAIRN_REPLAY_DIR;
    const key = captureDir || replayDir ? captureKey('GET', path, url.searchParams) : '';
    if (replayDir) {
      const file = join(replayDir, key);
      if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T;
      // Fichier absent : on retombe sur le réseau, ce qui permet de compléter
      // un jeu de captures partiel sans le rejouer en entier.
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = await this.accessToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      this.trackHeaders(res);

      if (res.ok) {
        const data = (await res.json()) as T;
        if (captureDir) {
          mkdirSync(captureDir, { recursive: true });
          writeFileSync(join(captureDir, key), JSON.stringify(data, null, 2));
        }
        return data;
      }

      if (res.status === 429) {
        // Le quota court terme se réinitialise au quart d'heure suivant.
        const now = new Date();
        const next = new Date(now);
        next.setMinutes(Math.ceil((now.getMinutes() + 1) / 15) * 15, 5, 0);
        this.rateLimit.retryAfter = next.getTime();
        throw new StravaRateLimitError(next.getTime() - now.getTime());
      }

      if (res.status === 404) {
        throw new Error(`Ressource Strava introuvable : ${path}`);
      }

      if (res.status >= 500 || res.status === 408) {
        lastError = new Error(`Strava a répondu ${res.status} sur ${path}`);
        await sleep(400 * 2 ** attempt);
        continue;
      }

      const text = await res.text().catch(() => '');
      throw new Error(`Erreur Strava ${res.status} sur ${path} : ${text.slice(0, 300)}`);
    }
    throw lastError ?? new Error(`Échec de la requête Strava ${path}`);
  }

  // ── Points d'accès ────────────────────────────────────────────────────────

  getAthlete(): Promise<StravaAthlete> {
    return this.request<StravaAthlete>('/athlete');
  }

  /** Zones cardiaques déclarées par l'athlète, si l'abonnement le permet. */
  async getAthleteZones(): Promise<unknown | null> {
    try {
      return await this.request<unknown>('/athlete/zones');
    } catch {
      return null;
    }
  }

  listActivities(opts: { after?: number; before?: number; page?: number; perPage?: number } = {}): Promise<StravaSummaryActivity[]> {
    return this.request<StravaSummaryActivity[]>('/athlete/activities', {
      ...(opts.after ? { after: opts.after } : {}),
      ...(opts.before ? { before: opts.before } : {}),
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 100,
    });
  }

  /** Activité détaillée : description, tours, splits, meilleurs efforts. */
  getActivity(id: number): Promise<StravaSummaryActivity> {
    return this.request<StravaSummaryActivity>(`/activities/${id}`, { include_all_efforts: true });
  }

  getStreams(id: number): Promise<StravaStreamSet> {
    return this.request<StravaStreamSet>(`/activities/${id}/streams`, {
      keys: STREAM_KEYS.join(','),
      key_by_type: true,
    });
  }

  getGear(id: string): Promise<StravaGear> {
    return this.request<StravaGear>(`/gear/${id}`);
  }

  /**
   * Parcourt tout l'historique postérieur à `afterEpoch`, page par page.
   * Générateur asynchrone : l'appelant peut s'arrêter à tout moment, et rien
   * n'est chargé en mémoire au-delà d'une page.
   */
  async *iterateActivities(afterEpoch = 0, perPage = 100): AsyncGenerator<StravaSummaryActivity> {
    for (let page = 1; page <= 200; page++) {
      const batch = await this.listActivities({ after: afterEpoch, page, perPage });
      if (batch.length === 0) return;
      for (const a of batch) yield a;
      if (batch.length < perPage) return;
    }
  }

  // ── Souscriptions webhook ─────────────────────────────────────────────────

  async listSubscriptions(): Promise<StravaSubscription[]> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const res = await fetch(`${API}/push_subscriptions?${params}`);
    if (!res.ok) throw new Error(`Impossible de lister les souscriptions (${res.status})`);
    return (await res.json()) as StravaSubscription[];
  }

  async createSubscription(callbackUrl: string, verifyToken: string): Promise<StravaSubscription> {
    const res = await fetch(`${API}/push_subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        callback_url: callbackUrl,
        verify_token: verifyToken,
      }).toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Création de la souscription webhook refusée (${res.status}) : ${text.slice(0, 300)}. ` +
          `Vérifie que ${callbackUrl} est joignable publiquement en HTTPS et répond au handshake GET.`,
      );
    }
    return (await res.json()) as StravaSubscription;
  }

  async deleteSubscription(id: number): Promise<void> {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const res = await fetch(`${API}/push_subscriptions/${id}?${params}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Suppression de la souscription ${id} refusée (${res.status})`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Nom de fichier d'une réponse : méthode, chemin, puis paramètres triés — donc
 * stable quel que soit l'ordre dans lequel l'appelant les a passés. Tout
 * caractère hostile à un système de fichiers devient `_`, ce qui garde les
 * captures lisibles et inspectables à la main.
 */
function captureKey(method: string, path: string, params: URLSearchParams): string {
  const sorted = [...params].map(([k, v]) => `${k}=${v}`).sort();
  return `${[method, path, ...sorted].join(' ').replace(/[^A-Za-z0-9=._-]+/g, '_')}.json`;
}
