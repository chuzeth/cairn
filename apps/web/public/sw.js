/**
 * Cairn sans réseau.
 *
 * Le 19 septembre, le Mac a dormi trente-sept heures et l'application n'a pas
 * existé : Safari affichait une erreur réseau, et il n'y avait rien derrière.
 * Un service worker ne réveille pas le Mac. Il fait que Cairn s'ouvre quand
 * même, sur ce qu'il a vu la dernière fois — et qu'il dise de quand ça date.
 *
 * Trois règles, une seule idée derrière : ce qui sort du cache n'est pas une
 * mesure d'aujourd'hui.
 *
 *   coquille   `/`, `/point` et `/coach` sortent du cache avant tout réseau ;
 *              le réseau les rafraîchit derrière, sans retenir l'affichage.
 *   lecture    la dernière réponse réussie est gardée, datée du moment où elle
 *              a été obtenue. Resservie, elle porte cette date dans l'en-tête
 *              `x-cairn-recorded-at`, que l'écran affiche. Une réponse du
 *              réseau ne porte rien : elle est d'aujourd'hui.
 *   écriture   rien ici. Une file tenue par un service worker ne peut pas dire
 *              « en attente d'envoi » à l'athlète : c'est la page qui la tient
 *              (`lib/offline.ts`), et qui le dit.
 *
 * Écrit à la main, sans dépendance ni étape de construction : le fichier qui
 * s'exécute sur le téléphone est celui qui se relit ici.
 */

/** La coquille suit le code ; un changement de règle ici la réécrit en entier. */
const SHELL = 'cairn-shell-v1';

/**
 * Les réponses gardées, elles, ne suivent pas le code : une mise à jour n'a
 * aucune raison de jeter le dernier état connu — c'est exactement ce qu'on
 * cherche au réveil suivant.
 */
const DATA = 'cairn-data';

/** Ce qui s'ouvre le matin, et doit donc s'ouvrir sans réseau. */
const SHELL_ROUTES = ['/', '/point', '/coach'];

/**
 * Ce qui est gardé en réserve. `/api/state` porte les chiffres et la
 * disponibilité, `/api/plan` la séance du jour, `/health` le fait que Strava
 * réponde : l'écran du matin ne se rend pas sans les trois. C'est la date de
 * `/api/state` qu'il affiche — les autres la suivent d'une même requête.
 */
const KEPT = ['/api/state', '/api/plan', '/health'];

/** La date du relevé, portée du cache jusqu'à l'écran. */
const RECORDED_AT = 'x-cairn-recorded-at';

/**
 * Les fragments de Next portent leur empreinte dans leur nom : ceux d'une
 * construction passée ne seront jamais redemandés et resteraient là pour
 * toujours. Au-delà de cette taille, les plus anciens partent.
 */
const SHELL_MAX = 120;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // Chacune pour elle-même : `addAll` échoue en bloc, et une route
      // manquante laisserait la coquille entière hors cache.
      await Promise.all(SHELL_ROUTES.map((route) => keep(cache, route)));
    })(),
  );
});

/**
 * Pas de `skipWaiting` : une page ouverte demande les fragments de la
 * construction qui l'a rendue. Prendre la main sous elle pour lui servir une
 * autre coquille casserait la page qu'on a sous les yeux. La nouvelle version
 * attend que l'application soit refermée — sur un téléphone, le prochain
 * réveil.
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== SHELL && name !== DATA) await caches.delete(name);
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

  if (KEPT.includes(url.pathname)) return event.respondWith(reserve(request));
  if (request.mode === 'navigate') return event.respondWith(shell(event));
  if (url.pathname.startsWith('/_next/static/')) return event.respondWith(fragment(request));
});

/**
 * La coquille : le cache d'abord, le réseau derrière.
 *
 * L'écran s'affiche sans attendre le Mac, puis se corrige si le Mac répond.
 * Une route hors coquille — `/plan`, `/activities` — n'a rien en réserve : sans
 * réseau, elle le dit au lieu de servir l'écran du matin sous son adresse.
 */
async function shell(event) {
  const route = new URL(event.request.url).pathname;
  const cache = await caches.open(SHELL);
  const cached = SHELL_ROUTES.includes(route)
    ? await cache.match(route, { ignoreVary: true })
    : null;

  if (cached) {
    event.waitUntil(keep(cache, route));
    return cached;
  }

  try {
    const res = await fetch(event.request);
    if (res.ok && SHELL_ROUTES.includes(route)) await put(cache, route, res.clone());
    return res;
  } catch {
    return absent(route);
  }
}

/** Un fragment de Next porte son empreinte : mis en cache, il n'y périme pas. */
async function fragment(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await put(cache, request, res.clone());
  return res;
}

/**
 * Une lecture gardée : le réseau d'abord, la réserve ensuite.
 *
 * Le réseau d'abord, parce qu'un chiffre d'aujourd'hui vaut mieux qu'un chiffre
 * d'hier. La réserve ensuite, datée : l'écran ne montrera pas le relevé de la
 * semaine dernière comme s'il venait d'arriver.
 */
async function reserve(request) {
  const cache = await caches.open(DATA);
  const url = new URL(request.url);
  const key = url.pathname + url.search;

  try {
    const res = await fetch(request);
    // Un 5xx n'est pas une réponse : le serveur est là, la donnée n'y est pas.
    if (res.status >= 500) throw new Error(`${res.status}`);
    if (res.ok) await cache.put(key, stamped(await res.clone().blob(), res.headers));
    return res;
  } catch (networkError) {
    const cached = await cache.match(key, { ignoreVary: true });
    // Rien en réserve : l'erreur réseau remonte telle quelle. Mentir ici —
    // un corps vide, un 200 — ferait afficher un écran sans données comme un
    // écran sans entraînement.
    if (!cached) throw networkError;
    return cached;
  }
}

/** Obtient une route et la garde ; un échec laisse en place ce qui y était. */
async function keep(cache, route) {
  try {
    const res = await fetch(route, { cache: 'no-store' });
    if (res.ok) await put(cache, route, res);
  } catch {
    // Hors réseau à l'installation : la coquille se remplira au premier passage.
  }
}

async function put(cache, key, res) {
  await cache.put(key, res);
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - SHELL_MAX))) {
    if (!SHELL_ROUTES.includes(new URL(old.url).pathname)) await cache.delete(old);
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
 * Servir `/` à sa place afficherait l'écran du matin sous l'adresse du plan :
 * on dit ce qui manque, et on rend les trois écrans qui sont là.
 */
function absent(route) {
  const body = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Cairn — hors réseau</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:48px 20px; background:#0e1316; color:#ece8df;
         font:16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width:420px; margin:0 auto; }
  h1 { font-size:28px; line-height:1.1; margin:0 0 12px; font-weight:640; }
  p { margin:0 0 20px; color:#98a09c; font-size:15px; }
  code { color:#98a09c; }
  a { display:block; padding:12px 0; color:#ece8df; text-decoration:underline;
      text-underline-offset:3px; text-decoration-color:#343d40; }
</style></head><body><main>
<h1>Pas de réseau</h1>
<p>Cairn n'a pas <code>${route.replace(/[&<>"]/g, '')}</code> en réserve. Le Mac dort, ou le
tailnet est coupé. Ce qui reste ouvert :</p>
<a href="/">Le matin</a>
<a href="/point">Le point du jour</a>
<a href="/coach">Le coach</a>
</main></body></html>`;
  return new Response(body, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
