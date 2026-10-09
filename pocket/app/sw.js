// Lets Pocket open without a connection, and at once. Opening Pocket shows the page saved last time, and fetches the
// page behind it to save for next time: a new version shows on the next opening, or sooner when Pocket finds it
// (updateIfNew, in views.js, whose request for the page goes to the network). With no page saved yet, it comes from
// the network, and from the saved copy when it can't. The libraries and icons have their version in their name, so
// the saved copy of those is always right. Only Pocket's own files are handled here; requests to Vikunja's API pass
// straight through and nothing from them is stored.
const CACHE = 'pocket-2';
const SCOPE = new URL('./', self.registration.scope).pathname;
const PAGE = new URL('index.html', self.registration.scope).href;
const PAGE_PATH = new URL(PAGE).pathname;

// Save the page and every local file it refers to (scripts, the manifest, icons, the chrono import).
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const html = await (await fetch(PAGE, { cache: 'no-cache' })).text();
  const files = new Set(['index.html']);
  for (const m of html.matchAll(/(?:^|[\s<])(?:src|href)="(?![#/]|[a-z]+:)([^"?#]+)"/g)) files.add(m[1]);
  for (const m of html.matchAll(/from\s+'\.\/([^']+)'/g)) files.add(m[1]);
  await cache.addAll([...files]);
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  // Only Pocket's own old copies: Vikunja's web app keeps its caches at this address too.
  for (const key of await caches.keys()) if (key.startsWith('pocket-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (url.pathname === SCOPE || url.pathname === PAGE_PATH) {
    // The page from the network, saved once it has all come. A server error instead of Pocket (a proxy's 502, say) gets
    // the saved copy too, when there is one: an installed Pocket has no reload button to get out of it. (A 304, Pocket
    // asking whether it changed, passes as it is.)
    const fresh = fetch(event.request).then(async res => {
      if (res.ok) { await (await caches.open(CACHE)).put(PAGE, res.clone()); return res; }
      return res.status >= 500 && (await caches.match(PAGE)) || res;
    });
    event.waitUntil(fresh.catch(() => {}));
    // Opening Pocket: the saved page, if there is one, the network's saved behind it. Pocket's own request for its page
    // (whether there's a new version): the network's.
    event.respondWith((async () => {
      const saved = event.request.mode === 'navigate' && await caches.match(PAGE);
      return saved || fresh.catch(() => caches.match(PAGE));
    })());
    return;
  }
  // ignoreVary: Vikunja answers with "Vary: Origin", and the chrono import is asked for with an Origin the saved copy's
  // request didn't have, so it would be missed offline (and quick add would read no dates).
  event.respondWith(caches.match(event.request, {ignoreVary: true}).then(hit => hit || fetch(event.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
    return res;
  })));
});
