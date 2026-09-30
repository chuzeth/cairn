import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { createGate, safeSuite, SESSION_COOKIE } from '../apps/gate/src/gate';
import { GateStore, SESSION_TTL_MS, CODE_TTL_MS } from '../apps/gate/src/store';

const ORIGIN = 'https://macbook-pro-de-chuzeville.tailb4b529.ts.net';
const RP_ID = new URL(ORIGIN).hostname;

// ── Un authentificateur logiciel : ce que fait Face ID, en clair ────────────

const b64u = (b: Uint8Array | Buffer): string => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

class SoftAuthenticator {
  readonly credId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    this.publicJwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  }

  register(options: { challenge: string }, over: { origin?: string; rpId?: string } = {}) {
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this.publicJwk.x, 'base64url')], [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]));
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(this.credId.length);
    // UP | UV | AT
    const authData = Buffer.concat([sha(over.rpId ?? RP_ID), Buffer.from([0x45]), u32(0), Buffer.alloc(16), idLen, this.credId, cose]);
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: over.origin ?? ORIGIN, crossOrigin: false });
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]]) as never);
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(Buffer.from(clientData)), attestationObject: b64u(attestationObject), transports: ['internal'] },
    };
  }

  assert(options: { challenge: string }, over: { origin?: string; flags?: number } = {}) {
    const authData = Buffer.concat([sha(RP_ID), Buffer.from([over.flags ?? 0x05]), u32(0)]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: over.origin ?? ORIGIN, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), this.key);
    return {
      id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: b64u(Buffer.from('cairn:pierre')) },
    };
  }
}

// ── Banc : un faux site derrière la porte, une horloge qu'on avance ─────────

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

let clock: number;
let store: GateStore;
let gate: Server;
let site: Server;
let gatePort: number;
let seen: { method: string; url: string; headers: IncomingHttpHeaders }[];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request({
      host: '127.0.0.1', port: gatePort, method, path,
      headers: { ...(body && { 'content-type': 'application/json' }), ...opts.headers },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Le cookie posé par une réponse, prêt à être renvoyé. */
function cookieFrom(res: Reply, name: string): string {
  const line = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  if (!line) throw new Error(`pas de cookie ${name}`);
  return line.split(';')[0]!;
}

const CEREMONY = '__Host-cairn-ceremonie';

async function register(auth: SoftAuthenticator, code: string, over: { origin?: string; rpId?: string } = {}) {
  const options = await call('POST', '/connexion/enregistrement/options', { body: { code } });
  if (options.status !== 200) return options;
  return call('POST', '/connexion/enregistrement/verifier', {
    headers: { cookie: cookieFrom(options, CEREMONY) },
    body: auth.register(JSON.parse(options.body) as { challenge: string }, over),
  });
}

async function login(auth: SoftAuthenticator, over: { origin?: string; flags?: number } = {}) {
  const options = await call('POST', '/connexion/options', { body: {} });
  return call('POST', '/connexion/verifier', {
    headers: { cookie: cookieFrom(options, CEREMONY) },
    body: auth.assert(JSON.parse(options.body) as { challenge: string }, over),
  });
}

/** Une clé enregistrée avec un code du Mac : la session qu'elle ouvre. */
async function enrolled(): Promise<{ auth: SoftAuthenticator; session: string }> {
  const auth = new SoftAuthenticator();
  const res = await register(auth, store.issueCode(clock).code);
  expect(res.status).toBe(200);
  return { auth, session: cookieFrom(res, SESSION_COOKIE) };
}

beforeEach(async () => {
  clock = Date.parse('2026-09-30T08:00:00Z');
  seen = [];
  site = createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers });
    req.resume();
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`site:${req.url}`);
  });
  const sitePort = await listen(site);
  store = new GateStore(join(mkdtempSync(join(tmpdir(), 'cairn-gate-')), 'auth.sqlite'));
  gate = createGate({
    store, origin: () => ORIGIN, browserScript: '/* webauthn */',
    upstream: { host: '127.0.0.1', port: sitePort },
    now: () => clock,
  });
  gatePort = await listen(gate);
});

afterEach(async () => {
  await new Promise((r) => gate.close(r));
  await new Promise((r) => site.close(r));
  store.close();
});

// ── Invariant 1 : sans session, rien d'autre que la connexion ───────────────

const APP = ['/', '/point', '/coach', '/plan', '/api/state', '/api/plan', '/health', '/sw.js',
  '/_next/static/chunks/main.js', '/manifest.webmanifest', '/icon', '/apple-icon', '/auth/strava', '/api/chat/history'];

