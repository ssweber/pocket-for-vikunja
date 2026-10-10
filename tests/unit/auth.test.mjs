// Opening on the kept screen (src/js/app/auth.js, boot): only with the sign-in Pocket last confirmed as the person whose
// lists it keeps, known by its token's hash, and nothing sent until Vikunja has said who it is.
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import auth from '../../src/js/app/auth.js';
import sending from '../../src/js/app/sending.js';
import { api, setSeenToken, sharedToken, tokenHash } from '../../src/js/api.js';
import { saved } from '../../src/js/lists.js';

const ME = { id: 7, username: 'alex' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// A pretend Vikunja whose /user answers only when the test says (`answer`), and every request kept in `requests`.
function vikunja(user = ME){
  const v = { requests: [] };
  let answer;
  const asked = new Promise(ok => { answer = ok; });
  v.answer = () => answer();
  globalThis.fetch = async (url, { method = 'GET', headers = {} } = {}) => {
    const path = new URL(url).pathname.replace(/^\/api\/v2/, '');
    v.requests.push({ method, path, auth: headers.Authorization });
    if (path === '/user') { await asked; return reply(user); }
    if (path === '/info') return reply({ max_items_per_page: 50 });
    return reply({ id: 1 });
  };
  return v;
}
// The component, with boot's own parts and what it calls on the rest written down: the screens it showed, and whether
// each showed the kept copy.
function app(mode = 'token'){
  const c = component(auth, sending);
  Object.assign(c, {
    mode, user: null, info: null, perms: {}, seenBy: {}, runDrafts: {}, shown: [],
    setProjects(list){ this.projects = list; }, refreshPending(){}, async loadProjects(){ this.shown.push('projects'); },
    async render({ kept = false } = {}){ this.shown.push(kept ? 'kept' : 'loaded'); return kept; },
  });
  c.flush = sending.flush;
  return c;
}
// (localStorage.clear: saved.clear() goes through the keys of the page's localStorage, which the stub in Node hasn't.)
const keep = async (token, user = ME) => { localStorage.clear(); saved.set('user', user); saved.set('who', { id: user.id, hash: await tokenHash(token) }); };
const settle = () => new Promise(ok => setTimeout(ok, 10));
// Until boot has got as far as asking Vikunja who it is: by then it has shown the kept screen, if it shows one, and holds
// changes back. Not a fixed wait: the token's hash is worked out off the main thread, which takes longer on a busy
// computer (with every test file running at once, 10 ms wasn't always enough).
const asked = async v => { for (let i = 0; i < 500 && !v.requests.some(r => r.path === '/user'); i++) await settle(); };

test('a token is kept as its SHA-256, never itself', async () => {
  assert.equal(await tokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('opening with the token last confirmed shows the kept screen before Vikunja says who it is, and a change waits for that', async () => {
  const v = vikunja(), c = app();
  await keep('tk_test');
  const booted = c.boot();
  await asked(v);
  assert.deepEqual(c.shown, ['kept'], 'the kept screen, and nothing loaded yet');
  assert.equal(c.user.id, ME.id);
  const write = api('/tasks/1', { method: 'POST', body: { done: true } });
  await settle();
  assert.ok(!v.requests.some(r => r.method === 'POST'), 'the change waits for /user');
  v.answer();
  await booted; await write;
  assert.deepEqual(c.shown, ['kept', 'projects', 'loaded']);
  assert.deepEqual(v.requests.map(r => r.method + ' ' + r.path), ['GET /user', 'GET /info', 'POST /tasks/1']);
});

test('opening with another token waits for Vikunja, then keeps that token\'s hash for next time', async () => {
  const v = vikunja(), c = app();
  await keep('tk_before');
  const booted = c.boot();
  await asked(v);
  assert.deepEqual(c.shown, [], 'nothing shown before /user');
  v.answer(); await booted; await settle();
  assert.deepEqual(c.shown, ['projects', 'loaded']);
  assert.deepEqual(saved.get('who'), { id: ME.id, hash: await tokenHash('tk_test') });
  assert.equal((await app().keptUser())?.id, ME.id, 'the next opening shows the kept screen');
});

test('someone else answering for the kept token: their lists are cleared, and the change waiting isn\'t sent', async () => {
  const v = vikunja({ id: 9, username: 'priya' }), c = app();
  await keep('tk_test');
  let again = 0; c.switchAccount = function(){ again++; localStorage.clear(); this.user = null; };
  const booted = c.boot();
  await asked(v);
  const write = api('/tasks/1', { method: 'POST', body: { done: true } }).then(() => 'sent', e => e.status);
  v.answer(); await booted;
  assert.equal(await write, 401);
  assert.equal(again, 1);
  assert.equal(saved.get('user'), null);
  assert.ok(!v.requests.some(r => r.method === 'POST'));
});

test('a shared session: the kept screen only for the token whose hash is kept, and the hash follows a renewal Pocket makes', async () => {
  const c = app('session');
  vikunja();
  await keep('jwt-1');
  sharedToken.set('jwt-1');
  assert.equal((await c.keptUser())?.id, ME.id);
  sharedToken.set('jwt-2');                                                   // renewed by Vikunja's web app
  assert.equal(await c.keptUser(), null);
  // Pocket's own renewal: a 401, the refresh cookie spent, the request again with the new token.
  await keep('jwt-1'); sharedToken.set('jwt-1'); setSeenToken('jwt-1'); c.user = ME;
  let n = 0;
  globalThis.fetch = async (url, { headers = {} } = {}) => {
    const path = new URL(url).pathname.replace(/^\/api\/v2/, '');
    if (path === '/user/token/refresh') return reply({ token: 'jwt-3' });
    return n++ ? reply({ id: 1, auth: headers.Authorization }) : reply({ message: 'expired' }, 401);
  };
  assert.equal((await api('/tasks/1')).auth, 'Bearer jwt-3');
  await settle();
  assert.deepEqual(saved.get('who'), { id: ME.id, hash: await tokenHash('jwt-3') });
  assert.equal((await c.keptUser())?.id, ME.id);
  sharedToken.del();
});
