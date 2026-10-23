// The plugin's relay (pocket/relay.go), tested through Vikunja's API only. A write sent twice with one
// Idempotency-Key is made once, and Vikunja still checks permissions and sends events as for a direct request.
//
//   VIKUNJA_URL=https://tasks.example.com VIKUNJA_USER=... VIKUNJA_PASSWORD=... OTHER_USER=... OTHER_PASSWORD=...
//   ASSIGNEE_PROJECT="Team" node tests/relay.mjs
//   npm run test:local        (starts a local Vikunja with the plugin, and runs everything against it)
//
// The other user must share ASSIGNEE_PROJECT. Deletes the tasks and the project it makes.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const SERVER = (process.env.VIKUNJA_URL || '').replace(/\/+$/, '');
const {
  VIKUNJA_USER: USER,
  VIKUNJA_PASSWORD: PASSWORD,
  OTHER_USER: OTHER,
  OTHER_PASSWORD,
  ASSIGNEE_PROJECT: SHARED,
} = process.env;
if (!SERVER || !USER || !PASSWORD || !OTHER || !OTHER_PASSWORD || !SHARED) {
  console.error('Set VIKUNJA_URL, VIKUNJA_USER, VIKUNJA_PASSWORD, OTHER_USER, OTHER_PASSWORD and ASSIGNEE_PROJECT');
  process.exit(2);
}
const RELAY = SERVER + '/api/v1/plugins/pocket/v2';
// A UUIDv7: the first 48 bits are the time in milliseconds, so the relay can tell how old a key is.
const newKey = (ms = Date.now()) => {
  const b = crypto.getRandomValues(new Uint8Array(16)),
    t = BigInt(ms);
  for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail && !ok ? '  (' + detail + ')' : ''}`);
};

async function send(url, method, token, body, headers = {}) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }), ...headers },
    body: body && JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return {
    status: r.status,
    replayed: r.headers.get('idempotent-replayed') === 'true',
    unknown: r.headers.get('idempotency-unknown') === 'true',
    json,
    text,
  };
}
// fetch resolves ".." and "%2e%2e" in a URL before it sends it, as a browser does. This sends the path as written.
const rawPost = (path, token, body, key) =>
  new Promise((ok, no) => {
    const url = new URL(RELAY + path);
    const r = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        host: url.hostname,
        port: url.port,
        method: 'POST',
        path: new URL(RELAY).pathname + path,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'Idempotency-Key': `"${key}"`,
        },
      },
      res => {
        res.resume();
        res.on('end', () => ok(res.statusCode));
      },
    );
    r.on('error', no);
    r.end(JSON.stringify(body));
  });
const v2 = (method, path, token, body) => send(SERVER + '/api/v2' + path, method, token, body);
const relay = (method, path, token, body, key) =>
  send(RELAY + path, method, token, body, key ? { 'Idempotency-Key': `"${key}"` } : {});
const list = j => (Array.isArray(j) ? j : j?.items || []);
const login = async (username, password) => (await v2('POST', '/login', null, { username, password })).json?.token;
const titled = async (token, title) =>
  list((await v2('GET', '/tasks?q=' + encodeURIComponent(title), token)).json).filter(t => t.title === title);
const brief = r =>
  `status ${r.status}${r.replayed ? ', replayed' : ''}${r.status >= 400 ? ': ' + r.text.slice(0, 160) : ''}`;

const me = await login(USER, PASSWORD),
  other = await login(OTHER, OTHER_PASSWORD);
if (!me || !other) {
  console.error(`Could not sign in as ${USER} and ${OTHER}`);
  process.exit(2);
}
const team = list((await v2('GET', '/projects', me)).json).find(p => p.title === SHARED);
if (!team) {
  console.error(`No project called ${SHARED}`);
  process.exit(2);
}
const run = newKey().slice(-8),
  made = [];
const keep = r => {
  if (r.json?.id) made.push(r.json.id);
  return r;
};

try {
  const k1 = newKey(),
    title1 = `Relay ${run}`,
    body1 = { title: title1, description: `<p>For <mention-user data-id="${OTHER}"></mention-user></p>` };
  const first = keep(await relay('POST', `/projects/${team.id}/tasks`, me, body1, k1));
  check('a relayed create makes a task', first.status === 201 && !!first.json?.id, brief(first));
  if (!first.json?.id) throw new Error("the route, the table or the forward failed. Check Vikunja's log");

  const again = await relay('POST', `/projects/${team.id}/tasks`, me, body1, k1);
  check(
    'the same key gets the stored answer',
    again.status === first.status && again.replayed && again.json?.id === first.json.id,
    brief(again),
  );
  check('the same key makes no second task', (await titled(me, title1)).length === 1);

  // Five at once with one key: one makes the task, and the others are told to wait (409) or get its answer. On SQLite,
  // Vikunja now and then answers 500 "database is locked" while the relay writes, and the relay passes that on. Pocket
  // sends such a request again with its key, and so does each of the five.
  const k2 = newKey(),
    title2 = `Relay race ${run}`;
  const busyAgain = async () => {
    for (let i = 0; ; i++) {
      const r = await relay('POST', `/projects/${team.id}/tasks`, me, { title: title2 }, k2);
      if (r.status < 500 || i >= 4) return r;
      await new Promise(ok => setTimeout(ok, 300 * (i + 1)));
    }
  };
  const race = await Promise.all(Array.from({ length: 5 }, busyAgain));
  race.forEach(keep);
  check(
    'five requests at once with one key make one task',
    (await titled(me, title2)).length === 1,
    race.map(r => r.status).join(' '),
  );
  check(
    'each of the five is answered or told to wait',
    race.every(r => r.status === 201 || r.status === 409),
    race.map(r => r.status).join(' '),
  );

  const reused = await relay('POST', `/projects/${team.id}/tasks`, me, { title: title1 + ' changed' }, k1);
  check('a key reused for a different body gets 422', reused.status === 422, brief(reused));
  const keyless = await relay('POST', `/projects/${team.id}/tasks`, me, { title: `Relay no key ${run}` });
  check('a request without a key gets 400', keyless.status === 400, brief(keyless));

  // Vikunja's permission check still applies, and its refusal is stored like any answer.
  const theirs = (await v2('POST', '/projects', other, { title: `Relay other's ${run}` })).json;
  try {
    const k3 = newKey(),
      title3 = `Relay forbidden ${run}`;
    const no = await relay('POST', `/projects/${theirs.id}/tasks`, me, { title: title3 }, k3);
    check("a project the user can't write to is refused", no.status === 403, brief(no));
    const noAgain = await relay('POST', `/projects/${theirs.id}/tasks`, me, { title: title3 }, k3);
    check('the refusal is replayed, not sent again', noAgain.status === 403 && noAgain.replayed, brief(noAgain));
    check('the refused create made no task', (await titled(other, title3)).length === 0);
  } finally {
    await v2('DELETE', '/projects/' + theirs.id, other);
  }

  // Events: the mention in the first task's notes notifies the other user.
  let told = false;
  for (let i = 0; i < 20 && !told; i++) {
    const n = await v2('GET', '/notifications', other);
    told = n.text.includes(String(first.json.id)) || n.text.includes(title1);
    if (!told) await new Promise(r => setTimeout(r, 500));
  }
  check('events fire: a mention notifies the user mentioned', told);

  // Ticking a repeating task twice with one key moves its date on once.
  const due = new Date(Date.now() + 864e5);
  due.setSeconds(0, 0);
  const rep = keep(
    await relay(
      'POST',
      `/projects/${team.id}/tasks`,
      me,
      { title: `Relay repeats ${run}`, due_date: due.toISOString(), repeat_after: 86400 },
      newKey(),
    ),
  );
  const k4 = newKey();
  await relay('PATCH', `/tasks/${rep.json.id}`, me, { done: true }, k4);
  const tick2 = await relay('PATCH', `/tasks/${rep.json.id}`, me, { done: true }, k4);
  const days = Math.round(
    (Date.parse((await v2('GET', `/tasks/${rep.json.id}`, me)).json?.due_date) - due.getTime()) / 864e5,
  );
  check(
    'a repeating task ticked twice with one key moves on one day',
    days === 1 && tick2.replayed,
    `moved ${days} day(s)`,
  );

  // Vikunja's 401 after the relay's own check isn't kept, as when a session ends between the two. A token allowed the
  // relay but not task creation gets that 401 every time.
  const scoped = (
    await v2('POST', '/tokens', me, {
      title: `Relay only ${run}`,
      permissions: { plugins: ['pocket_v2_*'] },
      expires_at: new Date(Date.now() + 36e5).toISOString(),
    })
  ).json;
  try {
    const k6 = newKey(),
      title6 = `Relay 401 ${run}`;
    const no = await relay('POST', `/projects/${team.id}/tasks`, scoped?.token, { title: title6 }, k6);
    check("Vikunja's 401 after the relay's check is passed on", no.status === 401 && !no.replayed, brief(no));
    const yes = keep(await relay('POST', `/projects/${team.id}/tasks`, me, { title: title6 }, k6));
    check(
      "the 401 isn't kept, so the same key makes the task once the user is signed in",
      yes.status === 201 && !yes.replayed,
      brief(yes),
    );
  } finally {
    if (scoped?.id) await v2('DELETE', '/tokens/' + scoped.id, me);
  }

  // A forward that never reaches Vikunja releases its key. Echo decodes %25 in the path to %, so the relay builds a
  // URL Go can't parse and gives up before it connects. A forward that reaches Vikunja and loses its answer keeps its
  // key, but the API can't make an answer get lost.
  const k7 = newKey(),
    bad = await relay('PATCH', `/tasks/${first.json.id}%25zz`, me, { done: true }, k7);
  const badAgain = await relay('PATCH', `/tasks/${first.json.id}%25zz`, me, { done: true }, k7);
  check(
    'a forward that never reaches Vikunja gets 502, and the same key can be sent again',
    bad.status === 502 && badAgain.status === 502,
    `${brief(bad)}; then ${brief(badAgain)}`,
  );

  // An answer over 64 KB is stored and replayed. MySQL's TEXT would cut it off (relay.go uses LONGTEXT there).
  const k5 = newKey(),
    big = { title: `Relay big ${run}`, description: '<p>' + 'x'.repeat(100e3) + '</p>' };
  const large = keep(await relay('POST', `/projects/${team.id}/tasks`, me, big, k5)),
    largeAgain = await relay('POST', `/projects/${team.id}/tasks`, me, big, k5);
  check(
    'an answer over 64 KB is stored and replayed whole',
    large.status === 201 && largeAgain.replayed && largeAgain.text === large.text,
    brief(largeAgain),
  );

  // A key older than the relay keeps answers, or from a clock a day fast, isn't run.
  const title8 = `Relay old key ${run}`;
  const old = keep(
    await relay('POST', `/projects/${team.id}/tasks`, me, { title: title8 }, newKey(Date.now() - 31 * 864e5)),
  );
  check('a key older than 30 days gets 409 with Idempotency-Unknown', old.status === 409 && old.unknown, brief(old));
  const ahead = keep(
    await relay('POST', `/projects/${team.id}/tasks`, me, { title: title8 }, newKey(Date.now() + 2 * 864e5)),
  );
  check(
    'a key from 2 days ahead gets 409 with Idempotency-Unknown',
    ahead.status === 409 && ahead.unknown,
    brief(ahead),
  );
  check('neither made a task', (await titled(me, title8)).length === 0);
  const v4 = keep(await relay('POST', `/projects/${team.id}/tasks`, me, { title: title8 }, crypto.randomUUID()));
  check("a key that isn't a UUIDv7 gets 400", v4.status === 400, brief(v4));
  // A write reaches only /api/v2. Echo decodes %2e%2e and %2f before the relay sees the path.
  const title9 = `Relay dots ${run}`,
    dots = [];
  for (const p of ['..', '%2e%2e', '%2E%2e', 'x%2f..%2fx'])
    dots.push(await rawPost(`/projects/0/${p}/${team.id}/tasks`, me, { title: title9 }, newKey()));
  check(
    'a path with a .. segment gets 400',
    dots.every(s => s === 400),
    dots.join(' '),
  );
  check('a path with a .. segment makes no task', (await titled(me, title9)).length === 0);
  // A key with a byte that isn't UTF-8 makes MySQL refuse the INSERT, though the SELECT after it works. That stands
  // for any database error while the relay claims a key. The phone sends a 500 again a few times. A 409 would tell it
  // to wait for good. SQLite stores the key, and the task is made.
  const unstored = keep(
    await relay('POST', `/projects/${team.id}/tasks`, me, { title: `Relay bad key ${run}` }, newKey() + ':\xff'),
  );
  check(
    "a key the database can't store gets 500, not 409",
    unstored.status === 500 || unstored.status === 201,
    brief(unstored),
  );
  const staged = keep(
    await relay('POST', `/projects/${team.id}/tasks`, me, { title: `Relay staged ${run}` }, newKey() + ':2:1'),
  );
  check('a key with a stage and part after its UUID is read by that UUID', staged.status === 201, brief(staged));
} finally {
  for (const id of new Set(made)) await v2('DELETE', '/tasks/' + id, me);
}
console.log(failed ? `\n${failed} relay checks failed.` : '\nAll relay checks passed.');
process.exit(failed ? 1 : 0);
