// Lets Pocket open offline, and open fast. Opening Pocket shows the saved copy of the page and fetches a new copy in
// the background for next time. A new version appears on the next opening, or sooner when Pocket finds it
// (updateIfNew in views.js, whose request for the page always goes to the network). If no copy is saved yet, the page
// comes from the network, and from the saved copy if the network fails. Libraries and icons have their version in
// their file name, so their saved copies are never out of date. Only Pocket's own files are handled here. Requests to
// Vikunja's API pass through and nothing from them is stored.
const CACHE = 'pocket-2';
const SCOPE = new URL('./', self.registration.scope).pathname;
const PAGE = new URL('index.html', self.registration.scope).href;
const PAGE_PATH = new URL(PAGE).pathname;

// The local files a copy of the page refers to: scripts, the manifest, icons and the chrono import.
const filesOf = html => {
  const files = new Set();
  for (const m of html.matchAll(/(?:^|[\s<])(?:src|href)="(?![#/]|[a-z]+:)([^"?#]+)"/g)) files.add(m[1]);
  for (const m of html.matchAll(/from\s+'\.\/([^']+)'/g)) files.add(m[1]);
  return [...files];
};

// Save the page and every local file it refers to.
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  const html = await (await fetch(PAGE, { cache: 'no-cache' })).text();
  await cache.addAll(['index.html', ...filesOf(html)]);
  await self.skipWaiting();
})()));

// Save a new copy of the page, after the files it names that aren't saved yet. A release that renames a library
// changes only the page, not this file, so without this the new page would open offline without its library. Only
// Pocket's page is saved, not a sign-in page a proxy answered with.
async function keep(res) {
  const html = await res.clone().text();
  if (!html.includes('<meta name="pocket-build"')) return;
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const f of filesOf(html)) if (!(await cache.match(f, { ignoreVary: true }))) missing.push(f);
  await cache.addAll(missing);
  await cache.put(PAGE, res);
}

self.addEventListener('activate', event => event.waitUntil((async () => {
  // Delete only Pocket's old caches. Vikunja's web app keeps its own caches at this address too.
  for (const key of await caches.keys()) if (key.startsWith('pocket-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (url.pathname === SCOPE || url.pathname === PAGE_PATH) {
    // Fetch the page from the network and save it once it has fully arrived (keep). A failed save still returns the
    // new page. If the server returns an error instead of Pocket (a proxy's 502, say), use the saved copy when there is
    // one, because an installed Pocket has no reload button. A 304 (Pocket asking whether the page changed) passes
    // through unchanged.
    const fresh = fetch(event.request).then(async res => {
      if (res.ok) { await keep(res.clone()).catch(() => {}); return res; }
      return res.status >= 500 && (await caches.match(PAGE)) || res;
    });
    event.waitUntil(fresh.catch(() => {}));
    // When the user opens Pocket, answer with the saved page if there is one, while the network copy is saved behind
    // it. When Pocket asks for its own page to check for a new version, answer with the network copy.
    event.respondWith((async () => {
      const saved = event.request.mode === 'navigate' && await caches.match(PAGE);
      return saved || fresh.catch(() => caches.match(PAGE));
    })());
    return;
  }
  // ignoreVary is needed because Vikunja answers with "Vary: Origin", and the chrono import is requested with an Origin
  // header that the saved request didn't have. Without it the saved copy is missed offline and quick add finds no dates.
  event.respondWith(caches.match(event.request, {ignoreVary: true}).then(hit => hit || fetch(event.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(event.request, copy)); }
    return res;
  })));
});
