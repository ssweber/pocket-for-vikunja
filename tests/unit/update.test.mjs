// Pocket checks for a new version of itself on each refresh (updateIfNew in views.js). It reloads only when the
// server sends a page from another build, which it tells by the build id that scripts/build.mjs writes into the page.
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import views from '../../src/js/app/views.js';

const page = id => `<!doctype html><html><head><meta charset="utf-8"><meta name="pocket-build" content="${id}">`;

/* Runs one check from a copy of Pocket built as "aaa", with `answer` as the reply to its request for the page.
   Returns whether the page reloaded and the headers the request carried. */
async function check(answer, typed = '') {
  const app = component(views);
  Object.assign(app, {
    screen: 'app',
    sheet: { open: false },
    cap: { text: typed, busy: false },
    runInsert: { text: '' },
    capPhotos: [],
    searchQ: '',
    movingOverdue: false,
    starting: false,
    pending: [],
  });
  const query = document.querySelector,
    fetchBefore = globalThis.fetch;
  let reloaded = false,
    sent = null;
  document.querySelector = s => (s === 'meta[name="pocket-build"]' ? { content: 'aaa' } : null);
  Object.assign(location, { href: 'http://pocket.test/api/v1/plugins/pocket/', reload: () => (reloaded = true) });
  globalThis.fetch = async (url, { headers = {} } = {}) => {
    sent = headers;
    return answer();
  };
  try {
    await app.updateIfNew();
  } finally {
    document.querySelector = query;
    globalThis.fetch = fetchBefore;
  }
  return { reloaded, sent };
}

test('Pocket reloads when the server sends a page from another build', async () => {
  const { reloaded, sent } = await check(() => new Response(page('bbb'), { status: 200 }));
  assert.equal(reloaded, true);
  assert.equal(sent['If-None-Match'], 'W/"aaa"', 'the request names the build Pocket runs');
});

test("Pocket doesn't reload over typed text", async () => {
  assert.equal((await check(() => new Response(page('bbb')), 'half-typed')).reloaded, false);
});

test("Pocket doesn't reload when the check fails or finds the same build", async () => {
  const answers = {
    // The server's answer when its page has the build Pocket named.
    'a 304': () => new Response(null, { status: 304 }),
    'no connection': () => Promise.reject(new TypeError('network error')),
    // sw.js answers with its saved copy, and a 200, when the network fails or the server sends a 5xx.
    'the saved copy of the same build': () => new Response(page('aaa'), { status: 200 }),
    "a 200 that isn't Pocket, such as a sign-in page in front of the server": () =>
      new Response('<html><body>Sign in</body></html>', { status: 200 }),
    'an error': () => new Response(page('bbb'), { status: 502 }),
  };
  for (const [what, answer] of Object.entries(answers)) assert.equal((await check(answer)).reloaded, false, what);
});
