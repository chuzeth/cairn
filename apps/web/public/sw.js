/**
 * Cairn sans réseau.
 *
 * Le 19 septembre, le Mac a dormi trente-sept heures et l'application n'a pas
 * existé : Safari affichait une erreur réseau, et il n'y avait rien derrière.
 * Un service worker ne réveille pas le Mac. Il fait que Cairn s'ouvre quand
 * même, sur ce qu'il a vu la dernière fois — et qu'il dise de quand ça date.
 *
 * Le 2 octobre, Mac éteint : « je peux seulement charger le point du jour. Je
 * ne peux pas charger les séances, je ne peux pas charger le plan. » Seuls
 * trois écrans étaient gardés, et une lecture attendait sans fin un Mac que
 * Funnel ne joignait plus. Toute l'app se garde désormais, et rien n'attend
 * plus de quelques secondes.
 *
 * Le 10 novembre : le téléphone sert surtout quand le Mac dort, et depuis le
 * 20 octobre il n'avait pas joint le Mac une seule fois. Chaque lecture
 * attendait quatre secondes un réseau muet, chaque changement d'écran huit. Une
 * lecture gardée sort désormais au bout d'une seconde, et tout de suite tant que
 * le Mac se tait ; quand il répond après coup avec du neuf, l'écran est prévenu
 * et se relit. Et le Mac prévient le téléphone quand il a du neuf (`push`) : la
 * notification se montre, et le worker en profite pour envoyer ce que le
 * téléphone gardait et tout relire — l'app fermée est à jour quand on l'ouvre.
 *
 * Six règles, une seule idée derrière : ce qui sort du cache n'est pas une
 * mesure d'aujourd'hui.
 *
 *   pages      chaque page vue en ligne est gardée ; `SHELL_ROUTES` le sont
 *              dès l'installation. Une page gardée sort du cache avant tout
 *              réseau, et le réseau la rafraîchit derrière, sans retenir
 *              l'affichage. Quand la page se découvre plus ancienne que le Mac,
 *              elle fait ranger ici les pages du nouveau commit avant de se
 *              recharger (`lib/version.ts`).
 *   lecture    la dernière réponse réussie est gardée, datée du moment où elle
 *              a été obtenue. Le réseau a `FAST_WAIT_MS` pour répondre ; au-delà,
 *              ou en échec, la réponse gardée sert, avec sa date dans l'en-tête
 *              `x-cairn-recorded-at`, que l'écran affiche. Une réponse du
 *              réseau ne porte rien : elle est d'aujourd'hui. Arrivée après
 *              coup et différente, elle est dite aux écrans (`frais`).
 *   synchro    `syncAll` : les écritures en attente partent, puis tout ce que
 *              les écrans lisent est relu d'un bloc. À la demande de la page
 *              qui s'ouvre, et à chaque notification. Sa date se lit sous
 *              `/__synchro`.
 *   push       une notification du Mac : elle se montre toujours — iOS retire
 *              l'abonnement de qui en reçoit sans rien montrer —, puis lance
 *              la synchronisation.
 *   porte      une réponse de la porte (`x-cairn-connexion`), un 401 ou une
 *              page atteinte par redirection ne se rangent jamais : la page de
 *              connexion ne prend pas la place de l'app, ni un refus celle de la
 *              dernière lecture (`cacheable`).
 *   écriture   la file est à la page (`lib/offline.ts`) : elle seule peut dire
 *              « en attente d'envoi » à l'athlète. Le worker la vide quand il
 *              synchronise, app fermée ; ce que le Mac refuse y reste, et
 *              c'est l'écran qui le dira.
 *   mannequin  le corps des schémas 3D (`lib/figure3d`) est rangé dès
 *              l'installation, à part des pages, et sort du cache avant tout
 *              réseau : il porte son empreinte dans son nom. three.js, lui, est
 *              un fragment des écrans qui montrent un schéma, gardé avec eux.
 *
 * Écrit à la main, sans dépendance ni étape de construction : le fichier qui
 * s'exécute sur le téléphone est celui qui se relit ici.
 */

/** Les pages suivent le code ; un changement de règle ici les réécrit en entier. */
const SHELL = 'cairn-shell-v2';

/**
 * Les réponses gardées, elles, ne suivent pas le code : une mise à jour n'a
 * aucune raison de jeter le dernier état connu — c'est exactement ce qu'on
 * cherche au réveil suivant.
 */
