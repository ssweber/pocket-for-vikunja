/* A randomized test of the store (src/js/app/tasks.js). fast-check generates sequences of commands on a few tasks: ops
   queued, sent, answered, lost, undone and dropped, reads started and finished late, direct saves, rows marked as
   leaving, and a teammate's changes in the web app. Each command acts on the app and on a simple model, and the checks
   after each command compare them. A failure prints the seed and the shortest sequence that breaks a check.

   The model learns what the store is asked to do by watching the writers that change() hands out (read, answer,
   edit, leave, keyOps and the rest), and keeps its own copy of each task from them. It works out each row from that
   copy, the ops waiting in the outbox and the edits still running, with each op's `apply`, and never from the store's
   own functions. The app sends through its own sender. The fake Vikunja holds each write's reply until a command
   lets it arrive, lose it or answer it as unknown.

   CI=1 fixes the seed. FC_RUNS sets the number of sequences, and FC_SEED a seed to run again. */
import './browser.mjs';
import { stores, used } from './outbox-db.mjs';
import { test } from 'node:test';
import fc from 'fast-check';
import { component, fakeVikunja } from './fake.mjs';
import tasks, { copyOf, putting, started, TASK, TASK_REACTIONS_COMMENTS } from '../../src/js/app/tasks.js';
import acts from '../../src/js/app/acts.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import actions from '../../src/js/app/actions.js';
import leaving from '../../src/js/app/leaving.js';
import { held, sync, uuid7 } from '../../src/js/sync.js';
import * as ops from '../../src/js/ops/index.js';
import { checklist, ME, SAMPLES } from './samples.mjs';

const { OPS, opOf } = ops;
const RUNS = +process.env.FC_RUNS || 1000,
  START = Date.parse('2026-10-17T09:00:00Z'),
  SERVER = 'http://vikunja.test/api/v2';
