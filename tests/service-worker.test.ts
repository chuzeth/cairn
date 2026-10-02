import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Le service worker, exécuté tel quel contre un faux cache et un faux réseau.
 *
 * La porte répond 401 à tout ce qui arrive sans session, et marque ses réponses
 * `x-cairn-connexion`. Aucune ne doit se ranger à la place de l'app : sinon le
 * téléphone rouvrirait la page de connexion hors ligne, ou même en ligne, sous
 * l'adresse de l'écran du matin.
 */

const ORIGIN = 'https://cairn.test';
const SOURCE = readFileSync(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');

const keyOf = (k: string | { url: string }): string => {
  const url = new URL(typeof k === 'string' ? k : k.url, ORIGIN);
  return url.pathname + url.search;
};

class FakeCache {
  readonly entries = new Map<string, Response>();
  async match(k: string | { url: string }) { return this.entries.get(keyOf(k))?.clone(); }
  async put(k: string | { url: string }, res: Response) { this.entries.set(keyOf(k), res); }
  async keys() { return [...this.entries.keys()].map((k) => ({ url: ORIGIN + k })); }
  async delete(k: string | { url: string }) { return this.entries.delete(keyOf(k)); }
}

let caches: Map<string, FakeCache>;
let network: (url: string) => Response | Promise<Response>;
let handlers: Record<string, (event: unknown) => void>;

beforeEach(() => {
  caches = new Map();
  handlers = {};
  network = () => { throw new TypeError('Load failed'); };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn; },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  };
  const cacheStorage = {
    open: async (name: string) => { if (!caches.has(name)) caches.set(name, new FakeCache()); return caches.get(name)!; },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const fetch = async (input: string | { url: string }) => network(new URL(typeof input === 'string' ? input : input.url, ORIGIN).pathname);
  new Function('self', 'caches', 'fetch', SOURCE)(self, cacheStorage, fetch);
});

/** Une requête du navigateur, et ce qu'en fait le worker, tâches de fond comprises. */
async function browse(path: string, mode: 'navigate' | 'cors' = 'navigate'): Promise<Response> {
  let responded: Promise<Response> | undefined;
  const background: Promise<unknown>[] = [];
  handlers.fetch!({
    request: { url: ORIGIN + path, method: 'GET', mode },
    respondWith: (p: Promise<Response>) => { responded = p; },
    waitUntil: (p: Promise<unknown>) => { background.push(p); },
  });
  const res = await responded!;
  await Promise.all(background);
  return res;
}

/**
 * Ce que le worker répond, sans attendre ses tâches de fond : derrière un réseau
 * muet, celle qui met la réserve à jour ne se termine jamais.
 */
function respond(path: string, mode: 'navigate' | 'cors' = 'navigate'): Promise<Response | undefined> {
  let responded: Promise<Response> | undefined;
  handlers.fetch!({
    request: { url: ORIGIN + path, method: 'GET', mode },
    respondWith: (p: Promise<Response>) => { responded = p; },
    waitUntil: () => {},
  });
  return responded ?? Promise.resolve(undefined);
}

const shell = () => caches.get('cairn-shell-v2')!;
const data = () => caches.get('cairn-data')!;
const app = (text: string) => new Response(text, { status: 200, headers: { 'content-type': 'text/html' } });
const login = (status: number) => new Response('<h1>Cairn</h1> connexion', {
  status, headers: { 'content-type': 'text/html', 'x-cairn-connexion': status === 401 ? 'requise' : 'porte' },
});
/** Une réponse que le navigateur a obtenue en suivant une redirection. */
const redirected = (res: Response): Response => Object.defineProperty(res, 'redirected', { value: true });

describe('Le service worker et la porte', () => {
  it('garde l\'app en cache quand le réseau répond 401', async () => {
    network = () => app('matin');
    await browse('/');
    network = () => login(401);
    expect(await (await browse('/')).text()).toBe('matin');
    expect(await (await shell().match('/'))!.text()).toBe('matin');
  });

  it('ne range jamais un 401 à la place de l\'app', async () => {
    network = () => login(401);
    expect((await browse('/')).status).toBe(401);
    expect(await shell().match('/')).toBeUndefined();
  });

  it('ne range jamais une réponse de la porte, même en 200, ni une page atteinte par redirection', async () => {
    network = () => login(200);
    await browse('/');
    expect(await shell().match('/')).toBeUndefined();
    network = () => redirected(app('connexion'));
    await browse('/point');
    expect(await shell().match('/point')).toBeUndefined();
  });

  it('ne remplace pas la dernière lecture par un refus de la porte', async () => {
    network = () => new Response('{"athlete":"pierre"}', { status: 200, headers: { 'content-type': 'application/json' } });
    await browse('/api/state', 'cors');
    network = () => new Response('{"error":"Connexion requise."}', { status: 401, headers: { 'x-cairn-connexion': 'requise' } });
    expect((await browse('/api/state', 'cors')).status).toBe(401);
    network = () => new Response('{}', { status: 200, headers: { 'x-cairn-connexion': 'porte' } });
    await browse('/api/state', 'cors');
    expect(await (await data().match('/api/state'))!.text()).toBe('{"athlete":"pierre"}');
  });

  it('reste lisible hors ligne, depuis son cache', async () => {
    network = () => app('matin');
    await browse('/');
    network = () => new Response('{"athlete":"pierre"}', { status: 200, headers: { 'content-type': 'application/json' } });
    await browse('/api/state', 'cors');
    network = () => { throw new TypeError('Load failed'); };
    expect(await (await browse('/')).text()).toBe('matin');
    const state = await browse('/api/state', 'cors');
    expect(await state.text()).toBe('{"athlete":"pierre"}');
    expect(state.headers.get('x-cairn-recorded-at')).toBeTruthy();
  });
});