const DATA = 'cairn-data';

/** Les écrans du menu : gardés dès l'installation, et renouvelés à chaque version. */
const SHELL_ROUTES = ['/', '/point', '/coach', '/plan', '/activities', '/exercices', '/seance'];

/** Leurs noms, ceux du menu : la page « pas de réseau » les dit comme l'app. */
const SHELL_NAMES = {
  '/': 'Aujourd’hui',
  '/point': 'Point',
  '/coach': 'Coach',
  '/plan': 'Plan',
  '/activities': 'Séances',
  '/exercices': 'Exercices',
  '/seance': 'Séance',
};

/**
 * Ce qui est gardé en réserve : tout ce que les écrans lisent, sauf le
 * domicile (`/api/home`), qui n'a rien à faire sur le téléphone hors de
 * l'écran qui le demande. `/api/state` porte les chiffres et la disponibilité,
 * `/api/plan` les séances, `/health` le fait que Strava réponde. C'est la date
 * de `/api/state` que l'écran du matin affiche — les autres la suivent d'une
 * même requête. `/api/glossary` ne date de rien : c'est ce que ses mots
 * veulent dire. Une adresse et ce qui la suit après `/` : `/api/activities`
 * garde aussi chaque sortie vue.
 */
const KEPT = [
  '/api/state', '/api/plan', '/health', '/api/glossary', '/api/activities', '/api/races', '/api/curves',
  '/api/pmc', '/api/insights', '/api/chat/history', '/api/tests',
];

/**
 * Le mannequin des schémas 3D, nommé par son empreinte : le même nom que
 * `MODEL_URL` (`lib/figure3d/model.ts`), ce que vérifie
 * `tests/exercise-figures-3d.test.ts`. À part des pages : rangé avec elles, il
 * tomberait sous leur purge (`trim`), qui prend pour une page tout ce qui n'est
 * pas un fragment de Next.
 */
const FIGURES = 'cairn-figures';
const FIGURE_ASSETS = ['/figures/mannequin-603f2975.glb'];

/** La date du relevé, portée du cache jusqu'à l'écran. */
const RECORDED_AT = 'x-cairn-recorded-at';

/**
 * Ce que le réseau a pour répondre avant que la réserve serve, ms. Le Mac
 * répond en quelques dizaines de millisecondes, quelques centaines par Funnel ;
 * endormi, Funnel peut garder la connexion ouverte sans jamais rien rendre. Une
 * seconde : au-delà, l'écran s'affiche sur sa dernière lecture, et se corrige
 * si le Mac finit par répondre.
 */
const FAST_WAIT_MS = 1200;

/** Ce qu'une requête a pour aboutir avant d'être tenue pour perdue, ms. */
const NETWORK_MAX_MS = 10000;

/**
 * Le Mac vient de ne pas répondre : pendant ce délai, plus rien ne l'attend —
 * ni une lecture, ni un changement d'écran. Chaque lecture le retente derrière,
 * sans retenir l'affichage, et la première réponse lève le silence.
 */
const DOWN_FOR_MS = 60000;
let downAt = 0;
const down = () => Date.now() - downAt < DOWN_FOR_MS;

/** Ce qu'une page jamais vue attend avant d'abandonner, ms. */
const PAGE_WAIT_MS = 8000;

/**
 * Ce qu'un changement d'écran attend le Mac avant de rouvrir la page gardée, ms.
 * Trois secondes, et non huit : la page gardée est là, et s'ouvre sans lui.
 */
const RSC_WAIT_MS = 3000;

/**
 * Ce que les écrans du menu lisent, sous les adresses exactes où ils le
 * lisent (`PLAN_URL`, `activitiesUrl` de `lib/api.ts` — un test les compare).
 * Une synchronisation les relit toutes, vues ou non : le téléphone tient alors
 * tout ce qu'il peut montrer, à la même date.
 */
const CORE_READS = [
  '/api/state', '/api/plan?weeks=9', '/health', '/api/glossary', '/api/activities?days=90&limit=300', '/api/tests',
];

/** Le détail d'une sortie : une fois analysée, elle ne change plus, et ne se relit pas. */
const isActivityDetail = (key) => /^\/api\/activities\/[^/?]+$/.test(key);

/** Où se lit la date de la dernière synchronisation — une adresse que seul le worker sert. */
const SYNC_PATH = '/__synchro';

