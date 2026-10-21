// Requests to Vikunja (src/js/api.js). Reading a whole list (allPages) reads page 1, then requests the remaining pages
// at the same time, using the largest page size Vikunja allows. A write with a key goes through the plugin's relay.
import { component } from './fake.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allPages, api, nextTry, partOf, passing } from '../../src/js/api.js';

/* A fake Vikunja with a list of `n` items, paged the way Vikunja pages them (at most `max` per page). Each reply is
   delayed briefly so requests made together overlap. It records the requests (`asked`, as [page, per_page]) and the
   most requests open at once (`most`). The page number `fail` answers 500. */
function list(n, { max = 50, fail = 0 } = {}) {
  const v = { asked: [], most: 0 };
  let open = 0;
  globalThis.fetch = async url => {
    const q = new URL(url).searchParams,
      page = +q.get('page'),
      per = Math.min(+q.get('per_page'), max);
    v.asked.push([page, +q.get('per_page')]);
    v.most = Math.max(v.most, ++open);
    await new Promise(ok => setTimeout(ok, 5));
    open--;
    if (page === fail) return new Response('{"message":"broken"}', { status: 500 });
    const all = Array.from({ length: n }, (_, k) => ({ id: k + 1 }));
    return new Response(
      JSON.stringify({ items: all.slice((page - 1) * per, page * per), total: n, total_pages: Math.ceil(n / per) }),
      { status: 200 },
    );
  };
  return v;
}
const ids = n => Array.from({ length: n }, (_, k) => k + 1);

test('a list is read to its end in order, with page 1 first and the other pages at once, past the old limit of 40 pages', async () => {
  component();
  const v = list(2210);
  assert.deepEqual(
    (await allPages('/tasks?filter=done+%3D+true')).map(t => t.id),
    ids(2210),
  );
  assert.equal(v.asked.length, 45);
  assert.deepEqual(v.asked[0], [1, 50], 'the page size is 50 when /info does not give one');
  assert.equal(v.most, 44, 'pages 2 to 45 are requested together');
});

test('a list uses the page size that Vikunja says it allows', async () => {
  const app = component();
  app.info = { max_items_per_page: 500 };
  const v = list(1200, { max: 500 });
  assert.deepEqual(
    (await allPages('/projects')).map(t => t.id),
    ids(1200),
  );
  assert.deepEqual(v.asked.map(([p, per]) => p + '/' + per).sort(), ['1/500', '2/500', '3/500']);
});

test('a list of one page, or an empty list, takes one request', async () => {
  component();
  let v = list(12);
  assert.equal((await allPages('/labels')).length, 12);
  assert.equal(v.asked.length, 1);
  v = list(0);
  assert.deepEqual(await allPages('/labels'), []);
  assert.equal(v.asked.length, 1);
});

test('a page that fails fails the whole read', async () => {
  component();
  list(500, { fail: 7 });
  await assert.rejects(allPages('/tasks'), { status: 500 });
});

/* partOf reads one slice of a list, such as a project's Done list shown 100 at a time. It requests the fewest pages
   that cover the slice, all at once, and also returns the total number of items. */
test('a part of a list is read at once in as few pages as possible, together with the total number of items', async () => {
  const app = component();
  let v = list(3000);
  let part = await partOf('/projects/2/tasks?filter=done+%3D+true', 0, 100);
  assert.deepEqual(
    part.items.map(t => t.id),
    ids(100),
  );
  assert.equal(part.total, 3000);
  assert.deepEqual(
    v.asked.sort(),
    [
      [1, 50],
      [2, 50],
    ],
    'with 50 to a page, two pages are requested together',
  );
  assert.equal(v.most, 2);
  v = list(3000);
  part = await partOf('/tasks', 100, 100);
  assert.deepEqual(
    part.items.map(t => t.id),
    ids(200).slice(100),
    'the next part holds the next 100 items',
  );
  assert.deepEqual(v.asked.sort(), [
    [3, 50],
    [4, 50],
  ]);

  app.info = { max_items_per_page: 500 };
  v = list(3000, { max: 500 });
  part = await partOf('/tasks', 200, 100);
  assert.deepEqual(
    part.items.map(t => t.id),
    ids(300).slice(200),
  );
  assert.deepEqual(v.asked, [[3, 100]], 'when Vikunja allows 100 to a page, one page of 100 is requested');

  app.info = { max_items_per_page: 30 };
  v = list(3000, { max: 30 });
  part = await partOf('/tasks', 100, 100);
  assert.deepEqual(
    part.items.map(t => t.id),
    ids(200).slice(100),
    "when pages do not line up with the part, only the part's items are returned",
  );
  assert.deepEqual(
    v.asked.map(([p]) => p).sort((a, b) => a - b),
    [4, 5, 6, 7],
  );

  app.info = {};
  list(130);
  assert.deepEqual(
    (await partOf('/tasks', 100, 100)).items.map(t => t.id),
    ids(130).slice(100),
    'a part at the end of the list holds the items that remain',
  );
  list(130);
  assert.deepEqual(
    await partOf('/tasks', 200, 100),
    { items: [], total: 130 },
    'a part past the end of the list holds no items',
  );
});