// The step still being added to checklist 1, by its outbox entry. Commands name it 'step' (target).
const STEP = 'step';
// The fields the copy of a task is compared on with Vikunja's: every field Pocket reads, except the times Vikunja
// sets itself.
const CHECKED = TASK_REACTIONS_COMMENTS.filter(k => !['updated', 'created', 'created_by', 'done_at'].includes(k));
const clone = v => (v === undefined ? v : structuredClone(v));
// JSON with each object's keys sorted, so two values compare by content whatever order their keys were written in.
const canon = v =>
  JSON.stringify(v, (k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
const tick = () => new Promise(ok => setImmediate(ok));
// Pocket sends a change not yet sent only while the browser says it is online, which is only during Send.
let world = null;
Object.defineProperty(navigator, 'onLine', { get: () => world?.online ?? false, configurable: true });

/* ---------- the model ---------- */

/* What the store should hold, worked out from what the writers were asked. The rules are the store's own, written
   plainly: a read that started before a task's last answer leaves the task alone, an answer is always taken, an
   answered op's apply goes into the copy, a row marked done keeps what it showed, and an edit that Vikunja answered
   stops an older edit laying the same fields. */
class Model {
  constructor(w) {
    this.w = w;
    this.copies = new Map(); // task id -> Vikunja's copy
    this.bases = new Map(); // task id -> what its row was made from while there is no copy
    this.answerAt = new Map(); // task id -> the model's time of its last answer
    this.forgotten = new Set();
    this.rows = new Set(); // the ids with a row, as strings
    this.edits = new Map(); // task id -> its edits still running, oldest first: {fields}
    this.leaving = new Map(); // task id -> its mark
    this.frozen = new Map(); // task id -> {snap, touched}: a row marked done, as it was marked
    this.waiting = new Map(); // task id, as a string -> the ops waiting on it, in order
    this.settled = new Set(); // ops answered, or a held delete restored, still in the outbox
    this.unsure = new Map(); // task id -> field -> when Vikunja changed it without Pocket being told
    this.starts = new Map([[0, 0]]); // a read's start on the store's clock -> on the model's
    this.lastRead = new Map(); // task id -> when the last read the store took of it started
    this.uncopied = new Map(); // task id -> when an op on it was answered while Pocket had no copy of it
    this.time = 0;
  }
  opsId(task) {
    return typeof task === 'string' ? (sync.taskOf(task.replace(/^pending-/, '')) ?? task) : task;
  }
  write(list, asked, at) {
    for (const t of list) {
      const id = t?.id;
      if (!id || this.forgotten.has(id)) continue;
      if (at === undefined) this.answerAt.set(id, ++this.time);
      else if ((this.answerAt.get(id) || 0) > at) continue;
      if (!asked) this.gone(id);
      else if (this.copies.has(id) || asked.some(k => k in t)) {
        const c = { ...this.copies.get(id) };
        for (const k of asked) if (k in t) c[k] = clone(t[k]);
        this.copies.set(id, c);
      }
      if (at !== undefined) this.lastRead.set(id, Math.max(at, this.lastRead.get(id) ?? 0));
      // A read that started after Vikunja changed a field tells Pocket of it.
      if (at !== undefined && asked)
        for (const [k, when] of this.unsure.get(id) || [])
          if (asked.includes(k) && when <= at) this.unsure.get(id).delete(k);
    }
  }
  gone(id) {
    this.copies.delete(id);
    this.forgotten.add(id);
    for (const m of [this.edits, this.bases, this.frozen]) m.delete(id);
    this.rows.delete(String(id));
  }
  // The writers, as the store's.
  read(list, asked, at) {
    const from = this.starts.get(at);
    if (from === undefined) throw new Error(`a read that started at ${at}, which no command started`);
    this.write(list, asked, from);
  }
  answer(list, asked) {
    this.write(list, asked);
  }
  base(t) {
    if (!this.copies.has(t.id)) this.bases.set(t.id, clone(t));
    this.rows.add(String(t.id));
  }
  edit(id, fields) {
    const e = { fields: { ...fields } };
    this.edits.set(id, [...(this.edits.get(id) || []), e]);
    for (const k in fields) this.frozen.get(id)?.touched.add(k);
    return e;
  }
  ok(id, e, got) {
    if (got) this.answer([got], TASK);
    const list = this.edits.get(id) || [];
    for (const x of list.slice(0, Math.max(0, list.indexOf(e)))) for (const k in e.fields) delete x.fields[k];
    this.drop(id, e);
  }
  drop(id, e) {
    const rest = (this.edits.get(id) || []).filter(x => x !== e);
    if (rest.length) this.edits.set(id, rest);
    else this.edits.delete(id);
  }
  leave(id, kind) {
    const row = this.w.app.tasks[id];
    if (kind === 'done' && this.leaving.get(id) !== 'done' && row)
      this.frozen.set(id, {
        snap: clone(row),
        touched: new Set((this.edits.get(id) || []).flatMap(e => Object.keys(e.fields))),
      });
    if (kind !== 'done') this.frozen.delete(id);
    if (kind) this.leaving.set(id, kind);
    else this.leaving.delete(id);
  }
  // The ops waiting in the outbox, on each task they change. A held delete shows only on the tasks it deletes.
  keyOps() {
    const c = this.w.app,
      heldOnes = sync.all(c.user.id).filter(e => sync.held.has(e.id) && !e.failed),
      all = [...c.pending, ...heldOnes],
      listed = new Set([...all, ...c.failed].map(e => e.id));
    for (const id of this.settled) if (!listed.has(id)) this.settled.delete(id);
    this.waiting = new Map();
    for (const e of all)
      if (e.kind === 'act' && OPS[e.op] && !this.settled.has(e.id))
        for (const id of opOf(e).on(e))
          if (!sync.held.has(e.id) || e.ids.includes(id))
            this.waiting.set(String(id), [...(this.waiting.get(String(id)) || []), e]);
  }
  offTasks(a) {
    this.settled.add(a.id);
    for (const id of opOf(a).on(a)) {
      const rest = (this.waiting.get(String(id)) || []).filter(e => e.id !== a.id);
      if (rest.length) this.waiting.set(String(id), rest);
      else this.waiting.delete(String(id));
    }
  }
  // An op's answer: its apply goes into each copy, then the reply, and the comment Vikunja made replaces the waiting one.
  answered(a, got, posted = null) {
    const op = opOf(a);
    const real = t =>
      !t.comments?.some(c => c.id === a.id)
        ? t
        : {
            ...t,
            comments: t.comments.flatMap(c =>
              c.id !== a.id
                ? [c]
                : posted && t.comments.some(x => x.id === posted.id)
                  ? []
                  : [posted || { ...c, waiting: false }],
            ),
          };
    for (const id of op.on(a)) if (!this.copies.has(id) && !this.bases.has(id)) this.uncopied.set(id, ++this.time);
    for (const id of op.on(a))
      if (this.copies.has(id)) {
        const now = real(op.apply(clone(this.copies.get(id)), a));
        this.answer([now], Object.keys(now));
      } else if (this.bases.has(id)) {
        this.bases.set(id, real(op.apply(this.bases.get(id), a)));
        this.answer([{ id }], []);
      }
    if (got?.id === this.opsId(a.task)) this.answer([got], TASK);
    this.offTasks(a);
    if (op.deletes(a).length) this.forgetTree(op.deletes(a));
  }
  forget(id) {
    this.answer([{ id }], null);
  }
  forgetTree(ids) {
    for (const id of ids) this.forget(id);
    const has = t => t?.related_tasks?.subtask?.some(s => ids.includes(s.id)),
      left = t => ({
        ...t,
        related_tasks: { ...t.related_tasks, subtask: t.related_tasks.subtask.filter(s => !ids.includes(s.id)) },
      });
    for (const t of [...this.copies.values()]) if (has(t)) this.answer([left(t)], ['related_tasks']);
    for (const [id, t] of this.bases) if (has(t)) this.bases.set(id, left(t));
  }
  // Task `id` as its rows should show it: Vikunja's copy, the waiting ops in order, then the edits, oldest first.
  shown(id) {
    const b = this.copies.get(id) ?? this.bases.get(id);
    if (!b) return null;
    const x = (this.waiting.get(String(id)) || []).reduce((t, a) => opOf(a).apply(t, a), clone(b));
    return (this.edits.get(id) || []).reduce((t, e) => ({ ...t, ...e.fields }), x);
  }
  // Vikunja changed `fields` of task `id` (all of CHECKED by default) without telling Pocket.
  doubt(id, fields = CHECKED) {
    const m = this.unsure.get(id) || new Map();
    for (const k of fields) m.set(k, ++this.time);
    this.unsure.set(id, m);
  }
}

/* The writers change() hands out, each telling the model first. A writer the model doesn't know fails the test, so a
   new one is added here. */
function spying(m, writers) {
  const out = {};
  for (const [k, fn] of Object.entries(writers)) {
    if (typeof m[k] !== 'function') throw new Error(`the model doesn't know the writer ${k}`);
    out[k] =
      k === 'edit'
        ? (id, fields) => {
            const e = m.edit(id, fields),
              h = fn(id, fields);
            return {
              ok: got => {
                m.ok(id, e, got);
                h.ok(got);
              },
              undo: () => {
                m.drop(id, e);
                h.undo();
              },
            };
          }
        : (...args) => {
            m[k](...args);
            return fn(...args);
          };
  }
  return out;
}

/* ---------- the world: the app, the fake Vikunja and the held replies ---------- */

const unknownReply = () =>
  new Response(JSON.stringify({ message: 'the first request with this Idempotency-Key never finished' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Unknown': 'true' },
  });
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));

/* One sequence's world. The fake Vikunja makes each keyed write as it arrives, and its reply waits in `held` until a
   command lets it go. The relay keeps a key it answered as unknown, and answers it that way again. Reads, and the
   test's own requests, pass straight through. */
class World {
  constructor(clock) {
    for (const s of stores.values()) s.clear();
    sync.entries = new Map();
    for (const k of ['volatile', 'bytes', 'claimed', 'held']) sync[k].clear();
    clock.reset();
    clock.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
    this.clock = clock;
    this.v = fakeVikunja(checklist());
    this.inner = globalThis.fetch;
    Object.assign(this, {
      held: [],
      unknownKeys: new Set(),
      online: false,
      closed: false,
      activity: 0,
      busy: new Set(),
      errors: [],
      reads: [],
      edits: [],
      undos: [],
      stepId: null,
      seen: new Map(),
      made: new Map(), // entry id -> when Vikunja made the first reply about the op's own task, which the op keeps
      madeAt: new Map(), // key -> the model's time when Vikunja made its reply
    });
    globalThis.fetch = (url, opts = {}) => this.gate(url, opts);
    const app = component(
      tasks,
      acts,
      sending,
      outbox,
      runs,
      pick(actions, 'holdDelete', 'sendHeld', 'parentIdOf'),
      leaving,
    );
    Object.assign(app, {
      user: ME,
      pending: [],
      failed: [],
      slow: [],
      flushing: false,
      cap: { text: '' },
      capPhotos: [],
      sheet: { id: null, sub: { text: '' } },
      view: { groups: [], shownRun: null },
      places: {},
      endPlace() {},
      aimSent() {},
      aimCancelled() {},
      positionSent() {},
      positionRefused() {},
      // The commands send. Nothing sends on its own.
      flush: async () => {},
    });
    Object.defineProperty(app, 'toast', { value: {} });
    this.app = app;
    this.model = new Model(this);
    const change = app.change,
      w = this;
    app.change = function (fn) {
      w.activity++;
      return change.call(this, writers => fn(spying(w.model, writers)));
    };
  }
  async gate(url, opts) {
    this.activity++;
    if (this.closed) throw new TypeError('Failed to fetch');
    const key = opts.headers?.['Idempotency-Key']?.replaceAll('"', '');
    if (!key) return this.inner(url, opts);
    if (this.unknownKeys.has(key)) return unknownReply();
    const res = await this.inner(url, opts);
    if (this.closed) throw new TypeError('Failed to fetch');
    // A field Vikunja changes that the op's answer doesn't carry, such as a position, is new to Pocket until it reads.
    const e = this.entryOf(key),
      id = +(new URL(url).pathname.match(/\/tasks\/(\d+)/) || [])[1];
    const unseen = e && Object.entries(SAMPLES).find(([name, s]) => (s.op ?? name) === e.op)[1].unseen;
    if (id && unseen) this.model.doubt(id, unseen);
    // A link changes the related tasks of both tasks, which only a read brings.
    if (id && /\/relations$/.test(url))
      for (const x of [id, JSON.parse(opts.body).other_task_id]) this.model.doubt(x, ['related_tasks']);
    // When Vikunja made the reply: a reply the relay replays was made with the first request with its key.
    const at = this.madeAt.get(key) ?? ++this.model.time;
    this.madeAt.set(key, at);
    if (e && id === this.model.opsId(e.task) && !this.made.has(e.id)) this.made.set(e.id, at);
    return new Promise((ok, no) => this.held.push({ key, id, e, res, at, ok, no }));
  }
  entryOf(key) {
    const name = key.split(':')[0];
    return sync.all(ME.id).find(e => (e.key || e.id) === name) || null;
  }
  // Vikunja's answer to a request Pocket didn't key: a read, or the test's own save.
  async api(path, opts = {}) {
    const r = await this.inner(SERVER + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json' },
      body: opts.body && JSON.stringify(opts.body),
    });
    return r.ok ? r.json() : null;
  }
  // Run `p` in the background. Commands wait for the app to stop working (settle), not for each promise.
  bg(p) {
    const q = Promise.resolve(p).catch(e => this.errors.push(e));
    this.busy.add(q);
    q.finally(() => this.busy.delete(q));
    return q;
  }
  // Wait until the app stops working: no request, no write to the store and no write to the database for a few turns.
  async settle() {
    let was,
      n = 0;
    do {
      was = this.activity + used.requests;
      for (let i = 0; i < 4; i++) await tick();
      if (++n > 500) throw new Error('the app never stopped working');
    } while (was !== this.activity + used.requests);
  }
  acts() {
    return sync.all(ME.id).filter(e => e.kind === 'act');
  }
  // The task a command names: a task's id, or the step, which is its entry's waiting id until Vikunja has made it.
  target(t) {
    return t === STEP ? (this.stepId ?? 'pending-' + STEP) : t;
  }
  async close() {
    this.closed = true;
    for (const h of this.held.splice(0)) h.no(new TypeError('Failed to fetch'));
    for (let i = 0; i < 100 && this.busy.size; i++) {
      for (const h of this.held.splice(0)) h.no(new TypeError('Failed to fetch'));
      await tick();
    }
    globalThis.fetch = this.inner;
  }
}