/** La file d'écritures de la page (`lib/offline.ts`) : même base, même magasin. */
const OUTBOX_DB = 'cairn';
const OUTBOX_STORE = 'outbox';

/**
 * Les fragments de Next portent leur empreinte dans leur nom : ceux d'une
 * construction passée ne seront jamais redemandés et resteraient là pour
 * toujours. Au-delà de cette taille, les plus anciens partent — sauf ceux
 * qu'une page gardée charge.
 */
const SHELL_MAX = 120;

/** Au-delà, les pages vues le plus anciennement partent — jamais les écrans du menu. */
const PAGES_MAX = 24;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Chacune pour elle-même : `addAll` échoue en bloc, et une route
      // manquante laisserait les autres hors cache.
      await Promise.all(SHELL_ROUTES.map((route) => keep(cache, route)));
      await Promise.all(FIGURE_ASSETS.map((url) => figure(url)));
    })(),
  );
});

/**
 * Pas de `skipWaiting` à l'installation : une page ouverte demande les fragments
 * de la construction qui l'a rendue. Prendre la main sous elle pour lui servir
 * une autre coquille casserait la page qu'on a sous les yeux. La nouvelle
 * version attend que l'application soit refermée — ou que la page, qui va se
 * recharger, le demande elle-même (`skip-waiting`, plus bas).
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== SHELL && name !== DATA && name !== FIGURES) await caches.delete(name);
      }
      const figures = await caches.open(FIGURES);
      for (const k of await figures.keys()) {
        if (!FIGURE_ASSETS.includes(new URL(k.url).pathname)) await figures.delete(k);
      }
      // Première installation : la page déjà ouverte passe sous contrôle sans
      // attendre un rechargement.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Les écritures ne passent pas par ici : la page les met en file elle-même.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === SYNC_PATH) return event.respondWith(readSync().then((sync) => json(sync)));
  if (kept(url.pathname)) return event.respondWith(reserve(event));
  if (request.mode === 'navigate') return event.respondWith(shell(event));
  if (url.pathname.startsWith('/_next/static/')) return event.respondWith(fragment(request));
  if (FIGURE_ASSETS.includes(url.pathname)) return event.respondWith(figure(url.pathname));
  // Un lien du menu demande à Next l'écran suivant en données. Sans réponse,
  // l'échec rapide lui fait recharger l'adresse — et c'est la page gardée qui
  // s'ouvre, au lieu d'un toucher qui ne fait rien. Le Mac vient de se taire :
  // l'échec est immédiat.
  if (url.searchParams.has('_rsc') || request.headers?.get?.('rsc') === '1') {
    if (down()) return event.respondWith(Promise.resolve(Response.error()));
    return event.respondWith(
      within(fetch(request), RSC_WAIT_MS).then(
        (res) => { downAt = 0; return res; },
        () => { downAt = Date.now(); return Response.error(); },
      ),
    );
  }
});

/**
 * Une notification du Mac. Elle se montre d'abord — toujours, quoi qu'il arrive
 * ensuite —, puis le téléphone se synchronise : c'est le seul moment où une app
 * fermée peut le faire. Une seule à l'écran (`tag`) : la nouvelle remplace
 * l'ancienne.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // Un message illisible se montre quand même, sous le nom de l'app.
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Cairn';
  const options = {
    body: typeof data.body === 'string' ? data.body : '',
    tag: 'cairn',
    data: { url: typeof data.url === 'string' ? data.url : '/' },
  };
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), syncAll().catch(() => {})]));
});

/** Toucher la notification ouvre l'app — ou la ramène devant, si elle l'est déjà. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const open = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))[0];
      if (open) return open.focus();
      return self.clients.openWindow(url);
    })(),
  );
});

/**
 * Le système a renouvelé l'abonnement : le nouveau est donné au Mac, sans quoi
 * les notifications partiraient vers une adresse morte.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const { publicKey } = await (await fetch('/api/push/key', { cache: 'no-store' })).json();
      const subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription, origin: self.location.origin, device: 'renouvelé' }),
      });
    })().catch(() => {}),
  );
});

/**
 * Ce que la page demande avant de se recharger sur une nouvelle version.
 *
 *   skip-waiting   ce worker, neuf, prend la main : la page qui le demande va
 *                  se recharger, rien ne se casse sous elle.
 *   renew-shell    ranger les pages d'un commit ; la réponse dit si c'est fait.
 *   sync           tout envoyer, tout relire ; la réponse dit ce qui est parti.
 */
