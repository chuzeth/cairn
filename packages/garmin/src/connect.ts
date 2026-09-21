import type { CalendarWorkout } from './reconcile.js';
import type { SessionFile, GarminTokens } from './session.js';
import type { GarminWorkoutPayload } from './workout.js';

/**
 * Garmin Connect, par l'API qu'utilise son application.
 *
 * Non officielle, et c'est le seul chemin où Cairn peut relire ce qui est
 * arrivé chez Garmin. L'authentification — le parcours de connexion, sa double
 * authentification, ses défenses contre les robots — est déléguée à
 * python-garminconnect (`npm run garmin -- login`) ; ce client ne fait que ce
 * qui vient après : porter le jeton, le renouveler quand il expire, et dire
 * pourquoi un appel n'a pas abouti.
 *
 * Deux échecs, et ils ne se confondent pas. `GarminReauthRequired` : la session
 * ne se renouvelle plus, seul Pierre peut la rétablir — « reconnexion Garmin
 * nécessaire ». `GarminUnreachable` : réseau, quota, panne chez Garmin — ça
 * passera, et on réessaiera.
 */

const API = 'https://connectapi.garmin.com';
const DI_TOKEN_URL = 'https://diauth.garmin.com/di-oauth2-service/oauth/token';

/** Les en-têtes de l'application Android, ceux que python-garminconnect envoie avec ces jetons. */
const NATIVE_HEADERS: Record<string, string> = {
  'User-Agent': 'GCM-Android-5.23',
  'X-Garmin-User-Agent':
    'com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0',
  'X-Garmin-Paired-App-Version': '10861',
  'X-Garmin-Client-Platform': 'Android',
  'X-App-Ver': '10861',
  'X-Lang': 'en',
  'X-GCExperience': 'GC5',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Marge avant expiration à laquelle on renouvelle plutôt que d'essuyer un 401. */
const REFRESH_MARGIN_S = 15 * 60;

export class GarminReauthRequired extends Error {
  constructor(message = 'Reconnexion Garmin nécessaire : lance `npm run garmin -- login` dans le Terminal.') {
    super(message);
    this.name = 'GarminReauthRequired';
  }
}

export class GarminUnreachable extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GarminUnreachable';
  }
}

/** Garmin a compris la demande et l'a refusée — une séance qu'il n'accepte pas, par exemple. */
export class GarminRejected extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'GarminRejected';
  }
}

/** La montre, et l'heure de sa dernière synchronisation avec Garmin Connect. */
export interface WatchSync {
  name: string;
  syncedAt: string;
}

/** Ce que le réconciliateur demande à Garmin — un faux s'y substitue dans les tests. */
export interface GarminApi {
  calendar(year: number, month: number): Promise<CalendarWorkout[]>;
  createWorkout(payload: GarminWorkoutPayload): Promise<number>;
  getWorkout(workoutId: number): Promise<unknown | null>;
  deleteWorkout(workoutId: number): Promise<void>;
  schedule(workoutId: number, date: string): Promise<number | null>;
  unschedule(scheduleId: number): Promise<void>;
  watch(): Promise<WatchSync | null>;
}

type Fetch = typeof fetch;

interface Reply {
  status: number;
  body: unknown;
}

export class GarminConnect implements GarminApi {
  /** Appels partis vers Garmin depuis la création du client, renouvellements compris. */
  calls = 0;
  private tokens: GarminTokens | null = null;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly session: SessionFile,
    opts: { fetch?: Fetch; now?: () => number; timeoutMs?: number } = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // ── Séances et calendrier ────────────────────────────────────────────────

  /**
   * Les séances planifiées d'un mois (0 à 11).
   *
   * Garmin répète chaque élément dans la réponse d'un même mois : lu tel quel,
   * le doublon d'une séance à garder passerait pour une planification en trop,
   * et la séance serait retirée. Un élément ne compte qu'une fois par numéro de
   * planification — `id`, celui qu'accepte `DELETE /workout-service/schedule`.
   */
  async calendar(year: number, month: number): Promise<CalendarWorkout[]> {
    const body = (await this.ok('GET', `/calendar-service/year/${year}/month/${month}`)) as {
      calendarItems?: Record<string, unknown>[];
    } | null;
    return uniqueSchedules(
      (body?.calendarItems ?? [])
        .filter((i) => i.itemType === 'workout' && typeof i.date === 'string')
        .map((i) => ({
          scheduleId: Number(i.id ?? i.workoutScheduleId),
          workoutId: typeof i.workoutId === 'number' ? i.workoutId : null,
          date: String(i.date).slice(0, 10),
          title: typeof i.title === 'string' ? i.title : '',
        }))
        .filter((i) => Number.isFinite(i.scheduleId)),
    );
  }

  /** Tout ce que porte un mois du calendrier, activités comprises — de quoi prouver qu'on n'y a rien changé. */
  async calendarSnapshot(year: number, month: number): Promise<string[]> {
    const body = (await this.ok('GET', `/calendar-service/year/${year}/month/${month}`)) as {
      calendarItems?: Record<string, unknown>[];
    } | null;
    return (body?.calendarItems ?? [])
      .map((i) => `${String(i.date).slice(0, 10)} ${String(i.itemType)} ${String(i.id)} ${typeof i.title === 'string' ? i.title : ''}`)
      .sort();
  }

