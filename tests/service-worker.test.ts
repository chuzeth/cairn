import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_URL } from '../apps/web/lib/figure3d/model';

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
let network: (url: string, init?: { method?: string; body?: string }) => Response | Promise<Response>;
let handlers: Record<string, (event: unknown) => void>;
/** Ce que le worker dit aux écrans ouverts. */
let told: Record<string, unknown>[];
/** Les notifications montrées, et les fenêtres ouvertes. */
let shown: { title: string; options: { body?: string; tag?: string; data?: { url?: string } } }[];
let opened: string[];
let windows: { focus: () => Promise<void>; postMessage: (m: Record<string, unknown>) => void }[];
/** La file d'écritures du téléphone (`lib/offline.ts`), telle qu'IndexedDB la garde. */
let outbox: { id: number; path: string; body: unknown; queuedAt: string }[];

/** IndexedDB, réduit à ce que la file en demande : tout lire, retirer une écriture. */
function fakeIndexedDB() {
  const request = <T>(result: () => T) => {
    const req: { result?: T; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = {};
    queueMicrotask(() => { req.result = result(); req.onsuccess?.(); });
    return req;
  };
  const store = {
    getAll: () => request(() => outbox.map((x) => ({ ...x }))),
    delete: (id: number) => request(() => { outbox = outbox.filter((x) => x.id !== id); }),
  };
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => store }),
    close: () => {},
  };
  return { open: () => request(() => database) };
}

beforeEach(() => {
  caches = new Map();
  handlers = {};
  told = [];
  shown = [];
  opened = [];
  outbox = [];
  windows = [{ focus: async () => {}, postMessage: (m) => { told.push(m); } }];
  network = () => { throw new TypeError('Load failed'); };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn; },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); },
    },
    registration: {
      showNotification: async (title: string, options: (typeof shown)[number]['options']) => { shown.push({ title, options }); },
    },
    skipWaiting: async () => {},
  };
  const cacheStorage = {
    open: async (name: string) => { if (!caches.has(name)) caches.set(name, new FakeCache()); return caches.get(name)!; },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const fetch = async (input: string | { url: string }, init?: { method?: string; body?: string }) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    return network(init?.method === 'POST' || url.search.includes('weeks') || url.search.includes('days') ? url.pathname + url.search : url.pathname, init);
  };
  new Function('self', 'caches', 'fetch', 'indexedDB', SOURCE)(self, cacheStorage, fetch, fakeIndexedDB());
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
    expect(await (await browse('/api/plan?weeks=8', 'cors')).text()).toBe('{"lu":"/api/plan?weeks=8"}');
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