self.addEventListener('message', (event) => {
  const { data } = event;
  if (data?.type === 'skip-waiting') {
    event.waitUntil(self.skipWaiting());
  } else if (data?.type === 'renew-shell' && typeof data.commit === 'string') {
    const reply = (ok) => event.ports[0]?.postMessage({ ok });
    event.waitUntil(renew(data.commit).then(reply, () => reply(false)));
  } else if (data?.type === 'sync') {
    // La page qui s'ouvre demande une synchronisation complète ; la réponse dit ce qu'elle a donné.
    const reply = (result) => event.ports[0]?.postMessage(result);
    event.waitUntil(syncAll().then(reply, () => reply({ ok: false, sent: 0 })));
  }
});

/** Une adresse gardée en réserve : l'une de `KEPT`, ou ce qui la suit après `/`. */
const kept = (path) => KEPT.some((k) => path === k || path.startsWith(`${k}/`));


/** Le résultat de `promise`, ou un refus au bout de `ms`. */
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`sans réponse après ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Une page de l'app, telle qu'on peut la rouvrir : du HTML que l'app a rendu. */
const isPage = (res) => cacheable(res) && (res.headers.get('content-type') ?? '').includes('text/html');

/** Les pages gardées : tout ce qui n'est pas un fragment. */
const isPagePath = (path) => !path.startsWith('/_next/');

/**
 * Les pages d'un commit précis, rangées d'un bloc.
 *
 * Les écrans du menu sont relus sans cache et doivent tous porter ce commit dans
 * leur `<meta name="cairn-commit">` : sinon le Mac est entre deux versions, et
 * rien n'est rangé. Les autres pages gardées sont relues avec eux ; une page
 * qui ne répond plus en est retirée. Les fragments entrent avant les pages, si
 * bien que la page rechargée s'ouvre complète — même si le réseau tombe entre
 * les deux.
 */
async function renew(commit) {
  const cache = await caches.open(SHELL);
  const seen = (await cache.keys())
    .map((k) => new URL(k.url).pathname)
    .filter((path) => isPagePath(path) && !SHELL_ROUTES.includes(path));
  const read = async (route) => {
    try {
      const res = await fetch(route, { cache: 'no-store' });
      return { route, res, html: isPage(res) ? await res.clone().text() : '' };
    } catch {
      return { route, res: null, html: '' };
    }
  };
  const pages = await Promise.all(SHELL_ROUTES.map(read));
  if (pages.some(({ html }) => commitOf(html) !== commit)) return false;
  const others = (await Promise.all(seen.map(read))).filter(({ html }) => commitOf(html) === commit);

  if (!(await withFragments(cache, [...pages, ...others].map(({ html }) => html).join('\n')))) return false;
  for (const { route, res } of [...pages, ...others]) await cache.put(route, res);
  for (const route of seen) {
    if (!others.some((o) => o.route === route)) await cache.delete(route);
  }
  await trim(cache);
  return true;
}

const commitOf = (html) => /<meta name="cairn-commit" content="([^"]*)"/.exec(html)?.[1] ?? null;

/** Les fragments qu'une page charge, tels qu'elle les écrit. */
const fragmentsOf = (html) => html.match(/\/_next\/static\/[^"'\\\s)]+/g) ?? [];

/**
 * Une page : gardée, elle sort du cache, et le réseau la rafraîchit derrière.
 *
 * L'écran s'affiche sans attendre le Mac, puis se corrige si le Mac répond.
 * Une page jamais vue a `PAGE_WAIT_MS` pour arriver ; sans elle, on dit ce qui
 * manque au lieu de servir l'écran du matin sous son adresse.
 */
async function shell(event) {
  const route = new URL(event.request.url).pathname;
  const cache = await caches.open(SHELL);
  const cached = await cache.match(route, { ignoreVary: true });

  if (cached) {
    event.waitUntil(keep(cache, route));
    return cached;
  }

  // Jamais vue, et le Mac vient de se taire : on dit tout de suite ce qui manque.
  if (down()) return absent(route, cache);
  try {
    const res = await within(fetch(event.request), PAGE_WAIT_MS);
    if (isPage(res)) await put(cache, route, res.clone());
    return res;
  } catch {
    downAt = Date.now();
    return absent(route, cache);
  }
}

/** Un fragment de Next porte son empreinte : mis en cache, il n'y périme pas. */
async function fragment(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res)) await put(cache, request, res.clone());
  return res;
}

/** Le mannequin : gardé, il sort du cache ; sinon il vient du réseau et se range. */
async function figure(path) {
  const cache = await caches.open(FIGURES);
  const hit = await cache.match(path, { ignoreVary: true });
  if (hit) return hit;
  try {
    const res = await fetch(path);
    if (cacheable(res)) await cache.put(path, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

/**
 * Une lecture gardée : le réseau d'abord, la réserve très vite ensuite.
 *
 * Le réseau d'abord, parce qu'un chiffre d'aujourd'hui vaut mieux qu'un chiffre
 * d'hier — mais pas plus de `FAST_WAIT_MS` quand une réserve existe, et pas du
 * tout quand le Mac vient de se taire : elle sert, datée, et le réseau finit
 * derrière de la mettre à jour. S'il répond après coup avec autre chose que ce
 * qui a servi, les écrans l'apprennent (`frais`) et se relisent : on ne reste
 * pas sur le relevé de la veille alors que celui du jour vient d'arriver.
 */
async function reserve(event) {
  const { request } = event;
  const cache = await caches.open(DATA);
  // L'adresse entière : les écrans lisent des fenêtres en jours, pas en dates
  // (`PLAN_URL`, `activitiesUrl`), et la même fenêtre garde la même adresse.
  const url = new URL(request.url);
  const key = url.pathname + url.search;
  const cached = await cache.match(key, { ignoreVary: true });
  const before = cached ? cached.clone() : null;
  /** La réserve a servi avant que le réseau ne réponde. */
  let late = false;

  const network = (async () => {
    let res;
    try {
      res = await within(fetch(request), NETWORK_MAX_MS);
    } catch (e) {
      downAt = Date.now();
      throw e;
    }
    downAt = 0;
    // Un 5xx n'est pas une réponse : le serveur est là, la donnée n'y est pas.
    if (res.status >= 500) throw new Error(`${res.status}`);
    if (cacheable(res)) {
      const body = await res.clone().blob();
      await cache.put(key, stamped(body, res.headers));
      await contact();
      if (late && before && (await before.text()) !== (await body.text())) await tell({ type: 'frais', path: key });
    }
    return res;
  })();

  // Rien en réserve : la réponse du réseau, ou son erreur, telle quelle. Mentir
  // ici — un corps vide, un 200 — ferait afficher un écran sans données comme
  // un écran sans entraînement.
  if (!cached) return network;
  event.waitUntil(network.catch(() => {}));
  if (down()) {
    late = true;
    return cached;
  }
  return within(network, FAST_WAIT_MS).catch(() => {
    late = true;
    // Une seconde sans réponse : le Mac est tenu pour muet dès maintenant, sans
    // attendre que la requête soit perdue. S'il répond ensuite, le silence est levé.
    if (!down()) downAt = Date.now();
    return cached;
  });
}

// ── Synchroniser : tout envoyer, tout relire ─────────────────────────────────

/** Ce que le worker dit aux écrans ouverts. */
async function tell(message) {
  for (const client of await self.clients.matchAll({ type: 'window' })) client.postMessage(message);
}

const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** `{ at?, full? }` : la dernière lecture réussie, et la dernière synchronisation complète. */
async function readSync() {
  const hit = await (await caches.open(DATA)).match(SYNC_PATH);
  try {
    return hit ? await hit.json() : {};
  } catch {
    return {};
  }
}

async function saveSync(patch) {
  const cache = await caches.open(DATA);
  await cache.put(SYNC_PATH, json({ ...(await readSync()), ...patch }));
}

/** Le Mac vient de répondre : noté, une fois par demi-minute au plus. */
let contactSavedAt = 0;
async function contact() {
  const now = Date.now();
  if (now - contactSavedAt < 30000) return;
  contactSavedAt = now;
  await saveSync({ at: new Date(now).toISOString() });
}

/** Une seule synchronisation à la fois : la page qui s'ouvre et une notification peuvent la demander ensemble. */
let syncing = null;
function syncAll() {
  syncing ??= synchronize().finally(() => { syncing = null; });
  return syncing;
}

/**
 * Les écritures d'abord — le Mac en tient compte dans ce qu'il rend ensuite —,
 * puis toutes les lectures : celles des écrans du menu, et tout ce que le
 * téléphone a déjà lu. La synchronisation n'est datée que si les premières ont
 * toutes abouti : une date qui couvre des écrans restés sur la veille mentirait.
 */
async function synchronize() {
  const sent = await flushOutbox();
  const cache = await caches.open(DATA);
  const held = (await cache.keys())
    .map((k) => { const u = new URL(k.url); return u.pathname + u.search; })
    .filter((key) => key !== SYNC_PATH && !isActivityDetail(key));
  const wanted = [...new Set([...CORE_READS, ...held])];
  const read = await Promise.all(
    wanted.map(async (key) => {
      try {
        const res = await within(fetch(key, { cache: 'no-store' }), NETWORK_MAX_MS);
        if (!cacheable(res)) return false;
        await cache.put(key, stamped(await res.blob(), res.headers));
        return true;
      } catch {
        return false;
      }
    }),
  );
  const ok = CORE_READS.every((key) => read[wanted.indexOf(key)]);
  if (ok) {
    downAt = 0;
    const now = new Date().toISOString();
    await saveSync({ at: now, full: now });
    // App fermée, les pages suivent la version du Mac : ouverte hors ligne, elle
    // sera la dernière. App ouverte, c'est elle qui s'en charge (`lib/version.ts`).
    const windows = await self.clients.matchAll({ type: 'window' });
    if (windows.length === 0) await renewIfNewer().catch(() => {});
  }
  await tell({ type: 'synchro', ok, sent });
  return { ok, sent };
}

/** Le Mac sert un autre commit que les pages gardées : elles sont rangées de nouveau. */
async function renewIfNewer() {
  const health = await (await caches.open(DATA)).match('/health');
  const commit = health ? (await health.json()).version?.commit : null;
  const page = await (await caches.open(SHELL)).match('/', { ignoreVary: true });
  if (typeof commit !== 'string' || !page) return;
  const held = commitOf(await page.text());
  if (held && held !== commit) await renew(commit);
}

/** Un accès à la file d'écritures ; rejette si IndexedDB manque ou refuse. */
function outboxStore(run) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(OUTBOX_DB, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(OUTBOX_STORE)) {
        opening.result.createObjectStore(OUTBOX_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const database = opening.result;
      const req = run(database.transaction(OUTBOX_STORE, 'readwrite').objectStore(OUTBOX_STORE));
      req.onsuccess = () => { database.close(); resolve(req.result); };
      req.onerror = () => { database.close(); reject(req.error); };
    };
  });
}

/**
 * Envoie ce que le téléphone gardait, dans l'ordre où il l'a gardé. Le Mac ne
 * répond pas : la file attend. Il refuse : l'écriture reste, et c'est la page,
 * à l'ouverture, qui dira ce refus — ici, personne ne le lirait. Le rejeu est
 * sûr : l'API fusionne (`lib/offline.ts`).
 */
async function flushOutbox() {
  if (typeof indexedDB === 'undefined') return 0;
  let sent = 0;
  try {
    for (const item of await outboxStore((store) => store.getAll())) {
      const res = await within(
        fetch(item.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.body ?? {}) }),
        NETWORK_MAX_MS,
      );
      if (!res.ok) break;
      await outboxStore((store) => store.delete(item.id));
      sent++;
    }
  } catch {
    // Hors réseau, ou file illisible : rien n'est perdu, la prochaine fois réessaiera.
  }
  return sent;
}

/**
 * Obtient une page et la garde, avec les fragments qu'elle charge ; un échec
 * laisse en place ce qui y était.
 *
 * Gardée seule, une page qu'on n'a jamais ouverte en ligne s'ouvrait hors ligne
 * sur « Cet écran n'a pas pu s'afficher » : son HTML était là, pas le fragment
 * de sa page (le plan, le 02/10). Une page n'entre qu'avec tous les siens.
 */
async function keep(cache, route) {
  try {
    const res = await fetch(route, { cache: 'no-store' });
    if (!isPage(res)) return;
    if (!(await withFragments(cache, await res.clone().text()))) return;
    await put(cache, route, res);
  } catch {
    // Hors réseau à l'installation : la page se rangera au premier passage.
  }
}

/** Range les fragments qu'une page charge ; `false` si l'un d'eux manque. */
async function withFragments(cache, html) {
  const stored = await Promise.all(
    [...new Set(fragmentsOf(html))].map(async (url) => {
      if (await cache.match(url, { ignoreVary: true })) return true;
      const res = await fetch(url);
      if (cacheable(res)) await cache.put(url, res);
      return cacheable(res);
    }),
  );
  return !stored.includes(false);
}

/**
 * Ce qui peut se ranger : une réponse réussie de l'app elle-même. La porte
 * répond sans session par un 401 marqué, jamais par une redirection — mais une
 * redirection suivie arriverait ici en 200, et la page de connexion se
 * rangerait sous l'adresse qui l'a demandée.
 */
function cacheable(res) {
  return res.ok && !res.redirected && !res.headers.has('x-cairn-connexion');
}

async function put(cache, key, res) {
  await cache.put(key, res);
  await trim(cache);
}

/**
 * Ce qui part quand la place manque : les pages vues le plus anciennement, au-
 * delà de `PAGES_MAX`, puis les fragments les plus anciens au-delà de
 * `SHELL_MAX`. Jamais un écran du menu, jamais un fragment qu'une page gardée
 * charge : en jetant les plus anciens, on jetait d'abord ceux qu'aucune version
 * ne change — ceux dont toutes les pages ont besoin.
 */
async function trim(cache) {
  const paths = (await cache.keys()).map((k) => {
    const url = new URL(k.url);
    return url.pathname + url.search;
  });
  const seen = paths.filter((p) => isPagePath(p) && !SHELL_ROUTES.includes(p));
  for (const old of seen.slice(0, Math.max(0, seen.length - PAGES_MAX))) await cache.delete(old);

  const fragments = paths.filter((p) => !isPagePath(p));
  if (fragments.length <= SHELL_MAX) return;
  const used = new Set();
  for (const p of paths.filter(isPagePath)) {
    const page = await cache.match(p, { ignoreVary: true });
    if (!page) continue;
    for (const f of fragmentsOf(await page.text())) {
      const url = new URL(f, self.location.origin);
      used.add(url.pathname + url.search);
    }
  }
  let excess = fragments.length - SHELL_MAX;
  for (const old of fragments) {
    if (excess <= 0) break;
    if (used.has(old)) continue;
    await cache.delete(old);
    excess--;
  }
}

/**
 * Le corps, sa nature, et la date du relevé — rien d'autre.
 *
 * Les en-têtes d'origine décrivent un transfert qui n'aura plus lieu :
 * `content-encoding` et `content-length` parlent d'octets compressés là où on
 * garde des octets lus. Recopiés, ils feraient échouer la relecture.
 */
function stamped(body, headers) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': headers.get('content-type') ?? 'application/json',
      [RECORDED_AT]: new Date().toISOString(),
    },
  });
}

/**
 * Une page que Cairn n'a pas en réserve, sans réseau.
 *
 * Servir `/` à sa place afficherait l'écran du matin sous l'adresse demandée :
 * on dit ce qui manque, et on rend les écrans qui sont là.
 */
async function absent(route, cache) {
  const here = [];
  for (const path of SHELL_ROUTES) {
    if (await cache.match(path, { ignoreVary: true })) here.push(`<a href="${path}">${SHELL_NAMES[path]}</a>`);
  }
  const body = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Cairn — hors réseau</title>
<style>
  :root { color-scheme: light; }
  /* La barre d'état recouvre le haut de l'écran : le titre se pose dessous,
     ici comme dans l'application. */
  body { margin:0; padding:calc(env(safe-area-inset-top) + 48px) 20px 48px;
         background:#F4F2EE; color:#15181B;
         font:16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width:420px; margin:0 auto; }
  h1 { font-family:ui-serif, "New York", Georgia, serif; font-size:34px; line-height:1.05; margin:0 0 12px; font-weight:400; }
  p { margin:0 0 20px; color:#4A5056; font-size:15px; }
  code { color:#4A5056; }
  a { display:block; padding:12px 0; color:#15181B; text-decoration:underline;
      text-underline-offset:3px; text-decoration-color:#C9C3B8; }
</style></head><body><main>
<h1>Pas de réseau</h1>
<p>Cairn n'a pas <code>${route.replace(/[&<>"]/g, '')}</code> en réserve : cette page n'a jamais été
ouverte en ligne. Le Mac dort, ou Funnel ne le joint plus. Ce qui reste ouvert :</p>
${here.join('\n')}
</main></body></html>`;
  return new Response(body, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