// What the world starts with: the checklist read in full, as a screen loads it, and a step still being added to it.
async function open(clock) {
  const w = (world = new World(clock));
  const at = started();
  w.model.starts.set(at, w.model.time);
  const list = await Promise.all([1, 2, 3].map(id => w.api('/tasks/' + id)));
  for (const t of putting(TASK_REACTIONS_COMMENTS, at)(list)) w.app.row(t);
  await sync.add(
    {
      id: STEP,
      kind: 'step',
      user: ME.id,
      at: new Date().toISOString(),
      n: 0,
      files: [],
      fails: 0,
      run: 1,
      runTitle: 'Closing',
      project: 5,
      title: 'Sweep up',
      after: 3,
      before: null,
    },
    [],
  );
  w.app.refreshPending();
  await w.settle();
  return w;
}

/* ---------- the checks ---------- */

/* Each check returns what broke it, or nothing. 1: each row is the model's copy, then the waiting ops, then the edits,
   and a row marked done is as it was marked. 2: a row is the same object from one command to the next. 3: Vikunja
   changed each key at most once. 4: once nothing waits or runs, the copy of each task is Vikunja's, except the fields
   Vikunja changed since Pocket last read them. */
function checks(w) {
  const out = [],
    m = w.model,
    app = w.app;
  if (w.errors.length) out.push(`the app threw: ${w.errors.map(e => e.stack || e).join('; ')}`);
  const rows = Object.keys(app.tasks).sort(),
    want = [...m.rows].sort();
  if (canon(rows) !== canon(want)) out.push(`rows ${rows}, and the model has ${want}`);
  for (const k of rows) {
    const id = /^\d+$/.test(k) ? +k : k,
      row = app.tasks[k];
    if (w.seen.has(k) && w.seen.get(k) !== row) out.push(`${k}'s row is a new object`);
    const f = m.frozen.get(id);
    if (f) {
      for (const field of new Set([...Object.keys(f.snap), ...Object.keys(row)]))
        if (!f.touched.has(field) && canon(f.snap[field]) !== canon(row[field]))
          out.push(
            `${k} is marked done, and its ${field} changed from ${canon(f.snap[field])} to ${canon(row[field])}`,
          );
    } else if (canon(row) !== canon(m.shown(id)))
      out.push(`${k}'s row is ${canon(row)}, and its copy, ops and edits give ${canon(m.shown(id))}`);
  }
  w.seen = new Map(rows.map(k => [k, app.tasks[k]]));
  const ids = new Set([...m.copies.keys(), ...w.v.tasks.keys()]);
  for (const id of ids)
    if (canon(copyOf(id)) !== canon(m.copies.get(id)))
      out.push(`${id}'s copy is ${canon(copyOf(id))}, and the model's ${canon(m.copies.get(id))}`);
  const made = new Map();
  for (const r of w.v.requests) if (r.key && !r.replayed) made.set(r.key, (made.get(r.key) || 0) + 1);
  for (const [key, n] of made) if (n > 1) out.push(`Vikunja made ${key} ${n} times`);
  const still = !w.acts().length && !w.held.length && !w.reads.length && !m.edits.size && !w.busy.size;
  if (still)
    for (const id of ids) {
      const c = copyOf(id),
        t = w.v.tasks.get(id),
        unsure = m.unsure.get(id);
      if (!c || unsure?.size === CHECKED.length) continue;
      if (!t) {
        out.push(`${id} is deleted in Vikunja, and Pocket keeps its copy`);
        continue;
      }
      for (const k of CHECKED)
        if (k in c && !unsure?.has(k) && canon(like(k, c[k])) !== canon(like(k, t[k], w.v)))
          out.push(`${id}'s copy has ${k} ${canon(like(k, c[k]))}, and Vikunja ${canon(like(k, t[k], w.v))}`);
    }
  return out;
}
// A field as the copy and Vikunja are compared on: people, labels, reactions, comments and related tasks by their ids
// or text. Vikunja's related tasks leave out a task it has deleted, as its reads do.
function like(k, v, vikunja = null) {
  if (k === 'assignees' || k === 'labels') return (v || []).map(u => u.id);
  if (k === 'comments') return (v || []).map(c => c.comment);
  if (k === 'reactions')
    return Object.fromEntries(
      Object.entries(v || {})
        .filter(([, us]) => us?.length)
        .map(([r, us]) => [r, us.map(u => u.id)]),
    );
  if (k === 'related_tasks')
    return Object.fromEntries(
      Object.entries(v || {}).map(([kind, list]) => [
        kind,
        (list || []).map(s => s.id).filter(id => !vikunja || vikunja.tasks.has(id)),
      ]),
    );
  return v;
}

