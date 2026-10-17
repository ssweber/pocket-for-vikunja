/* Every op in OPS goes through the same lifecycle and passes the same checks. Each op is queued and brought to each
   state an outbox entry can be in (STATES). The user then does each thing that state allows (ACTIONS), the connection
   comes back, and every open tab sends what is waiting. RULES are checked after each. Each op gives a sample in
   SAMPLES, and an op without one fails its test.

   Each tab is its own copy of the app's modules, as a browser tab is. The tabs share the fake Vikunja, the outbox's
   database, the outbox's lock and the messages between tabs. */
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './browser.mjs';

// The outbox's database in memory, as much of IndexedDB as sync.js uses. A value is copied as it is stored and as it
// is read, as IndexedDB copies it, so no tab holds the database's own object.
const stores = new Map();
class Request { result = undefined; onsuccess = null; }
globalThis.IDBRequest = Request;
const database = {
  objectStoreNames: { contains: name => stores.has(name) },
  createObjectStore(name){ stores.set(name, new Map()); },
  deleteObjectStore(name){ stores.delete(name); },
  transaction(){
    const t = { abort(){ t.aborted = true; } };
    let open = 0;
    const done = () => { if (!open && !t.aborted) t.oncomplete?.(); };
    const request = run => {
      const r = new Request();
      open++;
      queueMicrotask(() => { if (!t.aborted) { r.result = run(); r.onsuccess?.({ target: r }); } open--; done(); });
      return r;
    };
    t.objectStore = name => {
      const s = stores.get(name);
      return { put: (v, k = v.id) => request(() => { s.set(k, structuredClone(v)); }), get: k => request(() => structuredClone(s.get(k))),
        getAll: () => request(() => [...s.values()].map(v => structuredClone(v))), delete: k => request(() => { s.delete(k); }) };
    };
    queueMicrotask(done);                                                   // a transaction with no requests
    return t;
  },
};
globalThis.indexedDB = { open(){ const r = new Request(); queueMicrotask(() => { r.result = database; if (!stores.size) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
// The tabs tell each other that the outbox changed, as a BroadcastChannel does.
const channels = [];
globalThis.BroadcastChannel = self.BroadcastChannel = class { constructor(){ this.heard = []; channels.push(this); } addEventListener(type, fn){ this.heard.push(fn); }
  postMessage(){ for (const c of channels) if (c !== this) for (const fn of c.heard) setImmediate(fn); } };

// A module imported with ?tab=<name> imports the app's modules with it too, so each tab gets its own copy of them.
registerHooks({ resolve(specifier, context, next){
  const r = next(specifier, context), tab = context.parentURL && new URL(context.parentURL).searchParams.get('tab');
  return tab && r.url.includes('/src/js/') && !r.url.includes('?') ? { ...r, url: `${r.url}?tab=${tab}` } : r;
} });
const tab = async name => {
  const from = path => import(new URL(`${path}?tab=${name}`, import.meta.url));
  const [fake, tasks, acts, sending, outbox, runs, sync, ops] = await Promise.all(['./fake.mjs',
    ...['app/tasks', 'app/acts', 'app/sending', 'app/outbox', 'app/runs', 'sync', 'ops/index'].map(p => `../../src/js/${p}.js`)].map(from));
  return { fake, tasks, sync: sync.sync, uuid7: sync.uuid7, ops, parts: [tasks, acts, sending, outbox, runs].map(m => m.default) };
};
const A = await tab('a'), B = await tab('b');
const { OPS, opOf, refusalOf, addLines } = A.ops;

const ME = { id: 1, username: 'me', name: '' }, ZERO = '0001-01-01T00:00:00Z', D9 = '2026-10-09T09:00:00.000Z';
const task = (id, title, more = {}) => ({ id, title, project_id: 5, done: false, percent_done: 0, due_date: ZERO, repeat_after: 0, repeat_mode: 0, position: 100,
  assignees: [], labels: [], reactions: {}, comments: [], ...more });
// A checklist, 1, with two steps, 2 and 3. `more` changes a task, by id.
const checklist = (more = {}) => [task(1, 'Closing', { related_tasks: { subtask: [{ id: 2 }, { id: 3 }] } }), task(2, 'Mop the floor'), task(3, 'Lock up')]
  .map(t => ({ ...t, ...t.id > 1 && { related_tasks: { parenttask: [{ id: 1 }] } }, ...more[t.id] }));
const line = (title, p) => ({ raw: title, p: { title, due: null, priority: 0, repeat: null, labels: [], assignees: [], project: null, remind: false, done: false, pct: 0, ...p }, under: null });

/* What each op is tried with: the tasks Vikunja has before (`tasks`), the fields it is queued with (`fields`), and what
   Vikunja has once it is made (`made`). The fake Vikunja answers each request as Vikunja does. `cannot` names the
   states that can't arise for the op: an op whose requests are all in one stage is never partly done. `unseen` names
   the fields Vikunja changes that the task's row doesn't show. Keep each sample small. Unit tests have no DOM, so a
   comment holds no HTML. */
const SAMPLES = {
  done: { tasks: checklist(), fields: { op: 'done', task: 2, run: 1 }, made: v => v.task(2).done && v.task(1).percent_done === 0.5 },
  undone: { tasks: checklist({ 1: { percent_done: 0.5 }, 2: { done: true, reactions: { '✅': [ME] } } }), fields: { op: 'undone', task: 2, run: 1 },
    made: v => !v.task(2).done && !v.task(2).reactions['✅'].length && v.task(1).percent_done === 0 },
  skip: { tasks: checklist(), fields: { op: 'skip', task: 2, run: 1, html: '' }, made: v => v.task(2).done && v.task(2).reactions['⏭️'].length === 1 && v.task(2).comments.length === 1 },
  doneNote: { tasks: checklist(), fields: { op: 'doneNote', task: 2, run: 1, html: '' }, made: v => v.task(2).done && v.task(2).comments.length === 1 },
  note: { tasks: checklist(), fields: { op: 'note', task: 2, run: null, html: '' }, made: v => v.task(2).comments.length === 1, cannot: ['partly done'] },
  answer: { tasks: checklist(), fields: { op: 'answer', task: 2, run: 1, html: '' }, made: v => v.task(2).comments.length === 1, cannot: ['partly done'] },
  finish: { tasks: checklist(), fields: { op: 'finish', task: 1, run: 1 }, made: v => v.task(1).done && v.task(1).reactions['✅'].length === 1 },
  reopen: { tasks: checklist({ 1: { done: true, reactions: { '✅': [ME] } } }), fields: { op: 'reopen', task: 1, run: 1 }, made: v => !v.task(1).done },
  progress: { tasks: checklist(), fields: { op: 'progress', task: 2, run: 1, pct: 40 }, made: v => v.task(2).percent_done === 0.4 && v.task(1).percent_done === 0.2 },
  claim: { tasks: checklist(), fields: { op: 'claim', task: 2, run: null }, made: v => v.task(2).assignees.length === 1, cannot: ['partly done'] },
  unclaim: { tasks: checklist({ 2: { assignees: [ME] } }), fields: { op: 'unclaim', task: 2, run: null }, made: v => !v.task(2).assignees.length, cannot: ['partly done'] },
  delete: { tasks: checklist({ 1: { percent_done: 0.5 }, 2: { done: true } }), fields: { op: 'delete', task: 3, ids: [3], up: 1, run: null },
    made: v => !v.task(3) && v.task(1).percent_done === 1 },
  // A list's order is kept by view in `positions`, not on the task's row (`unseen`).
  position: { tasks: checklist(), fields: { op: 'position', task: 2, view: 5, pos: 300, run: null }, made: v => v.task(2).position === 300, cannot: ['partly done'],
    unseen: ['position'] },
  // A line typed in the checklist's subtask box, done.
  add: { tasks: checklist(), fields: () => addLines([line('Buy rope', { done: true })], { parent: { id: 1, project_id: 5, title: 'Closing' } })[0],
    made: v => v.task(101).done && v.task(1).related_tasks.subtask.length === 3 && v.task(1).percent_done === 0.33 },
  // A template's date taken off: its repeat off, its date off and done, and its repeat back.
  due: { tasks: [task(7, 'TEMPLATE: Closing', { due_date: D9, repeat_after: 86400 })], fields: { op: 'due', task: 7, tpl: true, was: D9, due: ZERO, done: true, run: null },
    made: v => v.task(7).done && v.task(7).due_date === ZERO && v.task(7).repeat_after === 86400 },
  repeat: { tasks: [task(7, 'Water the plants', { due_date: D9 })], fields: { op: 'repeat', task: 7, set: { repeat_after: 604800, repeat_mode: 0 }, was: { repeat_after: 0, repeat_mode: 0 }, run: null },
    made: v => v.task(7).repeat_after === 604800, cannot: ['partly done'] },
};

const deferred = () => { let resolve; return Object.assign(new Promise(ok => { resolve = ok; }), { resolve: v => resolve(v) }); };
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise(ok => setImmediate(ok)); };
const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/* What becomes of the request a state picks (x.one). Vikunja refuses it, and the relay keeps the refusal. The relay
   can't say whether Vikunja made it (unknown), though Vikunja did (arrived). The connection drops as it is sent (cut)
   and stays down. Or it waits until finish lets it go (held), and arrives, or arrives with its reply lost. */
const unknown = () => reply(409, { message: 'the first request with this Idempotency-Key never finished' }, { 'Idempotency-Unknown': 'true' });
const TROUBLE = {
  refused: () => reply(403, { message: 'Forbidden' }),
  unknown,
  async arrived(send){ await send(); return unknown(); },
  cut(send, x){ x.down = true; throw new TypeError('Failed to fetch'); },
  async held(send, x){
    x.held.resolve();
    if (await x.released === 'lost') { await send(); throw new TypeError('network error'); }
    return send();
  },
};

/* Open `tab` on the outbox as the database has it, with nothing in memory, as a tab opens or reloads. Its rows come
   from Vikunja, as a screen reads them. */
async function open(tab, x){
  const s = tab.sync;
  s.entries = new Map(); s.volatile.clear(); s.bytes.clear(); s.held.clear(); s.claimed.clear();
  await s.reload();
  for (const c of await s.tx(['claims'], 'readonly', st => st('claims').getAll())) s.claimed.set(c.id, c);
  const app = tab.fake.component(...tab.parts);
  Object.assign(app, { user: ME, pending: [], failed: [], slow: [], flushing: false, cap: { text: '' }, capPhotos: [], sheet: { id: null, sub: { text: '' } },
    view: { groups: [], shownRun: null }, places: {}, endPlace(){}, aimSent(){}, aimCancelled(){}, positionSent(){} });
  Object.defineProperty(app, 'toast', { value: {} });
  // A read lists only the subtasks that still exist, as Vikunja's does.
  const list = [...x.v.tasks.values()].map(t => structuredClone({ ...t, ...t.related_tasks && { related_tasks: Object.fromEntries(Object.entries(t.related_tasks)
    .map(([kind, ts]) => [kind, ts.filter(s => x.v.tasks.has(s.id))])) } }));
  app.change(w => w.read(list, tab.tasks.TASK_REACTIONS_COMMENTS, tab.tasks.started()));
  for (const t of list) app.row(t);
  app.refreshPending();
  x.tabs.push(app);
  return app;
}

/* A scenario's world: the fake Vikunja with the sample's tasks, an empty outbox, and tab A open (x.app). Every request
   fails while the connection is down (x.down). The first write whose key x.one picks gets the TROUBLE x.one names, and
   the relay answers that key the same way from then on. */
async function world(sample){
  for (const s of stores.values()) s.clear();
  const v = A.fake.fakeVikunja(sample.tasks.map(t => structuredClone(t))), send = globalThis.fetch, stuck = new Map();
  const x = { v, sample, tabs: [], later: [], down: false, one: null, before: vikunja(v) };
  globalThis.fetch = async (url, opts = {}) => {
    const key = opts.headers?.['Idempotency-Key']?.replaceAll('"', ''), what = key && x.one?.(key);
    if (x.down) throw new TypeError('Failed to fetch');
    if (stuck.has(key)) return stuck.get(key)();
    if (!what) return send(url, opts);
    x.one = null;
    if (['refused', 'unknown', 'arrived'].includes(what)) stuck.set(key, TROUBLE[what === 'arrived' ? 'unknown' : what]);
    return TROUBLE[what](() => send(url, opts), x);
  };
  const fields = typeof sample.fields === 'function' ? sample.fields() : sample.fields;
  x.fields = { id: A.uuid7(), ...fields };
  x.queue = () => x.app.actAll([x.fields]);
  x.app = await open(A, x);
  return x;
}
// Pick the first write sent in stage `at` (any stage when null) for `what`.
const first = (what, at = null) => key => (at === null || key.split(':')[1] === String(at)) && what;

/* The connection comes back, and every open tab sends what is waiting, at the same time, until nothing more is sent.
   `end` is what Vikunja has then. */
async function finish(x){
  x.down = false; x.one = null;
  x.released?.resolve('answered');
  await x.sending; await Promise.all(x.later);
  for (let round = 0; round < 3; round++) {
    const open = [x.app, x.other].filter(Boolean);
    for (const app of open) app.offline = false;
    await Promise.all(open.map(app => app.flush()));
    await settle();
  }
  x.end = vikunja(x.v);
  x.answered = !x.cancelled && !x.givenBack && !outbox().some(e => e.failed);
}

/* The states an op can be in when the user acts. Each sample's partly done states are made from the stages its
   requests are sent in (statesOf). `not` names the actions the user wouldn't take there. */
const troubled = (what, at) => async x => { x.one = first(what, at); await x.queue(); x.one = null; };
const STATES = [
  { name: 'unsent', async reach(x){ x.down = true; x.app.offline = true; await x.queue(); } },
  { name: 'sending', async reach(x){ x.held = deferred(); x.released = deferred(); x.one = first('held'); x.sending = x.queue(); await x.held; } },
  { name: 'answered', reach: x => x.queue() },
  { name: 'refused', reach: troubled('refused') },
  { name: 'unknown', reach: troubled('unknown') },
  // The user checks Vikunja, finds the change there, and doesn't tap Try again.
  { name: 'unknown, but made', reach: troubled('arrived'), not: ['Try again'] },
];
// A stage after the first that sends a request. Vikunja refuses that request, or the connection drops as it is sent.
const partly = at => [{ name: `partly done, refused at stage ${at}`, reach: troubled('refused', at) },
  { name: `partly done, cut off at stage ${at}`, reach: troubled('cut', at) }];
const statesOf = (sample, stages) => [...STATES, ...sample.cannot?.includes('partly done') ? [] : stages.slice(1).flatMap(partly)];

// The Outbox's row for the op, which offers Cancel (`drop`) and Try again (`retry`) when the state allows them.
const row = x => { x.app.refreshPending(); return x.app.outboxRows.find(r => r.key === x.fields.id); };
const cancel = async x => {
  const [how, ...args] = row(x).drop;
  await x.app[how](...args);
  if (/^Cancelled\./.test(x.app.toasts.at(-1)?.msg)) x.cancelled = vikunja(x.v);
};
/* What the user does in a state, when `can` says the state offers it. `run` returns false when what it needs isn't
   there after all. */
const ACTIONS = [
  { name: 'nothing', run(){} },
  { name: 'Undo', can: x => !!opOf(x.fields).invert, run(x){ x.later.push(x.app.undoOps([x.fields]).left.then(n => { x.undone = n; })); } },
  { name: 'Cancel', can: x => !!row(x)?.drop, run: cancel },
  { name: 'Cancel, then its Undo', can: x => !!row(x)?.drop, async run(x){
    await cancel(x);
    const undo = x.app.toasts.at(-1)?.action;
    if (undo?.label !== 'Undo') return false;
    x.cancelled = null;
    await undo.fn();
  } },
  { name: 'Try again', can: x => !!row(x)?.retry, run: x => x.app.retryAct(x.fields.id) },
  // A reload while a request is on its way loses its reply, though Vikunja gets it.
  { name: 'a reload', async run(x){ x.released?.resolve('lost'); await x.sending; x.app = await open(A, x); } },
  { name: 'a second tab', async run(x){ x.other = await open(B, x); } },
];

/* Vikunja's tasks by id, with only what a change can differ in: no times Vikunja sets itself, and the people,
   reactions, comments and related tasks as their ids or text. A row is compared the same way (shape). */
const shape = (t, exists = () => true) => t && Object.fromEntries(Object.entries(t).filter(([k]) => !['updated', 'created', 'created_by', 'done_at'].includes(k)).map(([k, v]) => [k,
  k === 'comments' ? (v || []).map(c => c.comment) : k === 'assignees' || k === 'labels' ? (v || []).map(u => u.id)
    : k === 'reactions' ? Object.fromEntries(Object.entries(v || {}).filter(([, us]) => us.length).map(([m, us]) => [m, us.map(u => u.id)]))
      : k === 'related_tasks' ? Object.fromEntries(Object.entries(v || {}).map(([kind, list]) => [kind, (list || []).map(s => s.id).filter(exists)])) : v]));
const vikunja = v => Object.fromEntries([...v.tasks].map(([id, t]) => [id, shape(t, id => v.tasks.has(id))]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(id => !same(a[id], b[id])).map(id => `${id}: ${JSON.stringify(b[id])}`).join('; ');
const outbox = () => [...stores.get('outbox').values()];
// The fields of task `id` that the op changes, from the sample's run with nothing in the way.
const changes = (x, id) => !x.ref.made[id] ? null : Object.keys(x.ref.made[id]).filter(k => !same(x.ref.made[id][k], x.before[id]?.[k]));
const PROBLEM = /couldn't|may not have|refused|Not sent|Not undone/;

/* The rules every scenario keeps. Each returns what broke it, or nothing. */
const RULES = [
  ['each request reaches Vikunja at most once for each key', x => {
    const n = new Map();
    for (const r of x.v.requests) if (r.key && !r.replayed) n.set(r.key, (n.get(r.key) || 0) + 1);
    return [...n].filter(([, k]) => k > 1).map(([key]) => `sent twice: ${key}`).join('; ');
  }],
  ['a change the user didn\'t take back is made exactly once, or waits in the Outbox', x => {
    if (x.cancelled || x.undone !== undefined || x.givenBack || same(x.end, x.ref.made) || outbox().some(e => e.failed)) return;
    return `Vikunja has ${diff(x.ref.made, x.end) || 'it'}, not what the op makes, and the Outbox has ${outbox().length} entries`;
  }],
  ['Cancel sends nothing more', x => x.cancelled && !same(x.end, x.cancelled) && `Vikunja has ${diff(x.cancelled, x.end)}`],
  ['Undo puts back what the op changed', x => x.undone !== undefined && (x.undone || !same(x.end, x.before)) && `${x.undone} left alone, and Vikunja has ${diff(x.before, x.end) || 'what it had'}`],
  ['each row is Vikunja\'s copy with the waiting ops', x => {
    const out = [], open = [x.app, x.other].filter(Boolean);
    for (const app of open) for (const id of Object.keys(x.before).map(Number)) {
      const waiting = outbox().filter(e => e.kind === 'act' && !e.failed && !(e.until > Date.now()) && opOf(e).on(e).includes(id)).map(e => e.id), r = app.tasks[id];
      if (!same(app.opsOf(id).map(e => e.id), waiting)) out.push(`${id} shows ${app.opsOf(id).length} ops, and ${waiting.length} wait`);
      if (r && !same(shape(r), { ...shape(r), ...shape(app.shownAs(id)) })) out.push(`${id}'s row is not its copy with its ops`);
      /* Only the tab that sent the op has Vikunja's answer to every request. Another tab, and a tab whose op Vikunja
         refused partway or may not have, reads Vikunja's copy later. */
      if (x.other || waiting.length || !x.answered) continue;
      const ks = changes(x, id)?.filter(k => !x.sample.unseen?.includes(k));
      if (!x.end[id] && r) out.push(`${id} is deleted, and its row stays`);
      else if (r && ks) for (const k of ks.filter(k => !same(shape(r)[k], x.end[id][k]))) out.push(`${id}'s row has ${k} ${JSON.stringify(shape(r)[k])}, and Vikunja ${JSON.stringify(x.end[id][k])}`);
    }
    return out.join('; ');
  }],
  ['a message about a problem offers a way forward, unless nothing is left to do', x => {
    if (!outbox().some(e => e.failed)) return;
    const bad = x.tabs.flatMap(app => app.toasts).filter(m => (m.cls === 'failed' || PROBLEM.test(m.msg)) && !['Outbox', 'Try again', 'Undo'].includes(m.action?.label));
    return bad.map(m => `“${m.msg}”`).join('; ');
  }],
  ['nothing stays in the Outbox without being marked failed', x => outbox().filter(e => !e.failed && !(e.until > Date.now())).map(e => `${e.op || 'files'} at stage ${e.stage}`).join('; ')],
];

/* The sample's op sent with nothing in the way: what Vikunja has then (`made`), and the stages that sent a request. */
async function reference(sample){
  const x = await world(sample);
  await x.queue(); await finish(x);
  assert.ok(sample.made(x.v), `the sample makes its change: ${diff(x.before, x.end)}`);
  assert.deepEqual(outbox(), [], 'the outbox is empty once it is sent');
  return { made: x.end, stages: [...new Set(x.v.requests.filter(r => r.key).map(r => +r.key.split(':')[1]))] };
}

test('every op in OPS has a sample', () => {
  assert.deepEqual(Object.keys(OPS).filter(name => !SAMPLES[name]), [], 'a new op needs a sample in SAMPLES');
});

/* Bugs this test found whose fix would change what the user sees or need new words, listed until that is decided. A
   scenario here may break the rules, and t.diagnostic names it. An entry that no scenario breaks any more fails the
   test, so it is removed once the bug is fixed. */
const KNOWN = [];

for (const name of Object.keys(OPS)) test(`${name} passes the lifecycle checks`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sample = SAMPLES[name];
  assert.ok(sample, `${name} has no sample in SAMPLES`);
  const ref = await reference(sample), several = ref.stages.length > 1;
  assert.equal(!sample.cannot?.includes('partly done'), several,
    several ? `${name} sends requests in several stages, so it can be partly done` : `${name} sends its requests in one stage, so its sample says it can't be partly done`);
  const failures = [], known = KNOWN.filter(k => k.op === name), seen = new Set();
  for (const state of statesOf(sample, ref.stages)) for (const action of ACTIONS) {
    if (state.not?.includes(action.name)) continue;
    const x = await world(sample);
    x.ref = ref;
    await state.reach(x);
    x.givenBack = state.name === 'refused' && refusalOf(x.fields) !== 'kept';
    if (action.can && !action.can(x) || await action.run(x) === false) { await finish(x); continue; }
    await finish(x);
    const broken = RULES.map(([rule, check]) => [rule, check(x)]).filter(([, broke]) => broke).map(([rule, broke]) => `${state.name}, then ${action.name}: ${rule}. ${broke}`);
    const k = broken.length && known.find(k => k.state.test(state.name) && (!k.action || k.action === action.name));
    if (k) { seen.add(k); t.diagnostic(`known: ${broken.join(' ')} (${k.why})`); } else failures.push(...broken);
  }
  for (const k of known) if (!seen.has(k)) failures.push(`no scenario breaks a rule any more for the KNOWN bug "${k.why}". Remove it from KNOWN.`);
  assert.deepEqual(failures, []);
});