  async createWorkout(payload: GarminWorkoutPayload): Promise<number> {
    const body = (await this.ok('POST', '/workout-service/workout', payload)) as { workoutId?: unknown } | null;
    const id = Number(body?.workoutId);
    if (!Number.isFinite(id) || id <= 0) throw new GarminUnreachable('Garmin a accepté la séance sans rendre son numéro.');
    return id;
  }

  async getWorkout(workoutId: number): Promise<unknown | null> {
    const r = await this.request('GET', `/workout-service/workout/${workoutId}`);
    if (r.status === 404) return null;
    return this.checked('GET', '/workout-service/workout', r);
  }

  async deleteWorkout(workoutId: number): Promise<void> {
    const r = await this.request('DELETE', `/workout-service/workout/${workoutId}`);
    if (r.status !== 404) this.checked('DELETE', '/workout-service/workout', r);
  }

  async schedule(workoutId: number, date: string): Promise<number | null> {
    const body = (await this.ok('POST', `/workout-service/schedule/${workoutId}`, { date })) as Record<string, unknown> | null;
    const id = Number(body?.workoutScheduleId ?? body?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  async unschedule(scheduleId: number): Promise<void> {
    const r = await this.request('DELETE', `/workout-service/schedule/${scheduleId}`);
    if (r.status !== 404) this.checked('DELETE', '/workout-service/schedule', r);
  }

  /** Toute la bibliothèque, page après page : au-delà de cent séances, une page seule en cacherait. */
  async allWorkouts(): Promise<{ workoutId: number; workoutName: string }[]> {
    const out: { workoutId: number; workoutName: string }[] = [];
    for (let start = 0; ; start += 100) {
      const page = await this.listWorkouts(start, 100);
      out.push(...page);
      if (page.length < 100) return out;
    }
  }

  /** Les séances de la bibliothèque, les plus récentes d'abord. */
  async listWorkouts(start = 0, limit = 50): Promise<{ workoutId: number; workoutName: string }[]> {
    const body = (await this.ok('GET', `/workout-service/workouts?start=${start}&limit=${limit}`)) as Record<string, unknown>[] | null;
    return (Array.isArray(body) ? body : []).map((w) => ({
      workoutId: Number(w.workoutId),
      workoutName: typeof w.workoutName === 'string' ? w.workoutName : '',
    }));
  }

  /**
   * La dernière synchronisation de la montre, telle que Garmin la date.
   *
   * `mylastused` rend l'appareil qui a envoyé des données en dernier, et
   * l'heure de cet envoi : vérifié le 21/09/2026, les données de bien-être de
   * la Venu 2 s'arrêtent à la même seconde. C'est la synchronisation au cours
   * de laquelle la montre relit aussi son calendrier. L'heure ne vaut que si cet
   * appareil est la montre principale du compte — une balance qui vient de
   * synchroniser ne dit rien de la montre —, et sinon rien n'est affirmé.
   */
  async watch(): Promise<WatchSync | null> {
    const devices = (await this.ok('GET', '/device-service/deviceregistration/devices')) as Record<string, unknown>[] | null;
    const primary = (Array.isArray(devices) ? devices : []).find((d) => d.primary === true);
    const last = (await this.ok('GET', '/device-service/deviceservice/mylastused')) as Record<string, unknown> | null;
    const name = typeof last?.lastUsedDeviceName === 'string' ? last.lastUsedDeviceName : null;
    const at = Number(last?.lastUsedDeviceUploadTime);
    if (!primary || !name || !Number.isFinite(at) || at <= 0) return null;
    if (name !== primary.productDisplayName && name !== primary.displayName) return null;
    return { name, syncedAt: new Date(at).toISOString() };
  }

  /** Nom affiché du compte — de quoi prouver que la session répond. */
  async profileName(): Promise<string | null> {
    const body = (await this.ok('GET', '/userprofile-service/socialProfile')) as Record<string, unknown> | null;
    const name = body?.fullName ?? body?.displayName;
    return typeof name === 'string' ? name : null;
  }

  // ── Jetons ───────────────────────────────────────────────────────────────

  /**
   * Renouvelle le jeton d'accès.
   *
   * Un autre processus — le service pendant qu'on lance une commande — a pu le
   * faire juste avant : le fichier est relu d'abord, et un jeton plus neuf que
   * le nôtre y est repris tel quel. Garmin peut faire tourner le jeton de
   * renouvellement ; deux renouvellements concurrents sur le même en
   * invalideraient un, et on lirait « reconnexion nécessaire » pour une
   * session en parfait état.
   */
  async refresh(opts: { force?: boolean } = {}): Promise<void> {
    const onDisk = this.session.read();
    if (!opts.force && onDisk && onDisk.di_token !== this.tokens?.di_token && !this.expiresSoon(onDisk.di_token)) {
      this.tokens = onDisk;
      return;
    }
    const current = onDisk ?? this.tokens;
    if (!current?.di_refresh_token || !current.di_client_id) throw new GarminReauthRequired();

    let res: Response;
    try {
      this.calls++;
      res = await this.fetch(DI_TOKEN_URL, {
        method: 'POST',
        headers: {
          ...NATIVE_HEADERS,
          Authorization: `Basic ${Buffer.from(`${current.di_client_id}:`).toString('base64')}`,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cache-Control': 'no-cache',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: current.di_client_id,
          refresh_token: current.di_refresh_token,
        }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new GarminUnreachable(`renouvellement de la session impossible : ${networkReason(e)}`);
    }
    if (res.status === 400 || res.status === 401) {
      const again = this.session.read();
      if (again && again.di_refresh_token !== current.di_refresh_token) {
        this.tokens = again;
        return;
      }
      throw new GarminReauthRequired();
    }
    if (!res.ok) throw new GarminUnreachable(`renouvellement de la session : Garmin répond ${res.status}`, res.status);
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (typeof data?.access_token !== 'string') throw new GarminUnreachable('renouvellement de la session sans jeton');
    this.tokens = {
      di_token: data.access_token,
      di_refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : current.di_refresh_token,
      di_client_id: claim(data.access_token, 'client_id') ?? current.di_client_id,
    };
    this.session.write(this.tokens);
  }

  /** Expiration du jeton d'accès (epoch s), lue dans le jeton lui-même. */
  expiresAt(): number | null {
    const t = this.tokens ?? this.session.read();
    return t ? expiryOf(t.di_token) : null;
  }

  /** Un jeton sans échéance lisible n'est pas réputé expirer : c'est le 401 qui le dira. */
  private expiresSoon(token: string): boolean {
    const exp = expiryOf(token);
    return exp != null && this.now() / 1000 > exp - REFRESH_MARGIN_S;
  }

  private async token(): Promise<string> {
    this.tokens ??= this.session.read();
    if (!this.tokens) throw new GarminReauthRequired();
    if (this.expiresSoon(this.tokens.di_token)) await this.refresh();
    return this.tokens.di_token;
  }

  // ── Transport ────────────────────────────────────────────────────────────

  private async ok(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.checked(method, path.split('?')[0]!, await this.request(method, path, body));
  }

  private async request(method: string, path: string, body?: unknown): Promise<Reply> {
    let r = await this.send(method, path, await this.token(), body);
    if (r.status === 401) {
      await this.refresh();
      r = await this.send(method, path, this.tokens!.di_token, body);
      if (r.status === 401) throw new GarminReauthRequired();
    }
    return r;
  }

  private checked(method: string, path: string, r: Reply): unknown {
    if (r.status >= 200 && r.status < 300) return r.body;
    if (r.status === 429) throw new GarminUnreachable('Garmin limite les appels pour le moment (429).', 429);
    if (r.status >= 500) throw new GarminUnreachable(`Garmin répond ${r.status} à ${method} ${path}.`, r.status);
    if (r.status === 403) throw new GarminUnreachable(`Garmin refuse l'accès (403) à ${method} ${path}.`, 403);
    throw new GarminRejected(`Garmin refuse ${method} ${path} (${r.status})${reasonOf(r.body)}`, r.status);
  }

  private async send(method: string, path: string, token: string, body?: unknown): Promise<Reply> {
    let res: Response;
    try {
      this.calls++;
      res = await this.fetch(`${API}${path}`, {
        method,
        headers: {
          ...NATIVE_HEADERS,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Le message dit la cause ; « Garmin injoignable » est ce que l'écran met devant.
      throw new GarminUnreachable(networkReason(e));
    }
    const raw = await res.text().catch(() => '');
    let parsed: unknown = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
    }
    return { status: res.status, body: parsed };
  }
}

function expiryOf(token: string): number | null {
  const raw = claim(token, 'exp');
  const exp = raw == null ? NaN : Number(raw);
  return Number.isFinite(exp) && exp > 0 ? exp : null;
}

/** Une planification par numéro, dans l'ordre où elle apparaît. */
export function uniqueSchedules(items: readonly CalendarWorkout[]): CalendarWorkout[] {
  const seen = new Set<number>();
  return items.filter((i) => !seen.has(i.scheduleId) && Boolean(seen.add(i.scheduleId)));
}

/** Une revendication du jeton, lue sans vérifier la signature — Garmin la vérifie, pas nous. */
function claim(token: string, key: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
    const v = data[key];
    return v == null ? null : String(v);
  } catch {
    return null;
  }
}

function networkReason(e: unknown): string {
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'pas de réponse à temps';
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : null;
  return cause ?? (e instanceof Error ? e.message : String(e));
}

/** Le motif d'un refus, quand Garmin en donne un — court, et jamais l'en-tête de la requête. */
function reasonOf(body: unknown): string {
  if (!body) return '.';
  const msg =
    typeof body === 'string'
      ? body
      : typeof body === 'object'
        ? String((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error ?? JSON.stringify(body))
        : String(body);
  return ` : ${msg.replace(/\s+/g, ' ').slice(0, 200)}`;
}