/* ---------- the commands ---------- */

/* Command orders that trigger a bug the user hasn't decided on yet. Each entry names the bug, says what is wrong, and
   skips only the command (`command`) in the state that triggers it (`when`). An entry no sequence needs any more
   should be removed. */
const KNOWN = [
  /* A read that started earlier and finishes after a newer read of the same task overwrites what the newer read
     brought, so the copy goes back to an older Vikunja until the next read. The late-read rule compares a read only
     with answers, not with other reads. */
  {
    command: 'FinishRead',
    why: 'an older read finishing after a newer one puts back older data',
    when(m, cmd) {
      const r = m.w.reads[cmd.i % m.w.reads.length],
        from = m.starts.get(r.at);
      return r.list.some(t => (m.lastRead.get(t.id) ?? -1) > from);
    },
  },
  /* A reply Vikunja made before Pocket's latest news of the task, an answer or a read taken since, still goes into the
     copy when it arrives, and the copy goes back to the older task. This happens when two writes to one task are
     answered out of order, when a read lands while a write's reply is on its way, and when the relay replays a reply
     after a reply was lost. An op sent in several stages also keeps the reply from its first stage (c.task) and
     writes it once its last stage is answered. So a title saved in the sheet while a tick is being sent flips back
     once the save ends. */
  {
    command: 'Answer',
    why: 'a reply older than the latest answer or read of its task overwrites the copy',
    when(m) {
      const h = m.w.held[0],
        news = id => Math.max(m.answerAt.get(id) ?? 0, m.lastRead.get(id) ?? 0),
        own = h.e && m.opsId(h.e.task);
      return (h.id && news(h.id) >= h.at) || (m.w.made.has(h.e?.id) && news(own) >= m.w.made.get(h.e.id));
    },
  },
  /* A line that fails after its task is made writes the reply from when the task was made (c.task) into the copy,
     trusted for every field (sendAct's catch). The stages after it are lost from the copy: the line arriving done,
     and its parent. The reply is only to be trusted for CREATED. */
  {
    command: 'Answer',
    why: 'a line failing after its task is made puts back the task as it was made',
    when: (m, cmd) => cmd.how === 'unknown' && m.w.held[0].e?.op === 'add' && !!m.w.held[0].e.taskId,
  },
  /* An op answered on a task Pocket has no copy of yet, such as a step claimed before Pocket read it, gives the task
     no answer time (answered), so that the read that brings the task is taken. A read that started before the answer
     is taken too, and the copy lacks the op until the next read. */
  {
    command: 'FinishRead',
    why: 'a read older than an op answered on a task with no copy loses the op',
    when(m, cmd) {
      const r = m.w.reads[cmd.i % m.w.reads.length],
        from = m.starts.get(r.at);
      return r.list.some(t => (m.uncopied.get(t.id) ?? -1) >= from);
    },
  },
];
const excused = (m, cmd) => KNOWN.some(k => k.command === cmd.constructor.name && k.when(m, cmd));