describe('Hors ligne, toute l’app sur sa dernière lecture', () => {
  const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  /** Un réseau qui ne répond jamais : le Mac éteint derrière Funnel. */
  const silent = () => new Promise<Response>(() => {});

  it('ouvre le plan, et une sortie déjà vue, sur ce qu’ils ont lu en ligne', async () => {
    // Le 02/10, Mac éteint : « je peux seulement charger le point du jour. Je
    // ne peux pas charger les séances, je ne peux pas charger le plan. »
    network = (path) => (path.startsWith('/api/') ? json(`{"lu":"${path}"}`) : app(`page ${path}`));
    await browse('/plan');
    await browse('/api/plan?weeks=8', 'cors');
    await browse('/activities/strava-1');
    await browse('/api/activities/strava-1', 'cors');
    network = () => { throw new TypeError('Load failed'); };
    expect(await (await browse('/plan')).text()).toBe('page /plan');
    expect(await (await browse('/api/plan?weeks=8', 'cors')).text()).toBe('{"lu":"/api/plan"}');
    expect(await (await browse('/activities/strava-1')).text()).toBe('page /activities/strava-1');
    expect(await (await browse('/api/activities/strava-1', 'cors')).text()).toBe('{"lu":"/api/activities/strava-1"}');
  });

  it('n’attend pas un Mac qui ne répond pas : la réserve, datée, au bout de quelques secondes', async () => {
    network = () => json('{"athlete":"pierre"}');
    await browse('/api/state', 'cors');
    vi.useFakeTimers();
    try {
      network = silent;
      let served: Response | undefined;
      void respond('/api/state', 'cors').then((r) => { served = r; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(served, 'toujours en attente du réseau').toBeDefined();
      expect(await served!.text()).toBe('{"athlete":"pierre"}');
      expect(served!.headers.get('x-cairn-recorded-at')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('laisse tomber vite un changement d’écran sans réseau : le navigateur rouvre alors la page gardée', async () => {
    // Un lien du menu demande à Next la page en données (`_rsc`) : sans réponse,
    // il recharge l'adresse, et c'est la page gardée qui s'ouvre.
    vi.useFakeTimers();
    try {
      network = silent;
      let served: Response | undefined;
      void respond('/plan?_rsc=1a2b', 'cors').then((r) => { served = r; });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(served?.type).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne jette jamais un fragment dont une page gardée a besoin', async () => {
    network = (path) => (path.startsWith('/_next/') ? new Response('js') : app('<script src="/_next/static/chunks/socle.js"></script>'));
    await browse('/_next/static/chunks/socle.js', 'cors');
    await browse('/plan');
    for (let i = 0; i < 130; i++) await browse(`/_next/static/chunks/autre-${i}.js`, 'cors');
    expect(await shell().match('/_next/static/chunks/socle.js')).toBeDefined();
    expect(await shell().match('/plan')).toBeDefined();
  });
});

describe('Les écrans gardés d’avance', () => {
  it('gardent aussi les fragments qu’ils chargent : un écran sans eux ne s’affiche pas', async () => {
    // Le 02/10, serveur coupé : le plan, gardé dès l'installation mais jamais
    // ouvert en ligne, s'ouvrait sur « Cet écran n'a pas pu s'afficher » —
    // ChunkLoadError sur le fragment de sa page.
    network = (path) =>
      path.startsWith('/_next/') ? new Response(`js ${path}`) : app(`<script src="/_next/static/chunks${path === '/' ? '/matin' : path}.js"></script>`);
    const pending: Promise<unknown>[] = [];
    handlers.install!({ waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.all(pending);
    network = () => { throw new TypeError('Load failed'); };
    expect(await (await browse('/plan')).text()).toContain('/_next/static/chunks/plan.js');
    expect(await (await browse('/_next/static/chunks/plan.js', 'cors')).text()).toBe('js /_next/static/chunks/plan.js');
  });
});
