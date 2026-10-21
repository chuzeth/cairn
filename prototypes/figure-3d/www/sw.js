/**
 * Le prototype sans réseau : la page, le code et le mannequin gardés au
 * premier passage, servis du cache ensuite — le réseau rafraîchit derrière.
 * C'est la règle « pages » du service worker de Cairn, réduite à l'essentiel,
 * pour mesurer ce qu'un schéma 3D demande hors ligne.
 */
const CACHE = 'fig3d-v1';
const PRECACHE = ['./', './index.html', './viewer.js', './mannequin.glb'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const kept = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then((r) => {
          if (r.ok) cache.put(e.request, r.clone());
          return r;
        })
        .catch(() => kept ?? Response.error());
      return kept ?? fresh;
    }),
  );
});
