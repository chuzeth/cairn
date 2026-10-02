import { randomBytes } from 'node:crypto';
import { createServer, request, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON, type WebAuthnCredential,
} from '@simplewebauthn/server';
import { loginPage } from './page.js';
import { SESSION_TTL_MS, type GateStore } from './store.js';

/**
 * La porte : le seul chemin d'internet jusqu'à Cairn.
 *
 * Tailscale Funnel fait arriver chaque requête d'internet depuis 127.0.0.1,
 * avec l'en-tête Host et les X-Forwarded-* que le client a bien voulu écrire :
 * rien de ce qui vient de la requête ne dit d'où elle vient. La porte n'en lit
 * donc rien. Elle écoute sur son propre port, que seul Funnel atteint, et y
 * exige toujours la même chose — un cookie de session valide — avant de relayer
 * vers le site. Le site, lui, reste sur 3000 sans connexion, pour le Mac seul.
 *
 * Sans session, seules les routes de `/connexion` répondent ; tout le reste
 * rend 401 — la page de connexion pour une navigation, du JSON sinon — et rien
 * n'est relayé. Jamais de redirection : une réponse 3xx suivie par le service
 * worker arriverait en 200 et pourrait se ranger à la place de l'app.
 */

export const SESSION_COOKIE = '__Host-cairn';
const CEREMONY_COOKIE = '__Host-cairn-ceremonie';
const CEREMONY_TTL_MS = 5 * 60_000;
/** Ce que la page et le service worker reconnaissent comme « il faut se connecter ». */
export const LOGIN_HEADER = 'x-cairn-connexion';

export interface GateOptions {
  store: GateStore;
  /** Le site, sur la boucle locale. */
  upstream: { host: string; port: number };
  /**
   * L'origine publique — `https://macbook-pro-de-chuzeville.tailb4b529.ts.net`.
   * Configurée, jamais lue dans la requête : c'est elle que WebAuthn exige de
   * retrouver dans la signature. `null` : inconnue au démarrage, aucune
   * connexion possible. Relue à chaque cérémonie : Tailscale peut ne donner
   * l'adresse qu'après le démarrage.
   */
  origin: () => string | null;
  /** SimpleWebAuthn côté navigateur, servi sous `/connexion/webauthn.js`. */
  browserScript: string;
  now?: () => number;
  /** Tentatives de connexion admises dans la fenêtre, toutes origines confondues. */
  limit?: { max: number; windowMs: number };
  log?: (line: string) => void;
}

interface Ceremony {
  kind: 'login' | 'register';
  challenge: string;
  code?: string;
  expiresAt: number;
}

/**
 * Les tentatives se comptent globalement : l'adresse d'origine est toujours
 * 127.0.0.1, et un X-Forwarded-For se forge. Le prix — quelqu'un qui martèle
 * la porte peut la fermer à Pierre le temps d'une fenêtre — est celui d'une
 * porte qui ne se force pas.
 */
class Limiter {
  private hits: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** Faux quand la fenêtre est pleine ; sinon compte la tentative. */
  take(now: number): { ok: boolean; retryAfterS: number } {
    this.hits = this.hits.filter((t) => t > now - this.windowMs);
    if (this.hits.length >= this.max) {
      return { ok: false, retryAfterS: Math.ceil((this.hits[0]! + this.windowMs - now) / 1000) };
    }
    this.hits.push(now);
    return { ok: true, retryAfterS: 0 };
  }
}

const PUBLIC_ROUTES = new Set([
  'GET /connexion', 'GET /connexion/webauthn.js', 'GET /connexion/etat',
  'POST /connexion/options', 'POST /connexion/verifier',
  'POST /connexion/enregistrement/options', 'POST /connexion/enregistrement/verifier',
]);

