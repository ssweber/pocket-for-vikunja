// Opening on the saved screen (boot in src/js/app/auth.js). Pocket shows saved lists only when the sign-in token is the
// one it last confirmed for that user. It recognises the token by its hash. Pocket sends nothing until Vikunja has
// said who the user is.
import { stores } from './outbox-db.mjs';
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import auth from '../../src/js/app/auth.js';
import sending from '../../src/js/app/sending.js';
import { api, setSeenToken, sharedToken, tokenHash } from '../../src/js/api.js';
import { saved } from '../../src/js/lists.js';
import { sync, uuid7 } from '../../src/js/sync.js';

const ME = { id: 7, username: 'alex' };
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// A fake Vikunja. /user answers only when the test calls `answer`, and every request is recorded in `requests`.
function vikunja(user = ME) {
  const v = { requests: [] };
  let answer;
  const asked = new Promise(ok => {
    answer = ok;
  });
  v.answer = () => answer();
  globalThis.fetch = async (url, { method = 'GET', headers = {} } = {}) => {
    const path = new URL(url).pathname.replace(/^\/api\/v2/, '');
    v.requests.push({ method, path, auth: headers.Authorization });
    if (path === '/user') {
      await asked;
      return reply(user);
    }
    if (path === '/info') return reply({ max_items_per_page: 50 });
    return reply({ id: 1 });
  };
  return v;
}
// The component with the real auth and sending code. The methods boot calls on the rest of the app are stubs that
// record which screens were shown and whether each used the saved copy.
function app() {
  const c = component(auth, sending);
  Object.assign(c, {
    user: null,
    info: null,
    perms: {},
    seenBy: {},
    runDrafts: {},
    shown: [],
    setProjects(list) {
      this.projects = list;
    },
    refreshPending() {},
    sweep() {},
    async loadProjects() {
      this.shown.push('projects');
    },
    async render({ kept = false } = {}) {
      this.shown.push(kept ? 'kept' : 'loaded');
      return kept;
    },
  });
  c.flush = sending.flush;
  return c;
}
// Saves `user` as confirmed for `token`, and keeps the token Pocket opens with. This uses localStorage.clear() because
// saved.clear() walks the keys of the page's localStorage, and the stub in Node has none.
const keep = async (token, user = ME) => {
  const t = sharedToken.get();
  localStorage.clear();
  sharedToken.set(t);
  saved.set('user', user);
  saved.set('who', { id: user.id, hash: await tokenHash(token) });
};
const settle = () => new Promise(ok => setTimeout(ok, 10));
// Waits until boot has asked Vikunja who the user is. By then boot has shown the saved screen, if there is one, and is
// holding changes back. This polls instead of waiting a fixed time, because the token's hash is computed off the main
// thread and takes longer on a busy computer. With every test file running at once, 10 ms was not always enough.
const asked = async v => {
  for (let i = 0; i < 500 && !v.requests.some(r => r.path === '/user'); i++) await settle();
};