class Command {
  check(m) {
    return this.can(m) && !excused(m, this);
  }
  async run(m, w) {
    await this.act(w, m);
    await w.settle();
    const broken = checks(w);
    if (broken.length) throw new Error(`${this} broke a check:\n  ${broken.join('\n  ')}`);
  }
}
// The fields of `sample`'s op on task `id`. A delete deletes the task and its subtasks as Vikunja has them, deepest
// first, because the app reads each of them before it asks (taskTree).
function fieldsOn(sample, id, w) {
  const copy = id => w.model.copies.get(id),
    subs = id => (w.v.tasks.get(id)?.related_tasks?.subtask || []).map(s => s.id).filter(x => w.v.tasks.has(x));
  const tree = id => [...subs(id).flatMap(tree), id];
  if (typeof sample.fields === 'function')
    return [sample.fields(ops, { id, project_id: 5, title: copy(id)?.title || '' })].flat();
  const f = { ...sample.fields, task: id };
  if ('ids' in f) f.ids = tree(id);
  if ('up' in f) f.up = copy(id)?.related_tasks?.parenttask?.[0]?.id ?? null;
  if (f.up === null) delete f.up;
  return [f];
}
// Whether sample `name` can be queued on target `t`: a task with a row, or the step for an op on one task alone.
function canQueue(w, name, t) {
  const s = SAMPLES[name],
    id = w.target(t);
  if (typeof id === 'string')
    return typeof s.fields !== 'function' && !s.queue && !('ids' in s.fields) && !('up' in s.fields);
  return !!w.app.tasks[id] && !w.app.beingDeleted(id) && w.app.leaving[id] !== 'deleted';
}
class Queue extends Command {
  constructor(name, t) {
    super();
    Object.assign(this, { name, t });
  }
  can(m) {
    return canQueue(m.w, this.name, this.t);
  }
  async act(w) {
    const s = SAMPLES[this.name],
      list = fieldsOn(s, w.target(this.t), w).map(f => ({ id: uuid7(), ...f })),
      f = list.at(-1);
    if (opOf(f).invert) w.undos.push(f);
    w.bg(s.queue ? s.queue(w.app, f) : w.app.actAll(list));
  }
  toString() {
    return `Queue(${this.name} on ${this.t})`;
  }
}
// Send what waits, until a write's reply is held. `retry` sends a change whose reply was lost, and the relay answers
// it from what it kept.
class Send extends Command {
  constructor(retry) {
    super();
    this.retry = retry;
  }
  can(m) {
    const acts = m.w.acts().filter(e => !e.failed && !held(e));
    return !m.w.held.length && acts.some(e => !!e.sent === this.retry);
  }
  async act(w) {
    const last = w
      .acts()
      .filter(e => !held(e))
      .at(-1);
    w.online = true;
    w.app.offline = false;
    w.bg(w.app.sendActs(last.id));
    await w.settle();
    w.online = false;
  }
  toString() {
    return this.retry ? 'Retry' : 'Send';
  }
}
// The held reply arrives, is lost on its way, or comes back unknown: the relay can't say whether Vikunja made it.
class Answer extends Command {
  constructor(how) {
    super();
    this.how = how;
  }
  can(m) {
    return m.w.held.length > 0;
  }
  async act(w, m) {
    const h = w.held.shift();
    if (this.how === 'arrives') h.ok(h.res);
    else if (this.how === 'lost') h.no(new TypeError('network error'));
    else {
      w.unknownKeys.add(h.key);
      for (const id of [h.id, ...(h.e ? opOf(h.e).on(h.e) : [])]) if (typeof id === 'number' && id) m.doubt(id);
      h.ok(unknownReply());
    }
  }
  toString() {
    return `Answer(${this.how})`;
  }
}
// Cancel in the Outbox, on the waiting or refused change at index `i`.
class Drop extends Command {
  constructor(i) {
    super();
    this.i = i;
  }
  can(m) {
    return m.w.acts().length > 0;
  }
  async act(w) {
    const list = w.acts();
    w.bg(w.app.dropAct(list[this.i % list.length].id));
  }
  toString() {
    return `Drop(${this.i})`;
  }
}
// Undo of a change queued by the test, sent or not.
class Undo extends Command {
  constructor(i) {
    super();
    this.i = i;
  }
  can(m) {
    return m.w.undos.length > 0;
  }
  async act(w) {
    const [f] = w.undos.splice(this.i % w.undos.length, 1);
    w.bg(w.app.undoOps([f]).left);
  }
  toString() {
    return `Undo(${this.i})`;
  }
}
// A read of some tasks starts: Vikunja answers it now, and Pocket gets the answer when FinishRead says.
class StartRead extends Command {
  constructor(ts, full) {
    super();
    Object.assign(this, { ts, full });
  }
  can() {
    return true;
  }
  async act(w, m) {
    const at = started();
    m.starts.set(at, m.time);
    const ids = [...new Set(this.ts.map(t => w.target(t)))].filter(id => typeof id === 'number');
    const list = (await Promise.all(ids.map(id => w.api('/tasks/' + id)))).filter(Boolean);
    w.reads.push({ at, list, asked: this.full ? TASK_REACTIONS_COMMENTS : TASK });
  }
  toString() {
    return `StartRead(${this.ts}${this.full ? ', with reactions and comments' : ''})`;
  }
}
// A read that started earlier reaches Pocket, as a screen's load does: its tasks go into the store, then get rows.
class FinishRead extends Command {
  constructor(i) {
    super();
    this.i = i;
  }
  can(m) {
    return m.w.reads.length > 0;
  }
  async act(w) {
    const [r] = w.reads.splice(this.i % w.reads.length, 1);
    for (const t of putting(r.asked, r.at)(structuredClone(r.list))) w.app.row(t);
  }
  toString() {
    return `FinishRead(${this.i})`;
  }
}
// A direct save starts on a task with a row, laying its fields over the row.
class StartEdit extends Command {
  constructor(t, fields) {
    super();
    Object.assign(this, { t, fields });
  }
  can(m) {
    const id = m.w.target(this.t);
    return typeof id === 'number' && !!m.w.app.tasks[id];
  }
  async act(w) {
    const id = w.target(this.t),
      h = w.app.change(x => x.edit(id, this.fields));
    w.edits.push({ id, fields: this.fields, h });
  }
  toString() {
    return `StartEdit(${this.t}, ${canon(this.fields)})`;
  }
}
// A direct save ends: Vikunja makes it and answers (ok), or it fails (undo). A task deleted meanwhile fails it.
class EndEdit extends Command {
  constructor(i, ok) {
    super();
    Object.assign(this, { i, ok });
  }
  can(m) {
    return m.w.edits.length > 0;
  }
  async act(w) {
    const [e] = w.edits.splice(this.i % w.edits.length, 1),
      got = this.ok && (await w.api('/tasks/' + e.id, { method: 'PATCH', body: e.fields }));
    w.app.change(() => (got ? e.h.ok(got) : e.h.undo()));
  }
  toString() {
    return `EndEdit(${this.i}, ${this.ok ? 'ok' : 'undo'})`;
  }
}
// A row is marked as leaving, as a tick or a swipe marks it.
class Mark extends Command {
  constructor(t, kind) {
    super();
    Object.assign(this, { t, kind });
  }
  can(m) {
    return !!m.w.app.tasks[m.w.target(this.t)];
  }
  async act(w) {
    w.app.markRow(w.target(this.t), { kind: this.kind });
  }
  toString() {
    return `Mark(${this.t}, ${this.kind})`;
  }
}
class ClearBatch extends Command {
  can() {
    return true;
  }
  async act(w) {
    w.bg(w.app.clearBatch(true));
  }
  toString() {
    return 'ClearBatch';
  }
}
// Vikunja makes the step being added, under the checklist, and its ops are filed under its id, as sendStep does.
class StepMade extends Command {
  can(m) {
    return m.w.stepId === null;
  }
  async act(w) {
    w.bg(
      sync.lock(async () => {
        const t = await w.api('/projects/5/tasks', { method: 'POST', body: { title: 'Sweep up' } });
        await w.api('/tasks/1/relations', { method: 'POST', body: { other_task_id: t.id, relation_kind: 'subtask' } });
        w.model.doubt(1, ['related_tasks']);
        sync.claim(t.id, STEP);
        w.stepId = t.id;
        w.app.change(x => x.keyOps());
        await sync.remove(STEP);
        w.app.refreshPending();
      }),
    );
  }
  toString() {
    return 'StepMade';
  }
}
// A teammate changes a task in Vikunja's web app: a field an op changes, or one none does.
const CHANGES = {
  done: t => !t.done,
  percent_done: () => 0.75,
  due_date: t => (t.due_date === '2026-10-20T09:00:00Z' ? '0001-01-01T00:00:00Z' : '2026-10-20T09:00:00Z'),
  assignees: t => [...(t.assignees || []), { id: 7, username: 'bob' }],
  title: t => t.title + ' (renamed)',
  priority: () => 3,
};
class Teammate extends Command {
  constructor(t, field) {
    super();
    Object.assign(this, { t, field });
  }
  can(m) {
    return m.w.v.tasks.has(m.w.target(this.t));
  }
  async act(w, m) {
    const id = w.target(this.t),
      t = w.v.tasks.get(id);
    t[this.field] = CHANGES[this.field](t);
    t.updated = new Date().toISOString();
    m.doubt(id, [this.field]);
  }
  toString() {
    return `Teammate(${this.t}, ${this.field})`;
  }
}
// Time passes on the fake clock, which Pocket and the fake Vikunja both read.
class Wait extends Command {
  constructor(ms) {
    super();
    this.ms = ms;
  }
  can() {
    return true;
  }
  async act(w) {
    w.clock.setTime(Date.now() + this.ms);
  }
  toString() {
    return `Wait(${this.ms / 1000} s)`;
  }
}