describe('Le mannequin des schémas 3D', () => {
  /** L'installation, et toutes ses tâches. */
  async function install() {
    const pending: Promise<unknown>[] = [];
    handlers.install!({ waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.all(pending);
  }

  it('est rangé dès l’installation, et sert hors ligne sans avoir jamais été ouvert', async () => {
    network = (path) => (path === MODEL_URL ? new Response('glb', { status: 200 }) : app('écran'));
    await install();
    network = () => { throw new TypeError('Load failed'); };
    expect(await (await browse(MODEL_URL, 'cors')).text()).toBe('glb');
  });

  it('se garde à part des pages : la purge des pages vues ne l’emporte pas', async () => {
    network = (path) => (path === MODEL_URL ? new Response('glb', { status: 200 }) : app('écran'));
    await install();
    expect(await caches.get('cairn-figures')!.match(MODEL_URL)).toBeDefined();
    expect(await shell().match(MODEL_URL)).toBeUndefined();
  });

  it('remplace l’ancien mannequin quand il change de nom', async () => {
    const figures = new FakeCache();
    caches.set('cairn-figures', figures);
    await figures.put('/figures/mannequin-00000000.glb', new Response('ancien'));
    await figures.put(MODEL_URL, new Response('glb'));
    const pending: Promise<unknown>[] = [];
    handlers.activate!({ waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.all(pending);
    expect(caches.get('cairn-figures')).toBe(figures);
    expect(await figures.match('/figures/mannequin-00000000.glb')).toBeUndefined();
    expect(await figures.match(MODEL_URL)).toBeDefined();
  });
});

describe('Le Mac dort : rien n’attend', () => {
  const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  const silent = () => new Promise<Response>(() => {});

  it('sert la dernière lecture en une seconde, puis tout de suite tant que le Mac se tait', async () => {
    // Le 10/11 : le téléphone sert quand le Mac dort. Chaque lecture attendait
    // quatre secondes un réseau muet, chaque changement d'écran huit.
    network = () => json('{"athlete":"pierre"}');
    await browse('/api/state', 'cors');
    await browse('/api/tests', 'cors');
    vi.useFakeTimers();
    try {
      network = silent;
      let first: Response | undefined;
      void respond('/api/state', 'cors').then((r) => { first = r; });
      await vi.advanceTimersByTimeAsync(1500);
      expect(first, 'servie au bout d’une seconde et demie').toBeDefined();
      expect(first!.headers.get('x-cairn-recorded-at')).toBeTruthy();
      // Une seconde sans réponse a suffi : le Mac se tait, les lectures suivantes ne l'attendent plus.
      let second: Response | undefined;
      void respond('/api/tests', 'cors').then((r) => { second = r; });
      await vi.advanceTimersByTimeAsync(20);
      expect(second, 'servie sans attendre').toBeDefined();
      // Ni un changement d'écran : le navigateur rouvre la page gardée aussitôt.
      let screen: Response | undefined;
      void respond('/plan?_rsc=1a2b', 'cors').then((r) => { screen = r; });
      await vi.advanceTimersByTimeAsync(20);
      expect(screen?.type).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('dit aux écrans que le Mac a répondu après coup avec du neuf, et seulement s’il y a du neuf', async () => {
    network = () => json('{"seance":"footing"}');
    await browse('/api/plan?weeks=9', 'cors');
    vi.useFakeTimers();
    try {
      // Le Mac répond en trois secondes, avec un plan réécrit : la réserve a servi entre-temps.
      network = () => new Promise((resolve) => setTimeout(() => resolve(json('{"seance":"seuil"}')), 3000));
      let served: Response | undefined;
      const background: Promise<unknown>[] = [];
      handlers.fetch!({
        request: { url: `${ORIGIN}/api/plan?weeks=9`, method: 'GET', mode: 'cors' },
        respondWith: (p: Promise<Response>) => { void p.then((r) => { served = r; }); },
        waitUntil: (p: Promise<unknown>) => { background.push(p); },
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(await served!.text()).toBe('{"seance":"footing"}');
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all(background);
      expect(told).toContainEqual({ type: 'frais', path: '/api/plan?weeks=9' });
      expect(await (await data().match('/api/plan?weeks=9'))!.text()).toBe('{"seance":"seuil"}');
      // La même réponse, en retard : rien à redire.
      told = [];
      const again: Promise<unknown>[] = [];
      handlers.fetch!({
        request: { url: `${ORIGIN}/api/plan?weeks=9`, method: 'GET', mode: 'cors' },
        respondWith: () => {}, waitUntil: (p: Promise<unknown>) => { again.push(p); },
      });
      await vi.advanceTimersByTimeAsync(3500);
      await Promise.all(again);
      expect(told.filter((m) => m.type === 'frais')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Une notification synchronise le téléphone sans qu’on l’ouvre', () => {
  const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

  /** Une notification reçue, app fermée : ce que le worker en fait, tâches comprises. */
  async function push(payload: Record<string, unknown>) {
    const pending: Promise<unknown>[] = [];
    handlers.push!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.all(pending);
  }

  it('se montre, relit tout ce que les écrans lisent, et date la synchronisation', async () => {
    // Le 10/11, Pierre : « j'ouvre mon ordinateur, il faut que l'application,
    // même si je ne l'ouvre pas sur mon téléphone, puisse se synchroniser. »
    windows = [];
    network = (path) => json(`{"lu":"${path}","v":1}`);
    await browse('/api/races', 'cors');
    await browse('/api/activities/strava-1', 'cors');
    const seen: string[] = [];
    network = (path) => { seen.push(path); return json(`{"lu":"${path}","v":2}`); };
    await push({ title: 'Aujourd\'hui : Seuil, 53 min', body: 'Le premier effort soutenu.', url: '/' });

    expect(shown).toEqual([{ title: 'Aujourd\'hui : Seuil, 53 min', options: { body: 'Le premier effort soutenu.', tag: 'cairn', data: { url: '/' } } }]);
    // Les lectures de l'écran du matin, du plan, des séances, des tests — et ce que le téléphone avait déjà lu.
    for (const path of ['/api/state', '/api/plan?weeks=9', '/health', '/api/glossary', '/api/activities?days=90&limit=300', '/api/tests', '/api/races']) {
      expect(seen, path).toContain(path);
      expect(await (await data().match(path))!.text(), path).toBe(`{"lu":"${path}","v":2}`);
    }
    // Le détail d'une sortie ne change plus : il n'est pas relu.
    expect(seen).not.toContain('/api/activities/strava-1');
    const sync = await (await browse('/__synchro', 'cors')).json() as { full?: string };
    expect(Date.now() - Date.parse(sync.full!)).toBeLessThan(5000);
  });

  it('envoie d’abord ce que le téléphone gardait, dans l’ordre, avant de relire', async () => {
    windows = [];
    outbox = [
      { id: 1, path: '/api/answers', body: { question: 'run_pain', subject: 's11', value: { score: 0 } }, queuedAt: '2026-11-11T06:10:00Z' },
      { id: 2, path: '/api/checkin', body: { date: '2026-11-11', fatigue: 2 }, queuedAt: '2026-11-11T06:11:00Z' },
    ];
    const calls: string[] = [];
    network = (path, init) => { calls.push(`${init?.method ?? 'GET'} ${path}`); return json('{}'); };
    await push({ title: 'Plan ajusté', body: '' });
    expect(calls.slice(0, 2)).toEqual(['POST /api/answers', 'POST /api/checkin']);
    expect(calls.indexOf('GET /api/state')).toBeGreaterThan(1);
    expect(outbox).toEqual([]);
  });

  it('garde en file ce que le Mac n’a pas pris, et ne date rien si la lecture échoue', async () => {
    windows = [];
    outbox = [{ id: 1, path: '/api/answers', body: {}, queuedAt: '2026-11-11T06:10:00Z' }];
    // La notification arrive quand le Mac s'est rendormi : elle se montre quand même.
    network = () => { throw new TypeError('Load failed'); };
    await push({ title: 'Cairn a une question', body: 'Une douleur ?' });
    expect(shown).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(await (await browse('/__synchro', 'cors')).json()).toEqual({});
    // Une écriture que le Mac refuse reste là : c'est l'écran qui le dira.
    network = (path, init) => (init?.method === 'POST' ? new Response('{"error":"non"}', { status: 400 }) : json('{}'));
    await push({ title: 'Cairn', body: '' });
    expect(outbox).toHaveLength(1);
  });

  it('ouvre l’app quand on touche la notification, ou la ramène devant', async () => {
    windows = [];
    const pending: Promise<unknown>[] = [];
    const notification = { close: vi.fn(), data: { url: '/' } };
    handlers.notificationclick!({ notification, waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.all(pending);
    expect(notification.close).toHaveBeenCalled();
    expect(opened).toEqual([`${ORIGIN}/`]);
    const focus = vi.fn(async () => {});
    windows = [{ focus, postMessage: () => {} }];
    handlers.notificationclick!({ notification, waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    await Promise.all(pending);
    expect(focus).toHaveBeenCalled();
    expect(opened).toHaveLength(1);
  });

  it('relit les mêmes adresses que les écrans', async () => {
    const { PLAN_URL, activitiesUrl } = await import('../apps/web/lib/api');
    expect(SOURCE).toContain(`'${PLAN_URL}'`);
    expect(SOURCE).toContain(`'${activitiesUrl()}'`);
  });
});