describe('Sans session', () => {
  it('refuse toute page, toute API, tout fichier de l\'app, sans rien relayer', async () => {
    for (const path of APP) {
      const res = await call('GET', path);
      expect(res.status, path).toBe(401);
      expect(res.headers['cache-control'], path).toBe('no-store');
    }
    for (const path of ['/api/checkin', '/api/plan/rebuild', '/api/errors']) {
      expect((await call('POST', path, { body: {} })).status, path).toBe(401);
    }
    expect((await call('DELETE', '/api/races/1')).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('répond à une navigation par la page de connexion, en 401 et sans redirection', async () => {
    const res = await call('GET', '/plan?semaine=2', { headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html' } });
    expect(res.status).toBe(401);
    expect(res.headers.location).toBeUndefined();
    expect(res.headers['x-cairn-connexion']).toBe('requise');
    expect(res.body).toContain('Se connecter avec Face ID');
    expect(res.body).toContain('"/plan?semaine=2"');
    expect(seen).toHaveLength(0);
  });

  it('ne laisse joindre que les routes de connexion', async () => {
    expect((await call('GET', '/connexion/etat')).body).toBe('{"session":false}');
    expect((await call('GET', '/connexion/webauthn.js')).status).toBe(200);
    // Un chemin voisin n'est pas une route de connexion.
    expect((await call('GET', '/connexion/../api/state')).status).toBe(401);
    expect((await call('GET', '/connexion/autre')).status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe('Sans adresse publique connue', () => {
  it('refuse toute connexion, et toujours tout le reste', async () => {
    const blind = createGate({
      store, origin: () => null, browserScript: '', upstream: { host: '127.0.0.1', port: 9 }, now: () => clock,
    });
    const port = await listen(blind);
    const saved = gatePort;
    gatePort = port;
    try {
      store.issueCode(clock);
      expect((await call('POST', '/connexion/options', { body: {} })).status).toBe(503);
      expect((await call('POST', '/connexion/enregistrement/options', { body: { code: 'x' } })).status).toBe(503);
      expect((await call('GET', '/api/state')).status).toBe(401);
    } finally {
      gatePort = saved;
      await new Promise((r) => blind.close(r));
    }
  });
});

// ── Invariant 2 : ni l'adresse ni l'en-tête Host ne donnent confiance ────────

describe('En-têtes forgés', () => {
  const forged: Record<string, string>[] = [
    { host: '127.0.0.1:3000' },
    { host: 'localhost' },
    { 'x-forwarded-for': '127.0.0.1' },
    { 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' },
    { 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1;host=localhost' },
    { 'tailscale-user-login': 'pierre.chuze@gmail.com', 'tailscale-user-name': 'Pierre' },
    { cookie: `${SESSION_COOKIE}=${randomBytes(32).toString('base64url')}` },
    { cookie: `${SESSION_COOKIE}=` },
  ];

  it('refuse, quels qu\'ils soient', async () => {
    for (const headers of forged) {
      expect((await call('GET', '/api/state', { headers })).status, JSON.stringify(headers)).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });

  it('ne tire pas l\'origine WebAuthn de la requête : une signature pour un autre site est refusée', async () => {
    const auth = new SoftAuthenticator();
    const code = store.issueCode(clock).code;
    // L'hôte que la requête annonce ne change rien à l'origine attendue.
    const options = await call('POST', '/connexion/enregistrement/options', { body: { code }, headers: { host: 'evil.example' } });
    const res = await call('POST', '/connexion/enregistrement/verifier', {
      headers: { cookie: cookieFrom(options, CEREMONY), host: 'evil.example' },
      body: auth.register(JSON.parse(options.body) as { challenge: string }, { origin: 'https://evil.example', rpId: 'evil.example' }),
    });
    expect(res.status).toBe(401);
    expect(store.passkeys()).toHaveLength(0);
  });
});

// ── Invariant 3 : pas d'enregistrement sans le code du Mac ──────────────────

describe('Enregistrement d\'une clé d\'accès', () => {
  it('est refusé sans code', async () => {
    expect((await call('POST', '/connexion/enregistrement/options', { body: {} })).status).toBe(403);
    expect((await call('POST', '/connexion/enregistrement/options', { body: { code: 'ABCD-EFGH' } })).status).toBe(403);
    expect(store.passkeys()).toHaveLength(0);
  });

  it('est refusé avec un code faux, et le code est brûlé à la cinquième erreur', async () => {
    const { code } = store.issueCode(clock);
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', '/connexion/enregistrement/options', { body: { code: 'ZZZZZZZZ' } })).status).toBe(403);
    }
    expect((await register(new SoftAuthenticator(), code)).status).toBe(403);
    expect(store.passkeys()).toHaveLength(0);
  });

  it('est refusé au-delà de dix minutes', async () => {
    const { code } = store.issueCode(clock);
    clock += CODE_TTL_MS + 1;
    expect((await register(new SoftAuthenticator(), code)).status).toBe(403);
  });

  it('refuse un code expiré pendant la cérémonie', async () => {
    const auth = new SoftAuthenticator();
    const { code } = store.issueCode(clock);
    const options = await call('POST', '/connexion/enregistrement/options', { body: { code } });
    clock += CODE_TTL_MS + 1;
    const res = await call('POST', '/connexion/enregistrement/verifier', {
      headers: { cookie: cookieFrom(options, CEREMONY) },
      body: auth.register(JSON.parse(options.body) as { challenge: string }),
    });
    expect(res.status).not.toBe(200);
    expect(store.passkeys()).toHaveLength(0);
  });

  it('accepte le code une fois, et une seule', async () => {
    const { code } = store.issueCode(clock);
    const first = await register(new SoftAuthenticator(), code.toLowerCase().replace(/^(.{4})/, '$1-'));
    expect(first.status).toBe(200);
    expect((await register(new SoftAuthenticator(), code)).status).toBe(403);
    expect(store.passkeys()).toHaveLength(1);
  });

  it('exige la vérification de l\'utilisateur — Face ID, pas un simple toucher', async () => {
    const { auth } = await enrolled();
    expect((await login(auth, { flags: 0x01 })).status).toBe(401);
  });
});

// ── Invariant 4 : la session ────────────────────────────────────────────────

describe('Avec une session', () => {
  it('pose un cookie HttpOnly, Secure, SameSite=Strict, de 90 jours', async () => {
    const auth = new SoftAuthenticator();
    const res = await register(auth, store.issueCode(clock).code);
    const line = res.headers['set-cookie']!.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; SameSite=Strict/);
    expect(line).toMatch(/; Path=\//);
    expect(line).not.toMatch(/Domain=/);
    expect(line).toMatch(/; Max-Age=7776000/);
  });

  it('relaie tout vers le site, sans lui transmettre le jeton', async () => {
    const { session } = await enrolled();
    for (const path of APP) {
      const res = await call('GET', path, { headers: { cookie: `autre=1; ${session}` } });
      expect(res.status, path).toBe(200);
      expect(res.body).toBe(`site:${path}`);
    }
    const post = await call('POST', '/api/checkin', { headers: { cookie: session }, body: { rpe: 3 } });
    expect(post.status).toBe(200);
    expect(seen.map((s) => s.headers.cookie)).toEqual([...APP.map(() => 'autre=1'), undefined]);
  });

  it('s\'ouvre à nouveau par Face ID, avec la clé enregistrée', async () => {
    const { auth } = await enrolled();
    const res = await login(auth);
    expect(res.status).toBe(200);
    const session = cookieFrom(res, SESSION_COOKIE);
    expect((await call('GET', '/connexion/etat', { headers: { cookie: session } })).body).toBe('{"session":true}');
    expect((await call('GET', '/api/state', { headers: { cookie: session } })).status).toBe(200);
  });

  it('refuse une assertion signée pour une autre origine', async () => {
    const { auth } = await enrolled();
    expect((await login(auth, { origin: 'https://evil.example' })).status).toBe(401);
  });

  it('ne rejoue pas une cérémonie', async () => {
    const { auth } = await enrolled();
    const options = await call('POST', '/connexion/options', { body: {} });
    const ceremony = cookieFrom(options, CEREMONY);
    const assertion = auth.assert(JSON.parse(options.body) as { challenge: string });
    expect((await call('POST', '/connexion/verifier', { headers: { cookie: ceremony }, body: assertion })).status).toBe(200);
    expect((await call('POST', '/connexion/verifier', { headers: { cookie: ceremony }, body: assertion })).status).toBe(400);
  });

  it('expire au bout de 90 jours', async () => {
    const { session } = await enrolled();
    clock += SESSION_TTL_MS - 60_000;
    expect((await call('GET', '/api/state', { headers: { cookie: session } })).status).toBe(200);
    clock += 60_000;
    expect((await call('GET', '/api/state', { headers: { cookie: session } })).status).toBe(401);
  });

  it('tombe avec logout-all', async () => {
    const { session } = await enrolled();
    expect(store.closeAllSessions()).toBe(1);
    expect((await call('GET', '/api/state', { headers: { cookie: session } })).status).toBe(401);
  });

  it('renvoie de la page de connexion vers la suite, jamais vers un autre site', async () => {
    const { session } = await enrolled();
    const res = await call('GET', '/connexion?suite=%2Fplan', { headers: { cookie: session } });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/plan');
    for (const evil of ['//evil.example', '/\\evil.example', 'https://evil.example', '/connexion']) {
      expect(safeSuite(evil), evil).toBe('/');
    }
  });
});

// ── Invariant 5 : les tentatives sont comptées ──────────────────────────────

describe('Tentatives de connexion', () => {
  it('sont limitées, toutes origines confondues, puis rouvertes', async () => {
    for (let i = 0; i < 30; i++) {
      const res = await call('POST', '/connexion/enregistrement/options', {
        body: { code: 'ZZZZZZZZ' }, headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
      expect(res.status).toBe(403);
    }
    const blocked = await call('POST', '/connexion/options', { body: {}, headers: { 'x-forwarded-for': '198.51.100.7' } });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    clock += 10 * 60_000 + 1;
    expect((await call('POST', '/connexion/enregistrement/options', { body: { code: 'ZZZZZZZZ' } })).status).toBe(403);
  });
});