const target = fc.constantFrom(1, 2, 3, STEP);
// Two values for each field, so two edits of one field can disagree.
const EDITS = [
  { title: 'Mop twice' },
  { title: 'Mop once' },
  { priority: 2 },
  { priority: 4 },
  { done: true },
  { done: false },
  { percent_done: 0.5 },
  { percent_done: 0.25 },
  { due_date: '2026-10-18T09:00:00Z' },
  { due_date: '2026-10-19T09:00:00Z' },
];
// fast-check picks each entry equally often, and skips a command that can't run, so sending is listed several times.
const queue = fc.tuple(fc.constantFrom(...Object.keys(SAMPLES)), target).map(([n, t]) => new Queue(n, t)),
  answer = fc.constantFrom('arrives', 'arrives', 'arrives', 'lost', 'unknown').map(h => new Answer(h));
const COMMANDS = [
  queue,
  queue,
  fc.constant(new Send(false)),
  fc.constant(new Send(false)),
  fc.constant(new Send(true)),
  answer,
  answer,
  answer,
  answer,
  fc.nat(5).map(i => new Drop(i)),
  fc.nat(5).map(i => new Undo(i)),
  fc.tuple(fc.uniqueArray(target, { minLength: 1, maxLength: 4 }), fc.boolean()).map(([ts, f]) => new StartRead(ts, f)),
  fc.nat(5).map(i => new FinishRead(i)),
  fc.tuple(target, fc.constantFrom(...EDITS)).map(([t, f]) => new StartEdit(t, f)),
  fc.tuple(fc.nat(5), fc.boolean()).map(([i, ok]) => new EndEdit(i, ok)),
  fc.tuple(target, fc.constantFrom('done', 'open', 'deleted')).map(([t, k]) => new Mark(t, k)),
  fc.constant(new ClearBatch()),
  fc.constant(new StepMade()),
  fc.tuple(target, fc.constantFrom(...Object.keys(CHANGES))).map(([t, f]) => new Teammate(t, f)),
  fc.constantFrom(1000, 30000, 61000).map(ms => new Wait(ms)),
];

test('the store shows each task as its copy, then the waiting ops, then the edits, whatever order things happen in', async t => {
  const seed = process.env.FC_SEED ? +process.env.FC_SEED : process.env.CI ? 6040 : undefined;
  await fc.assert(
    fc.asyncProperty(fc.commands(COMMANDS, { maxCommands: 40, size: 'max' }), async cmds => {
      const w = await open(t.mock.timers);
      try {
        const broken = checks(w);
        if (broken.length) throw new Error(`the world broke a check as it opened:\n  ${broken.join('\n  ')}`);
        await fc.asyncModelRun(() => ({ model: w.model, real: w }), cmds);
      } finally {
        await w.close();
      }
    }),
    { numRuns: RUNS, seed, endOnFailure: false },
  );
});