/* A fake relay. It answers each request with the next of `answers`, as [status, body, headers], and the last one
   again once they run out. It records each request's address, Idempotency-Key and time (`sent`). */
function relay(...answers) {
  const sent = [];
  globalThis.fetch = async (url, { method = 'GET', headers = {} } = {}) => {
    sent.push({ url, method, key: headers['Idempotency-Key'], at: Date.now() });
    const [status, body = {}, more = {}] = answers[Math.min(sent.length, answers.length) - 1];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...more } });
  };
  return sent;
}
// Runs `p` on the test's clock, moving it on whenever nothing else is left to do, and returns how `p` settled.
async function onClock(t, p) {
  let done = false;
  const out = p
    .then(
      v => ({ v }),
      e => ({ e }),
    )
    .finally(() => {
      done = true;
    });
  while (!done) {
    for (let i = 0; i < 5; i++) await new Promise(ok => setImmediate(ok));
    if (!done) t.mock.timers.tick(500);
  }
  return out;
}
const KEY = '019a0000-0000-7000-8000-000000000000:0:0';

test('a write with a key goes through the relay with the key as an Idempotency-Key header, and a write without one goes to Vikunja as before', async () => {
  component();
  const sent = relay([201, { id: 5 }]);
  assert.deepEqual(await api('/projects/2/tasks', { method: 'POST', body: { title: 'Rope' }, key: KEY }), { id: 5 });
  await api('/tasks/5', { method: 'PATCH', body: { done: true } });
  assert.deepEqual(
    sent.map(s => [s.url, s.key]),
    [
      ['http://vikunja.test/api/v1/plugins/pocket/v2/projects/2/tasks', '"' + KEY + '"'],
      ['http://vikunja.test/api/v2/tasks/5', undefined],
    ],
  );
});

test('a write whose session has expired is sent again with the same key once the session is renewed', async () => {
  component();
  const sent = [];
  globalThis.fetch = async (url, { headers = {} } = {}) => {
    if (url.endsWith('/user/token/refresh')) return new Response(JSON.stringify({ token: 'tk_new' }), { status: 200 });
    sent.push([url, headers['Idempotency-Key'], headers.Authorization]);
    return new Response('{}', { status: sent.length === 1 ? 401 : 200 });
  };
  await api('/tasks/5', { method: 'POST', body: { done: true }, key: KEY });
  assert.deepEqual(
    sent.map(([url, key]) => [url, key]),
    Array(2).fill(['http://vikunja.test/api/v1/plugins/pocket/v2/tasks/5', '"' + KEY + '"']),
  );
  assert.equal(sent[1][2], 'Bearer tk_new');
});

test("a refusal gives Vikunja's detail, or else the relay's message, or else the status", async () => {
  component();
  relay([400, { detail: "Vikunja's reason", message: "the relay's reason" }]);
  await assert.rejects(api('/tasks/5', { method: 'POST', body: {}, key: KEY }), {
    status: 400,
    message: "Vikunja's reason",
  });
  relay([422, { message: 'this Idempotency-Key was used for a different request' }]);
  await assert.rejects(api('/tasks/5', { method: 'POST', body: {}, key: KEY }), {
    status: 422,
    message: 'this Idempotency-Key was used for a different request',
  });
  relay([500]);
  await assert.rejects(api('/tasks/5'), { status: 500, message: 'HTTP 500' });
});

test("a reply that isn't JSON, such as a sign-in proxy's page, leaves the change waiting instead of refusing it", async () => {
  const app = component();
  globalThis.fetch = async () =>
    new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const e = await api('/tasks/5', { method: 'POST', body: {}, key: KEY }).catch(e => e);
  assert.ok(passing(e), 'the outbox sends it again later');
  assert.equal(app.offline, true);
});

test('a 409 from the relay is sent again with the same key after Retry-After, and the answer that follows is returned', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  component();
  const sent = relay([409, { message: 'still running' }, { 'Retry-After': '1' }], [201, { id: 5 }]);
  const { v } = await onClock(t, api('/tasks/5', { method: 'POST', body: {}, key: KEY }));
  assert.deepEqual(v, { id: 5 });
  assert.deepEqual(
    sent.map(s => s.key),
    ['"' + KEY + '"', '"' + KEY + '"'],
  );
  assert.equal(sent[1].at - sent[0].at, 1000);
});