test('a token is stored as its SHA-256 hash and never as itself', async () => {
  assert.equal(await tokenHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('opening with the last confirmed token shows the saved screen before Vikunja names the user, and changes wait for that', async () => {
  const v = vikunja(),
    c = app();
  await keep('tk_test');
  const booted = c.boot();
  await asked(v);
  assert.deepEqual(c.shown, ['kept'], 'the saved screen is shown and nothing is loaded yet');
  assert.equal(c.user.id, ME.id);
  const write = api('/tasks/1', { method: 'POST', body: { done: true } });
  await settle();
  assert.ok(!v.requests.some(r => r.method === 'POST'), 'the change waits until /user answers');
  v.answer();
  await booted;
  await write;
  assert.deepEqual(c.shown, ['kept', 'projects', 'loaded']);
  assert.deepEqual(
    v.requests.map(r => r.method + ' ' + r.path),
    ['GET /user', 'GET /info', 'POST /tasks/1'],
  );
});

test("opening with a different token waits for Vikunja, then saves that token's hash for next time", async () => {
  const v = vikunja(),
    c = app();
  await keep('tk_before');
  const booted = c.boot();
  await asked(v);
  assert.deepEqual(c.shown, [], 'nothing is shown before /user answers');
  v.answer();
  await booted;
  await settle();
  assert.deepEqual(c.shown, ['projects', 'loaded']);
  assert.deepEqual(saved.get('who'), { id: ME.id, hash: await tokenHash('tk_test') });
  assert.equal((await app().keptUser())?.id, ME.id, 'the next opening shows the saved screen');
});

test('a 401 that renewing the session does not fix signs Pocket out and says the session ended', async () => {
  const c = Object.assign(app(), { user: ME, info: {}, login: {}, dropSheet() {}, forgetPeople() {} });
  globalThis.fetch = async () => reply({ message: 'expired' }, 401);
  await assert.rejects(api('/tasks/1'), { status: 401 });
  assert.equal(c.screen, 'login');
  assert.equal(c.login.err, 'Your session ended. Sign in again.');
  assert.ok(!sharedToken.get());
});

test('when Vikunja names a different user for the saved token, the saved lists are cleared and the waiting change is not sent', async () => {
  const v = vikunja({ id: 9, username: 'priya' }),
    c = app();
  await keep('tk_test');
  let again = 0;
  c.switchAccount = function () {
    again++;
    localStorage.clear();
    this.user = null;
  };
  const booted = c.boot();
  await asked(v);
  const write = api('/tasks/1', { method: 'POST', body: { done: true } }).then(
    () => 'sent',
    e => e.status,
  );
  v.answer();
  await booted;
  assert.equal(await write, 401);
  assert.equal(again, 1);
  assert.equal(saved.get('user'), null);
  assert.ok(!v.requests.some(r => r.method === 'POST'));
});

test('the saved screen shows only for the token whose hash is saved, and the saved hash follows a renewal by Pocket', async () => {
  const c = app();
  vikunja();
  await keep('jwt-1');
  sharedToken.set('jwt-1');
  assert.equal((await c.keptUser())?.id, ME.id);
  sharedToken.set('jwt-2'); // Vikunja's web app renewed the token
  assert.equal(await c.keptUser(), null);
  // Pocket renews the token itself. The request gets a 401, Pocket refreshes the token, and it sends the request again.
  await keep('jwt-1');
  sharedToken.set('jwt-1');
  setSeenToken('jwt-1');
  c.user = ME;
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

// A tick waiting in the outbox, for task 5.
const waitingTick = () => ({
  id: uuid7(),
  kind: 'act',
  op: 'done',
  task: 5,
  user: ME.id,
  at: new Date().toISOString(),
  n: 0,
  files: [],
});
// The flag in localStorage that says the outbox's database had no entries when it was last read.
const EMPTY = 'pocket.outbox.empty';
// Another copy of sync.js, as a new page loads it, once it has read the outbox's database.
const newPage = async name => {
  const page = (await import('../../src/js/sync.js?' + name)).sync;
  await page.ready;
  return page;
};
// Runs `fn` when the outbox's database next stores an entry, before its transaction commits.
const onStore = fn => {
  const outbox = stores.get('outbox');
  outbox.set = (k, v) => {
    delete outbox.set;
    fn();
    return outbox.set(k, v);
  };
};

test('the outbox reads as empty only once a read of its database finds no entries', async () => {
  const a = waitingTick(),
    b = waitingTick();
  localStorage.removeItem(EMPTY);
  assert.ok(!sync.seenEmpty(), 'a phone with no flag may have entries waiting');
  await newPage('empty');
  assert.ok(sync.seenEmpty(), 'a new page found no entries');
  let flagged;
  onStore(() => (flagged = sync.seenEmpty()));
  await sync.add(a, []);
  assert.equal(flagged, false, 'the flag is deleted before the entry is written');
  await sync.add(b, []);
  await sync.remove(a.id);
  assert.ok(!sync.seenEmpty(), 'an entry is still waiting');
  await sync.remove(b.id);
  assert.ok(sync.seenEmpty(), 'the last entry was removed');
});

test('an "empty" written by another tab while an entry is saved, or one the database contradicts, is deleted', async () => {
  const e = waitingTick();
  onStore(() => localStorage.setItem(EMPTY, '1')); // another tab, from a read made before this write
  await sync.add(e, []);
  assert.ok(!sync.seenEmpty(), 'the save deletes the flag again once it commits');
  localStorage.setItem(EMPTY, '1');
  await newPage('contradicted');
  assert.ok(!sync.seenEmpty(), 'a new page that finds an entry deletes the flag');
  // This tab's read found no entries before another tab added `e`. The flag this tab then writes is deleted.
  await sync.noteEmpty();
  assert.ok(!sync.seenEmpty(), 'the database is read again after the flag is written');
  await sync.remove(e.id);
});

test("when localStorage can't be written or read, the outbox reads as maybe not empty", async () => {
  const { getItem, setItem } = localStorage;
  localStorage.removeItem(EMPTY);
  localStorage.setItem = () => {
    throw new DOMException('full', 'QuotaExceededError');
  };
  await sync.noteEmpty();
  localStorage.setItem = setItem;
  assert.ok(!sync.seenEmpty(), 'a flag that did not fit is missing');
  await sync.noteEmpty();
  localStorage.getItem = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  assert.ok(!sync.seenEmpty(), 'a flag that cannot be read');
  localStorage.getItem = getItem;
  assert.ok(sync.seenEmpty());
});

// The app with stubs that read the outbox as the screen does, and record what each screen was drawn with. It sends
// nothing.
function outboxApp() {
  return Object.assign(app(), {
    flush() {},
    refreshPending() {
      this.pending = this.user ? sync.all(this.user.id) : [];
    },
    async render({ kept = false } = {}) {
      this.shown.push(kept ? 'kept' : 'loaded');
      this.drawnWith = { projects: this.projects, waiting: this.pending.map(e => e.id) };
      return kept;
    },
  });
}

test('with the outbox empty when last read, the saved screen shows at once while the outbox database is held up', async () => {
  const v = vikunja(),
    c = outboxApp(),
    tick = waitingTick(),
    ready = sync.ready;
  await keep('tk_test');
  await sync.add(tick, []);
  await sync.remove(tick.id); // the last change was sent
  sync.ready = new Promise(() => {}); // the database never opens
  const start = Date.now();
  try {
    const booted = c.boot();
    await asked(v);
    assert.deepEqual(c.shown, ['kept']);
    assert.ok(Date.now() - start < 1500, 'the saved screen does not wait for the database');
    assert.deepEqual(c.drawnWith.waiting, []);
    v.answer();
    await booted;
  } finally {
    sync.ready = ready;
  }
});

test('with a change waiting, the saved screen waits for the outbox database, and shows the change on it', async () => {
  const v = vikunja(),
    c = outboxApp(),
    tick = waitingTick(),
    ready = sync.ready;
  await keep('tk_test');
  await sync.add(tick, []);
  sync.entries.delete(tick.id); // as on a new page, which reads the tick once the database opens
  let open;
  sync.ready = new Promise(ok => {
    open = () => {
      sync.entries.set(tick.id, tick);
      ok();
    };
  });
  try {
    const booted = c.boot();
    for (let i = 0; i < 10; i++) await settle();
    assert.deepEqual(c.shown, [], 'nothing is drawn while the database is held up');
    open();
    await asked(v);
    assert.deepEqual(c.shown, ['kept']);
    assert.deepEqual(c.drawnWith.waiting, [tick.id], 'the waiting tick is on the saved screen');
    v.answer();
    await booted;
  } finally {
    sync.ready = ready;
    await sync.remove(tick.id);
  }
});

test('opening with a different token shows the saved screen once Vikunja names the user, before the projects load', async () => {
  const v = vikunja(),
    c = outboxApp(),
    tick = waitingTick(),
    inbox = { id: 1, title: 'Inbox' };
  await keep('tk_before');
  saved.set('projects', [inbox]);
  sync.entries.set(tick.id, tick);
  let projectsIn;
  c.loadProjects = function () {
    this.shown.push('projects');
    return new Promise(ok => {
      projectsIn = ok;
    });
  };
  try {
    const booted = c.boot();
    await asked(v);
    v.answer();
    for (let i = 0; i < 100 && !c.shown.includes('kept'); i++) await settle();
    assert.deepEqual(c.shown, ['projects', 'kept'], 'the saved screen is shown while the projects load');
    assert.deepEqual(c.drawnWith, { projects: [inbox], waiting: [tick.id] });
    projectsIn();
    await booted;
    assert.deepEqual(c.shown, ['projects', 'kept', 'loaded']);
  } finally {
    sync.entries.delete(tick.id);
  }
});