/** En-têtes d'un seul saut : ils décrivent la connexion, pas le message. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade'];

export function createGate(opts: GateOptions): Server {
  const now = opts.now ?? Date.now;
  const limiter = new Limiter(opts.limit?.max ?? 30, opts.limit?.windowMs ?? 10 * 60_000);
  const ceremonies = new Map<string, Ceremony>();
  const log = opts.log ?? (() => {});

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`erreur : ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: 'Erreur de la porte.' });
      else res.destroy();
    });
  });
  // Aucune mise à niveau (WebSocket) n'est relayée : le site de production
  // n'en a pas besoin, et c'est un chemin de moins à garder.
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://porte');
    const route = `${req.method} ${url.pathname}`;
    const session = cookies(req)[SESSION_COOKIE];
    // Lue avant d'être repoussée : `/connexion/etat` dit depuis quand elle a servi.
    const info = opts.store.sessionInfo(session, now());
    const signedIn = opts.store.validSession(session, now());

    if (PUBLIC_ROUTES.has(route)) return connexion(route, url, req, res, signedIn, info);
    if (signedIn) return relay(req, res);
    return refuse(req, res, url);
  }

  // ── Sans session ───────────────────────────────────────────────────────────

  function refuse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const navigation = req.headers['sec-fetch-mode'] === 'navigate'
      || (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html'));
    if (navigation) return page(res, 401, url.pathname + url.search);
    json(res, 401, { error: 'Connexion requise.' });
  }

  function page(res: ServerResponse, status: number, suite: string): void {
    const nonce = randomBytes(16).toString('base64');
    send(res, status, 'text/html; charset=utf-8', loginPage(safeSuite(suite), nonce), {
      'Content-Security-Policy': [
        "default-src 'none'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'unsafe-inline'",
        "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
      ].join('; '),
    });
  }

  // ── Routes de connexion ────────────────────────────────────────────────────

  async function connexion(
    route: string, url: URL, req: IncomingMessage, res: ServerResponse, signedIn: boolean,
    info: { verifiedAt: number; seenAt: number } | null,
  ): Promise<void> {
    switch (route) {
      case 'GET /connexion': {
        const suite = safeSuite(url.searchParams.get('suite') ?? '/');
        // 303 seulement avec une session : sans elle, rien ne redirige.
        if (signedIn) return send(res, 303, 'text/plain; charset=utf-8', '', { Location: suite });
        return page(res, 401, suite);
      }
      case 'GET /connexion/webauthn.js':
        return send(res, 200, 'text/javascript; charset=utf-8', opts.browserScript);
      // L'app la demande à chaque ouverture et toutes les trente secondes : c'est
      // ce qui garde la session ouverte tant qu'elle sert, et ce qui lui dit si
      // Face ID vient d'avoir lieu — sur la page de connexion, par exemple.
      case 'GET /connexion/etat': {
        if (!signedIn || !info) return json(res, 200, { session: false });
        const ago = (t: number) => Math.max(0, Math.round((now() - t) / 1000));
        return json(res, 200, { session: true, verifiedAgoS: ago(info.verifiedAt), seenAgoS: ago(info.seenAt) });
      }
    }

    // Toute écriture sur /connexion est une tentative.
    const slot = limiter.take(now());
    if (!slot.ok) {
      log('tentatives de connexion : fenêtre pleine');
      return json(res, 429, { error: 'Trop de tentatives. Réessaie dans quelques minutes.' }, { 'Retry-After': String(slot.retryAfterS) });
    }
    const origin = opts.origin();
    if (!origin) return json(res, 503, { error: 'Adresse publique inconnue : la connexion est indisponible.' });
    const rpID = new URL(origin).hostname;
    const body = await readJson(req);
    if (body === undefined) return json(res, 400, { error: 'Requête illisible.' });

    switch (route) {
      case 'POST /connexion/options': {
        const passkeys = opts.store.passkeys();
        if (passkeys.length === 0) return json(res, 409, { error: 'Aucune clé d\'accès enregistrée : commence par « Nouvel appareil ».' });
        const options = await generateAuthenticationOptions({
          rpID,
          userVerification: 'required',
          allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
        });
        return json(res, 200, options, { 'Set-Cookie': begin({ kind: 'login', challenge: options.challenge }) });
      }

      case 'POST /connexion/verifier': {
        const ceremony = end(req, 'login');
        if (!ceremony) return json(res, 400, { error: 'Cérémonie expirée : recommence.' });
        const response = body as AuthenticationResponseJSON;
        const passkey = typeof response?.id === 'string' ? opts.store.passkey(response.id) : null;
        if (!passkey) return json(res, 401, { error: 'Clé d\'accès inconnue.' });
        const result = await verifyAuthenticationResponse({
          response,
          expectedChallenge: ceremony.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: { ...passkey, transports: passkey.transports as WebAuthnCredential['transports'] },
          requireUserVerification: true,
        }).catch((e: unknown) => { log(`connexion refusée : ${e instanceof Error ? e.message : String(e)}`); return null; });
        if (!result?.verified) return json(res, 401, { error: 'Signature refusée.' });
        opts.store.setCounter(passkey.id, result.authenticationInfo.newCounter);
        log('connexion : session ouverte');
        return json(res, 200, { ok: true }, { 'Set-Cookie': [openSession(passkey.id), clearCeremony()] });
      }

      case 'POST /connexion/enregistrement/options': {
        const code = typeof (body as { code?: unknown })?.code === 'string' ? (body as { code: string }).code : '';
        const check = opts.store.checkCode(code, now());
        if (check !== 'ok') {
          log(`enregistrement refusé : ${check === 'none' ? 'aucun code valable' : 'code faux'}`);
          return json(res, 403, {
            error: check === 'none'
              ? 'Aucun code valable. Sur le Mac : npm run service -- passkey.'
              : 'Code faux.',
          });
        }
        const options = await generateRegistrationOptions({
          rpName: 'Cairn',
          rpID,
          userName: 'pierre',
          userID: new TextEncoder().encode('cairn:pierre'),
          attestationType: 'none',
          excludeCredentials: opts.store.passkeys().map((p) => ({ id: p.id, transports: p.transports })),
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        });
        return json(res, 200, options, { 'Set-Cookie': begin({ kind: 'register', challenge: options.challenge, code }) });
      }

      case 'POST /connexion/enregistrement/verifier': {
        const ceremony = end(req, 'register');
        if (!ceremony?.code) return json(res, 400, { error: 'Cérémonie expirée : recommence.' });
        const result = await verifyRegistrationResponse({
          response: body as RegistrationResponseJSON,
          expectedChallenge: ceremony.challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        }).catch((e: unknown) => { log(`enregistrement refusé : ${e instanceof Error ? e.message : String(e)}`); return null; });
        if (!result?.verified) return json(res, 401, { error: 'Enregistrement refusé.' });
        // Le code se consomme ici, et seulement ici : s'il a expiré ou été
        // brûlé pendant la cérémonie, la clé n'entre pas.
        if (!opts.store.consumeCode(ceremony.code, now())) return json(res, 403, { error: 'Code expiré : redemande-le au Mac.' });
        const { credential } = result.registrationInfo;
        opts.store.addPasskey({
          id: credential.id, publicKey: new Uint8Array(credential.publicKey), counter: credential.counter,
          transports: credential.transports ?? [],
        }, now());
        log('enregistrement : nouvelle clé d\'accès, session ouverte');
        return json(res, 200, { ok: true }, { 'Set-Cookie': [openSession(credential.id), clearCeremony()] });
      }
    }
  }

  function begin(ceremony: Omit<Ceremony, 'expiresAt'>): string {
    const t = now();
    for (const [id, c] of ceremonies) if (c.expiresAt <= t) ceremonies.delete(id);
    // Borné : chaque cérémonie a déjà coûté une tentative, mais la mémoire ne se promet pas.
    while (ceremonies.size >= 50) ceremonies.delete(ceremonies.keys().next().value!);
    const id = randomBytes(24).toString('base64url');
    ceremonies.set(id, { ...ceremony, expiresAt: t + CEREMONY_TTL_MS });
    return `${CEREMONY_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CEREMONY_TTL_MS / 1000}`;
  }

  /** Une cérémonie ne sert qu'une fois, réussie ou non. */
  function end(req: IncomingMessage, kind: Ceremony['kind']): Ceremony | null {
    const id = cookies(req)[CEREMONY_COOKIE];
    const ceremony = id ? ceremonies.get(id) : undefined;
    if (id) ceremonies.delete(id);
    if (!ceremony || ceremony.kind !== kind || ceremony.expiresAt <= now()) return null;
    return ceremony;
  }

  function openSession(passkeyId: string): string {
    const { token } = opts.store.openSession(passkeyId, now());
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  // ── Avec session ───────────────────────────────────────────────────────────

  /**
   * Relaie tel quel vers le site, moins le cookie de session : le site n'en a
   * pas l'usage, et un jeton n'a pas à traîner dans un journal qui n'est pas le sien.
   */
  function relay(req: IncomingMessage, res: ServerResponse): void {
    const headers: OutgoingHttpHeaders = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const cookie = withoutCookies(req.headers.cookie, [SESSION_COOKIE, CEREMONY_COOKIE]);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;

    const upstream = request(
      { host: opts.upstream.host, port: opts.upstream.port, method: req.method, path: req.url, headers },
      (up) => {
        const out: OutgoingHttpHeaders = { ...up.headers };
        for (const h of HOP_BY_HOP) delete out[h];
        res.writeHead(up.statusCode ?? 502, out);
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      log(`site injoignable : ${e.message}`);
      if (!res.headersSent) json(res, 502, { error: 'Le site ne répond pas.' });
      else res.destroy();
    });
    req.pipe(upstream);
  }
}

// ── Outils ───────────────────────────────────────────────────────────────────

function clearCeremony(): string {
  return `${CEREMONY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/**
 * Où repartir après la connexion : un chemin de ce site, rien d'autre. `//x`
 * ou `/\x` désigneraient un autre hôte pour le navigateur.
 */
export function safeSuite(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\\\s]/.test(raw)) return '/';
  if (raw === '/connexion' || raw.startsWith('/connexion/') || raw.startsWith('/connexion?')) return '/';
  return raw;
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    // Le premier l'emporte, comme dans les navigateurs.
    if (name && !(name in out)) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function withoutCookies(header: string | undefined, names: string[]): string {
  return (header ?? '').split(';').map((p) => p.trim()).filter((p) => p && !names.includes(p.slice(0, p.indexOf('=')).trim())).join('; ');
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) return undefined;
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Toute réponse de la porte elle-même : jamais en cache, et marquée — la page
 * et le service worker y reconnaissent une réponse de connexion, pas l'app.
 */
function send(res: ServerResponse, status: number, type: string, body: string, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    [LOGIN_HEADER]: status === 401 ? 'requise' : 'porte',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), headers);
}