test('a 409 that lasts through three waits of 2 seconds leaves the change waiting to be sent later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  component();
  const sent = relay([409, { message: 'the first request with this Idempotency-Key is still running' }]);
  const { e } = await onClock(t, api('/tasks/5', { method: 'POST', body: {}, key: KEY }));
  assert.equal(sent.length, 4, 'sent once, then 3 times more');
  assert.deepEqual(
    sent.slice(1).map((s, i) => s.at - sent[i].at),
    [2000, 2000, 2000],
    'with no Retry-After, each wait is 2 seconds',
  );
  assert.equal(e.status, 409);
  assert.ok(passing(e), 'the outbox tries again later, as it does after a 503');
});

test('a 409 with Idempotency-Unknown is not sent again, and is not a reason to try later', async () => {
  component();
  const sent = relay([
    409,
    { message: 'the first request with this Idempotency-Key never finished' },
    { 'Idempotency-Unknown': 'true' },
  ]);
  const e = await api('/tasks/5', { method: 'POST', body: {}, key: KEY }).catch(e => e);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    [e.status, e.code, e.message],
    [409, 'unknown', 'the first request with this Idempotency-Key never finished'],
  );
  assert.ok(!passing(e));
});
test("a 409 that gives Vikunja's error code is Vikunja's refusal, not the relay waiting, and is not sent again", async () => {
  component();
  const sent = relay([409, { code: 4008, message: 'The task relation already exists.' }]);
  const e = await api('/tasks/5/relations', { method: 'POST', body: {}, key: KEY }).catch(e => e);
  assert.equal(sent.length, 1);
  assert.deepEqual([e.status, e.code], [409, 4008]);
  assert.ok(!passing(e));
});

/* Vikunja's rate limit answers 429 with Retry-After. Until then a keyed write fails at once, without reaching Vikunja,
   and the outbox keeps it. When the wait is over, the outbox is sent. */
test('after a 429, no keyed write reaches Vikunja until Retry-After has passed, and then the outbox is sent', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const app = component();
  let flushed = 0;
  app.flush = () => flushed++;
  const sent = relay([429, { message: 'Too Many Requests' }, { 'Retry-After': '60' }], [201, { id: 5 }]);
  const write = () => api('/tasks/5', { method: 'POST', body: {}, key: KEY }).catch(e => e);
  assert.ok(passing(await write()), 'the outbox keeps it');
  t.mock.timers.tick(59e3);
  const e = await write();
  assert.deepEqual([e.status, sent.length, flushed], [429, 1, 0], 'a write 59 seconds on is not sent');
  await api('/tasks?page=1');
  assert.equal(sent.length, 2, 'a read is still sent');
  t.mock.timers.tick(1e3);
  assert.equal(flushed, 1, 'the outbox is sent when the wait is over');
  assert.deepEqual(await write(), { id: 5 });
});

// The waiting message names this time, so it must be when the outbox really sends next.
test('the outbox next sends when a 429’s wait ends, or else at the next 30-second send', () => {
  const app = component(),
    now = Date.UTC(2026, 9, 21, 15, 40);
  assert.equal(nextTry(now), now + 30e3, 'before the first 30-second send is timed, 30 seconds on');
  app.nextFlush = now + 20e3;
  assert.equal(nextTry(now), now + 20e3);
  app.calmUntil = now + 90e3;
  assert.equal(nextTry(now), now + 90e3, 'the 30-second send before then sends no keyed write');
  app.calmUntil = now + 5e3;
  assert.equal(nextTry(now), now + 5e3, 'the end of the wait sends the outbox itself');
  assert.equal(nextTry(now + 10e3), now + 20e3, 'once the wait is over');
});

test('Retry-After may be an HTTP date, and a wait longer than 5 minutes, or one Pocket cannot read, is cut', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 21, 12) });
  const app = component();
  const write = () => api('/tasks/5', { method: 'POST', body: {}, key: KEY }).catch(e => e);
  const waits = async header => {
    app.calmUntil = 0;
    const sent = relay([429, {}, { 'Retry-After': header, Date: new Date().toUTCString() }], [201, { id: 5 }]);
    await write();
    let s = 0;
    while ((await write()).status === 429) {
      t.mock.timers.tick(1e3);
      s++;
    }
    assert.equal(sent.length, 2);
    return s;
  };
  assert.equal(await waits(new Date(Date.now() + 90e3).toUTCString()), 90, 'an HTTP date');
  assert.equal(await waits('86400'), 300, 'a day is cut to 5 minutes');
  assert.equal(await waits('soon'), 0, 'a value that is neither seconds nor a date gives no wait');
  assert.equal(await waits('-5'), 0, 'nor does a negative number');
});
