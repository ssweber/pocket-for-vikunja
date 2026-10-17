/* A randomized test of the store (src/js/app/tasks.js). fast-check generates sequences of commands on a few tasks: ops
   queued, sent, answered in any order, refused, lost and undone, reads finishing late, direct saves in flight, rows
   marked as leaving, and a teammate's changes in the web app. Each sequence then sends and answers everything still
   waiting, and reads every task. The checks after each command compare the app with a model made from the fake
   Vikunja's replies, each op's `apply` and the outbox's database, never from the store's own functions. A failure
   prints the seed and the shortest sequence that breaks a check. */
import './browser.mjs';
import { stores, used } from './outbox-db.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { component, fakeVikunja } from './fake.mjs';
import tasks, {
  copyOf,
  CREATED,
  putting,
  started,
  TASK,
  TASK_REACTIONS_COMMENTS,
  writes,
} from '../../src/js/app/tasks.js';
import acts from '../../src/js/app/acts.js';
import sending from '../../src/js/app/sending.js';
import outbox from '../../src/js/app/outbox.js';
import runs from '../../src/js/app/runs.js';
import actions from '../../src/js/app/actions.js';
import leaving from '../../src/js/app/leaving.js';
import { held, older, sync, uuid7 } from '../../src/js/sync.js';
import { DONE_MARK, SKIP_MARK } from '../../src/js/checklists.js';
import { repeats } from '../../src/js/dates.js';
import * as ops from '../../src/js/ops/index.js';
import { checklist, line, ME, SAMPLES } from './samples.mjs';

const { OPS, opOf } = ops;
/* CI=1 fixes the seed. FC_RUNS sets the number of sequences, and FC_SEED a seed to run again. FC_PATH and FC_REPLAY
   replay a failure's path and replayPath at once. FC_STATS=1 prints how often each command ran, each KNOWN bug was
   met, and checks 4 and 5 ran with nothing skipped. */
const RUNS = +process.env.FC_RUNS || 1000,
  START = Date.parse('2026-10-17T09:00:00Z'),
  SERVER = 'http://vikunja.test/api/v2';
// The step still being added to checklist 1, by its outbox entry. Commands name it 'step' (target).
const STEP = 'step';
// The fields the copy of a task is compared on with Vikunja's: every field Pocket reads, except the times Vikunja
// sets itself.
const CHECKED = TASK_REACTIONS_COMMENTS.filter(k => !['updated', 'created', 'created_by', 'done_at'].includes(k));
// The samples, and a line with a label and a person, so a line's label and people stages send too. The lifecycle test
// leaves this one out, because a label Vikunja refuses is reported and the line goes on without it.
const ALL = {
  ...SAMPLES,
  // A delete is queued as a swipe queues it: held for Restore, its row marked, and sent as the batch clears.
  delete: { ...SAMPLES.delete, queue: (app, f) => app.removeTask(app.tasks[f.task], f.ids) },
  'add, with a label and a person': {
    op: 'add',
    fields: ({ addLines }, parent) =>
      addLines([line('Buy rope', { pct: 50, labels: ['rope'], assignees: ['bob'] })], { parent })[0],
  },
};
// The ops that put the user's ✅ or ⏭️ on a task.
const MARKS = ['done', 'doneNote', 'skip', 'finish'];
// The fields of a repeating task that Vikunja moves on when it is marked done, instead of marking it done.
const MOVED = ['done', 'done_at', 'due_date', 'start_date', 'end_date', 'reminders'];
const clone = v => (v === undefined ? v : structuredClone(v));
// JSON with each object's keys sorted, so two values compare by content whatever order their keys were written in.
const canon = v =>
  JSON.stringify(v, (k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
// Whether two values are equal by content, whatever order their keys were written in. A key holding undefined counts
// as missing, as in JSON.
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const keys = o => Object.keys(o).filter(k => o[k] !== undefined),
    ka = keys(a);
  return ka.length === keys(b).length && ka.every(k => same(a[k], b[k]));
};
// The fields in which two tasks differ.
const differ = (a, b) =>
  [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(k => !same(a?.[k], b?.[k]));
const tick = () => new Promise(ok => setImmediate(ok));
// Pocket sends a change not yet sent only while the browser says it is online, which is only during Send.
let world = null;
Object.defineProperty(navigator, 'onLine', { get: () => world?.online ?? false, configurable: true });

/* What the test counts over a whole run, for FC_STATS and for the KNOWN entries no sequence met. */
const STATS = { commands: new Map(), met: new Map(), checks: new Map() };
const count = (map, k) => map.set(k, (map.get(k) || 0) + 1);
// A check ran, with nothing skipped or not.
const ran = (check, clean) => {
  count(STATS.checks, check);
  if (clean) count(STATS.checks, check + ' with nothing skipped');
};

/* ---------- the fake Vikunja's replies ---------- */

/* The fake Vikunja stamps each task it sends Pocket with the number of the reply (`_made`), and the world keeps what
   each reply said and when Vikunja made it (`replies`). So the model can tell how old the data behind each write is,
   on Vikunja's log rather than on the store's clock. The store never keeps the stamp, because no list of trusted fields
   names it, and the writers strip it before a row sees it. */
const MADE = '_made';
const strip = t => {
  if (!t || typeof t !== 'object' || !(MADE in t)) return t;
  const { [MADE]: _, ...rest } = t;
  return rest;
};
// The fields a reply can be trusted for, by the request that brought it: a test's read asks for its own.
const trusted = rec => (rec.kind === 'read' ? rec.asked : rec.kind === 'create' ? CREATED : TASK);
// The fields of a task that a write to it changes.
function touches(h) {
  const path = new URL(h.url).pathname;
  for (const [re, k] of [
    [/\/reactions(\/delete)?$/, 'reactions'],
    [/\/comments$/, 'comments'],
    [/\/assignees(\/\w+)?$/, 'assignees'],
    [/\/labels(\/bulk)?$/, 'labels'],
    [/\/position$/, 'position'],
    [/\/relations/, 'related_tasks'],
  ])
    if (re.test(path)) return [k];
  if (h.method !== 'PATCH') return [];
  const body = Object.keys(JSON.parse(h.opts.body));
  return body.includes('done') ? [...body, 'done_at'] : body;
}
// What kind of reply a request gets that brings a task, or null.
const replyKind = (method, url) =>
  method === 'GET'
    ? 'get'
    : method === 'PATCH'
      ? 'patch'
      : method === 'POST' && /\/projects\/\d+\/tasks$/.test(url)
        ? 'create'
        : null;

/* ---------- the model ---------- */

/* What the store should hold. The model hears of each write from the writers that change() hands out, and makes each
   copy from the fake Vikunja's reply behind the write, trusting it for the fields its kind of request brings, and from
   each op's apply and each save's fields. A reply or a change is taken when the store took it, because which is new
   enough is check 5's to judge, from the fake Vikunja's log. Each field the store changed must come from the reply or
   the change it was given. The ops waiting on a task are read from the outbox's database. */
class Model {
  constructor(w) {
    this.w = w;
    this.copies = new Map(); // task id -> Vikunja's copy, as the replies taken give it
    this.bases = new Map(); // task id -> what its row was made from while there is no copy
    // task id -> field -> {at, from}: the newest data Pocket has of each field, on the fake Vikunja's log
    this.tags = new Map();
    this.forgotten = new Set(); // tasks Pocket deleted
    this.rows = new Set(); // the ids with a row, as strings
    this.edits = new Map(); // task id -> its edits still running, oldest first: {fields}
    this.leaving = new Map(); // task id -> its mark
    this.frozen = new Map(); // task id -> {snap, touched}: a row marked done, as it was marked
    this.settled = new Set(); // ops answered, still in the outbox
    this.unsure = new Map(); // task id -> field -> when Vikunja changed it without Pocket being told
    this.relaxed = new Map(); // task id -> the fields a KNOWN bug met in this sequence may have left wrong
    this.met = new Set(); // the KNOWN entries met in this sequence
  }
  relaxes(id, k) {
    return !!this.relaxed.get(id)?.has(k);
  }
  // Pocket has news of `fields` of task `id`, each from the time `at` gives it, unless it has newer.
  news(id, fields, at, from = 'answer') {
    const t = this.tags.get(id) || new Map();
    for (const k of fields) if (!(t.get(k)?.at >= at(k))) t.set(k, { at: at(k), from });
    this.tags.set(id, t);
  }
  unrelated(t) {
    const out = list => list && list.filter(s => !this.forgotten.has(s.id));
    return !t.related_tasks
      ? t
      : { ...t, related_tasks: Object.fromEntries(Object.entries(t.related_tasks).map(([k, l]) => [k, out(l)])) };
  }
  /* Take into task `id`'s copy each field the store changed from `before` to `after`, each from the first of `sources`
     ({fields}) that gives that value. Returns the source of each field. A field none of them gives breaks check 1. */
  adopt(id, before, after, sources) {
    const from = new Map();
    for (const k of differ(before, after)) {
      const s = sources.find(x => k in x.fields && same(after[k], this.unrelated({ [k]: x.fields[k] })[k]));
      if (s) from.set(k, s);
      else
        this.w.broken.push(
          `check 1: the store wrote ${id}'s ${k} as ${canon(after?.[k])}, which nothing it was given says`,
        );
    }
    if (!after) return from;
    const c = { ...this.copies.get(id) };
    for (const [k, s] of from) c[k] = clone(s.fields[k]);
    this.copies.set(id, this.unrelated(c));
    return from;
  }
  // The op's apply, with the comment Vikunja made (`posted`) in place of the op's waiting one.
  applied(t, a, posted) {
    const x = opOf(a).apply(clone(t), a);
    if (!x.comments?.some(c => c.id === a.id)) return x;
    return {
      ...x,
      comments: x.comments.flatMap(c =>
        c.id !== a.id
          ? [c]
          : posted && x.comments.some(y => y.id === posted.id)
            ? []
            : [clone(posted) || { ...c, waiting: false }],
      ),
    };
  }
  gone(id) {
    this.copies.delete(id);
    this.forgotten.add(id);
    for (const m of [this.edits, this.bases, this.frozen]) m.delete(id);
    this.rows.delete(String(id));
  }
  // Deleted tasks leave every list of related tasks, as Vikunja's reads leave them out.
  forgetTree(ids) {
    for (const id of ids) this.gone(id);
    for (const m of [this.copies, this.bases]) for (const [id, t] of m) m.set(id, this.unrelated(t));
  }
  edit(id, fields) {
    const e = { fields: { ...fields } };
    this.edits.set(id, [...(this.edits.get(id) || []), e]);
    for (const k in fields) this.frozen.get(id)?.touched.add(k);
    return e;
  }
  // Vikunja has an edit's fields once it answers, so an older edit stops laying them.
  ended(id, e) {
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
  /* The ops among outbox entries `list` that task `id`'s rows show, in the order they will be sent: not refused, not
     yet answered, and a delete held for Restore (in `holding`) only on the tasks it deletes. */
  waitingIn(list, holding, id) {
    return list
      .filter(e => e.user === ME.id && e.kind === 'act' && OPS[e.op] && !e.failed && !this.settled.has(e.id))
      .sort(older)
      .filter(
        e =>
          opOf(e)
            .on(e)
            .some(x => String(x) === String(id)) &&
          (!holding.has(e.id) || e.ids.some(x => String(x) === String(id))),
      );
  }
  // The ops waiting on task `id`, from the outbox's database.
  waitingOn(id) {
    return this.waitingIn([...stores.get('outbox').values()], sync.held, id);
  }
  // Task `id` as its rows should show it: Vikunja's copy, the waiting ops in order, then the edits, oldest first.
  shown(id) {
    const b = this.copies.get(id) ?? this.bases.get(id);
    if (!b) return null;
    const x = this.waitingOn(id).reduce((t, a) => opOf(a).apply(t, a), b);
    return (this.edits.get(id) || []).reduce((t, e) => ({ ...t, ...e.fields }), x);
  }
  // Vikunja changed `fields` of task `id` (all of CHECKED by default) without telling Pocket.
  doubt(id, fields = CHECKED) {
    const m = this.unsure.get(id) || new Map();
    for (const k of fields) m.set(k, this.w.t);
    this.unsure.set(id, m);
  }
}

/* What each writer that change() hands out tells the model, before or after the store's own writer runs. A writer the
   model doesn't hear of fails the test, so a new one is added here. A write of Vikunja's data goes through `wrote`,
   which takes it into the model and judges it (check 5). */
const HEARD = {
  read(w, fn, list, asked, at) {
    const before = w.copiesNow(),
      thrown = new Map(list.map(t => [t.id, !!w.reading && w.overlapped(t.id)]));
    fn(list.map(strip), asked, at);
    for (const t of list)
      w.wrote({ via: 'read', id: t.id, rec: w.replyOf(t), before: before.get(t.id), asked, thrown: thrown.get(t.id) });
  },
  answer(w, fn, list, asked, from) {
    const before = w.copiesNow();
    fn(list.map(strip), asked, from);
    for (const t of list) {
      const rec = w.replyOf(t);
      w.wrote({ via: 'answer', id: t.id, rec, before: before.get(t.id), asked, thrown: w.crossed(rec, t.id) });
    }
  },
  // A change Vikunja made, as Pocket asked for it: a direct save's fields, or a checklist's progress an op wrote. Each
  // field is judged with the time Vikunja last made a request that changed it (lastWrite).
  made(w, fn, id, fields, from) {
    const m = w.model,
      before = w.copiesNow().get(id);
    fn(id, fields, from);
    if (m.forgotten.has(id)) return;
    if (!before) {
      if (m.bases.has(id)) m.bases.set(id, { ...m.bases.get(id), ...clone(fields) });
      return;
    }
    /* A direct save was made when its request was (saveMade). A checklist's progress has no other write on its way,
       and is part of its op's write. */
    const after = copyOf(id),
      fieldAt = k => w.saveMade ?? w.lastWrite.get(`${id} ${k}`) ?? w.t,
      x =
        w.answering ?? [...w.pocket.values()].find(y => Object.keys(fields).every(k => k in (y.fields.get(id) || {})));
    m.adopt(id, before, after, [{ fields }]);
    w.judge({
      via: 'made',
      id,
      at: Math.max(...Object.keys(fields).map(fieldAt)),
      before,
      after,
      fieldAt,
      asked: fields,
      skip: w.clashing(x, id, fields),
    });
  },
  /* An op's answer: its apply goes into each copy, then Vikunja's reply about its own task, and a deleted task leaves
     every list. Each field the store took from the apply is judged with the time Vikunja made the op's last request
     that changed that field of that task (madeField). The reply is judged with its own time, against Pocket's news of
     the task before the answer, since the apply's news isn't about the fields the reply brings. */
  answered(w, fn, a, from, reply, posted) {
    const m = w.model,
      op = opOf(a),
      got = reply?.task ?? null,
      rec = got ? w.replyOf(got) : null,
      before = w.copiesNow(),
      tags = new Map([...m.tags].map(([id, t]) => [id, new Map(t)])),
      own =
        got && got.id === (typeof a.task === 'string' ? sync.taskOf(a.task.replace(/^pending-/, '')) : a.task)
          ? got.id
          : null,
      at = w.lastMade.get(a.id) ?? w.t,
      x = w.pocket.get(a.id);
    fn(a, from, reply && { ...reply, task: strip(got) }, posted);
    w.land(a.id);
    m.settled.add(a.id);
    if (op.deletes(a).length) m.forgetTree(op.deletes(a));
    for (const id of new Set([...op.on(a), ...(own ? [own] : [])])) {
      if (m.forgotten.has(id)) continue;
      const b = before.get(id),
        fieldAt = k => w.madeField.get(`${a.id} ${id} ${k}`) ?? at;
      if (!b) {
        const uncopied = !m.bases.has(id) && own !== id;
        if (m.bases.has(id) && op.on(a).includes(id)) m.bases.set(id, m.applied(m.bases.get(id), a, posted));
        const x = m.applied({ id }, a, posted),
          asked = Object.fromEntries(differ({ id }, x).map(k => [k, x[k]]));
        if (uncopied) w.judge({ via: 'apply', id, at, a, before: b, after: undefined, uncopied, fieldAt, asked });
        if (own === id) w.wrote({ via: 'got', id, rec, before: b, tag: tags.get(id), thrown: w.crossed(rec, id) });
        continue;
      }
      // Each field the store changed comes from the reply or the apply. Each is judged as a write of its own.
      const after = copyOf(id),
        applied = op.on(a).includes(id) ? m.applied(b, a, posted) : b,
        trust = own === id ? trusted(rec).filter(k => k in rec.data) : [],
        replied = { fields: Object.fromEntries(trust.map(k => [k, rec.data[k]])), rec },
        thrown = own === id && w.crossed(rec, id),
        // A replayed reply explains only what the apply doesn't, so a field both give counts as the apply's. A reply to
        // a write that crossed another explains nothing.
        sources = thrown
          ? [{ fields: applied }]
          : rec?.replayed
            ? [{ fields: applied }, replied]
            : [replied, { fields: applied }],
        src = m.adopt(id, b, after, sources),
        mid = { ...b };
      for (const [k, x] of src) if (!x.rec) mid[k] = after[k];
      const asked = Object.fromEntries(differ(b, applied).map(k => [k, applied[k]]));
      w.judge({ via: 'apply', id, at, a, before: b, after: mid, fieldAt, asked, skip: w.clashing(x, id, asked) });
      if (own === id) w.judge({ via: 'got', id, at: rec.at, rec, before: mid, after, tag: tags.get(id), thrown });
    }
  },
  base(w, fn, t) {
    const m = w.model,
      x = strip(t);
    fn(x);
    if (!m.copies.has(x.id)) m.bases.set(x.id, m.unrelated(clone(x)));
    m.rows.add(String(x.id));
  },
  edit(w, fn, id, fields) {
    const m = w.model,
      e = m.edit(id, fields),
      h = fn(id, fields);
    return {
      ok: () => {
        h.ok();
        m.ended(id, e);
      },
      undo: () => {
        m.drop(id, e);
        h.undo();
      },
    };
  },
  leave(w, fn, id, kind) {
    w.model.leave(id, kind);
    return fn(id, kind);
  },
  keyOps(w, fn) {
    return fn();
  },
  offTasks(w, fn, a) {
    w.model.settled.add(a.id);
    return fn(a);
  },
  forget(w, fn, id) {
    fn(id);
    w.model.gone(id);
  },
  forgetTree(w, fn, ids) {
    fn(ids);
    w.model.forgetTree(ids);
  },
};
function spying(w, writers) {
  const out = {};
  for (const [k, fn] of Object.entries(writers)) {
    if (!HEARD[k]) throw new Error(`the model doesn't hear of the writer ${k}`);
    out[k] = (...args) => HEARD[k](w, fn, ...args);
  }
  return out;
}

/* ---------- the world: the app, the fake Vikunja and the requests on their way ---------- */

const unknownReply = () =>
  new Response(JSON.stringify({ message: 'the first request with this Idempotency-Key never finished' }), {
    status: 409,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Unknown': 'true' },
  });
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));

/* One sequence's world. A write Pocket sends waits in `held` until a command lets Vikunja make it (Reach), answer it
   (Answer), or refuse it. A key the relay answered as unknown is answered that way again. Reads pass straight through.
   `t` is the fake Vikunja's log: it counts each request Vikunja answers and each change a teammate makes. */
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
      t: 0,
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
      replies: [], // what each reply said: {at, kind, replayed, asked, data}
      madeAt: new Map(), // key -> when Vikunja made it
      lastMade: new Map(), // entry id -> when Vikunja made its latest request
      madeField: new Map(), // 'entry task field' -> when Vikunja made the entry's latest request that changed the field
      lastWrite: new Map(), // 'task field' -> when Vikunja made the latest request that changed the field
      pocket: new Map(), // Pocket's writes in flight (fly)
      n: 0, // counts reads starting and Pocket's writes ending, to order them
      landedAt: new Map(), // task id -> when a write of Pocket's to it last ended, on `n`
      reading: null, // the read finishing
      saveMade: null, // when Vikunja made the direct save being answered
      answering: null, // the direct save being answered, as fly has it
      saving: Promise.resolve(), // the direct saves, one after another (save)
      broken: [], // what check 5 found during the command
      wrote5: false, // whether the command wrote any of Vikunja's data
    });
    globalThis.fetch = (url, opts = {}) => this.gate(url, opts);
    const app = component(
      tasks,
      acts,
      sending,
      outbox,
      runs,
      pick(actions, 'removeTask', 'holdDelete', 'undoDelete', 'sendHeld', 'parentIdOf'),
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
      // Each row is on the screen, so a delete marks it (removeTask).
      rowEl: id => (app.tasks[id] ? {} : null),
      aimSent() {},
      aimCancelled() {},
      positionSent() {},
      positionRefused() {},
      // The commands send. Nothing sends on its own.
      flush: async () => {},
      // Vikunja refuses the search for who can see the project, so a line's person is assigned and Vikunja decides.
      canSee: async () => null,
      findUser: async name => ({ id: 7, username: name }),
      loadLabels: async () => (app.labels = clone(this.v.labels)),
    });
    Object.defineProperty(app, 'toast', { value: {} });
    this.app = app;
    this.model = new Model(this);
    const change = app.change,
      w = this;
    app.change = function (fn) {
      w.activity++;
      return change.call(this, writers => fn(spying(w, writers)));
    };
  }
  async gate(url, opts) {
    this.activity++;
    if (this.closed) throw new TypeError('Failed to fetch');
    const key = opts.headers?.['Idempotency-Key']?.replaceAll('"', '') || null,
      method = opts.method || 'GET';
    if (key && this.unknownKeys.has(key)) return unknownReply();
    if (method === 'GET') return this.stamped(await this.inner(url, opts), ++this.t, false, 'get');
    const h = {
      url,
      opts,
      key,
      method,
      e: key && this.entryOf(key),
      id: +(new URL(url).pathname.match(/\/tasks\/(\d+)/) || [])[1] || null,
      res: null,
    };
    if (h.e?.kind === 'act') this.flyOp(h);
    h.write = h.e ? this.pocket.get(h.e.id) : opts.write;
    return new Promise((ok, no) => this.held.push(Object.assign(h, { ok, no })));
  }
  /* Pocket's writes in flight, as the store tracks them (writes, tasks.js): a direct save from its send to its reply,
     and an op from its first request in a try to its answer or its failure. Each is {fields, crossed}: what it sets
     on each task, and the writes in flight on each task at the same time. Two writes that set one field to different
     values can reach Vikunja in either order, so the store takes neither, and Vikunja's value is unknown to Pocket
     until a read (doubt, when Vikunja makes each). `key` is the op's entry id, or the save. */
  fly(key, id, fields) {
    /* Vikunja sets done_at itself when done changes. It moves a repeating task marked done on to its next dates
       instead, so only its reply says what the write leaves there. */
    const unknown = Symbol('unknown'),
      t = this.model.copies.get(id) ?? this.model.bases.get(id);
    if ('done' in fields && !('done_at' in fields)) fields = { ...fields, done_at: unknown };
    if (fields.done === true && t && repeats(t))
      fields = { ...fields, ...Object.fromEntries(MOVED.map(k => [k, unknown])) };
    let x = this.pocket.get(key);
    if (!x) this.pocket.set(key, (x = { fields: new Map(), crossed: new Map(), unheard: new Map() }));
    x.fields.set(id, { ...x.fields.get(id), ...fields });
    for (const y of this.pocket.values())
      if (y !== x && y.fields.has(id)) {
        x.crossed.set(id, (x.crossed.get(id) || new Set()).add(y));
        y.crossed.set(id, (y.crossed.get(id) || new Set()).add(x));
        for (const z of [x, y]) this.model.doubt(id, [...(z.unheard.get(id) || [])]);
      }
    return x;
  }
  land(key) {
    for (const id of this.pocket.get(key)?.fields.keys() || []) this.landedAt.set(id, ++this.n);
    this.pocket.delete(key);
  }
  /* Whether a read (`reading`) ran while a write of Pocket's to task `id` was in flight, so the store throws it away
     for that task. Whether reply `rec` answers a write that crossed another on task `id`, so the store takes none of
     it there. Neither is Pocket's news of the task. */
  overlapped(id) {
    return [...this.pocket.values()].some(x => x.fields.has(id)) || (this.landedAt.get(id) || 0) > this.reading.n;
  }
  crossed(rec, id) {
    return !!rec.write?.crossed.get(id)?.size;
  }
  /* Op request `h` is sent. An op's try sets what its apply sets on each task it changes, with the values it gives the
     copy as the model has it. A write to a task outside them, such as its checklist's progress, joins it. */
  flyOp(h) {
    const e = h.e,
      m = this.model,
      own = typeof e.task === 'string' ? sync.taskOf(e.task.replace(/^pending-/, '')) : e.task;
    if (!this.pocket.has(e.id)) {
      for (const id of new Set([...opOf(e).on(e), own]))
        if (typeof id === 'number') {
          const t = m.copies.get(id) ?? m.bases.get(id) ?? { id },
            x = opOf(e).apply(clone(t), e),
            sets = new Set([...differ(t, x), ...differ({ id }, opOf(e).apply({ id }, e))]);
          this.fly(e.id, id, Object.fromEntries([...sets].map(k => [k, x[k]])));
        }
      this.fly(e.id, null, {});
    }
    if (h.id && h.method === 'PATCH' && h.id !== own) this.fly(e.id, h.id, JSON.parse(h.opts.body));
  }
  /* Vikunja made request `h`, which changed `fields` of its task. The store takes no reply of a write that crossed
     another, so a field it changed that its write doesn't set, as a repeating task's next date, is unknown to Pocket
     until a read. So is a field that a write crossing it sets to another value. */
  crossing(h, fields) {
    const x = h.write;
    if (!x || !h.id) return;
    const mine = x.fields.get(h.id) || {},
      unheard = fields.filter(k => !(k in mine) || typeof mine[k] === 'symbol');
    x.unheard.set(h.id, new Set([...(x.unheard.get(h.id) || []), ...unheard]));
    if (x.crossed.get(h.id)?.size) this.model.doubt(h.id, unheard);
    this.model.doubt(h.id, this.conflicts(h));
  }
  /* The fields of `fields` that Pocket's write `x` sets on task `id` that only Vikunja's reply can say, or that a write
     crossing it sets to another value. The store takes none of them, so they are no news. */
  clashing(x, id, fields) {
    const mine = x?.fields.get(id) || {};
    return Object.keys(fields).filter(
      k =>
        typeof mine[k] === 'symbol' ||
        [...(x?.crossed.get(id) || [])].some(y => {
          const f = y.fields.get(id) || {};
          return k in f && (typeof f[k] === 'symbol' || !same(f[k], fields[k]));
        }),
    );
  }
  // The fields request `h` changes that a write crossing its own sets to another value.
  conflicts(h) {
    const x = h.write,
      mine = x?.fields.get(h.id) || {};
    return touches(h).filter(
      k =>
        k in mine &&
        [...(x.crossed.get(h.id) || [])].some(y => k in y.fields.get(h.id) && !same(y.fields.get(h.id)[k], mine[k])),
    );
  }
  heldAt(i) {
    return this.held.length ? this.held[i % this.held.length] : null;
  }
  // Whether Vikunja has made held request `h`, or the relay will answer it from what it kept.
  made(h) {
    return !!h.res || (!!h.key && this.v.relayed.has(h.key));
  }
  // Vikunja makes held request `h` now. The relay answers a key it kept, with the time Vikunja first made it.
  async make(h) {
    if (h.res) return;
    // Deleting a task changes the related tasks of each task it is related to.
    const related = h.method === 'DELETE' && h.id && Object.values(this.v.tasks.get(h.id)?.related_tasks || {}).flat(),
      was = clone(this.v.tasks.get(h.id));
    h.res = await this.inner(h.url, h.opts);
    h.replayed = h.res.headers.get('Idempotent-Replayed') === 'true';
    h.at = h.replayed ? this.madeAt.get(h.key) : ++this.t;
    if (h.replayed) return;
    if (h.key) this.madeAt.set(h.key, h.at);
    if (h.e) this.lastMade.set(h.e.id, h.at);
    if (h.e && h.id) for (const k of touches(h)) this.madeField.set(`${h.e.id} ${h.id} ${k}`, h.at);
    if (h.id) for (const k of touches(h)) this.lastWrite.set(`${h.id} ${k}`, h.at);
    this.crossing(
      h,
      differ(was, this.v.tasks.get(h.id)).filter(k => CHECKED.includes(k)),
    );
    if (h.opts.write) h.opts.write.madeAt = h.at;
    if (h.e && related) for (const r of related) this.madeField.set(`${h.e.id} ${r.id} related_tasks`, h.at);
    // A field Vikunja changes that the op's answer doesn't carry, such as a position, is new to Pocket until it reads.
    const unseen = h.e && Object.entries(ALL).find(([n, s]) => (s.op ?? n) === h.e.op)?.[1].unseen;
    if (h.id && unseen) this.model.doubt(h.id, unseen);
    // A link changes the related tasks of both tasks, which only a read brings.
    if (h.id && /\/relations$/.test(h.url))
      for (const x of [h.id, JSON.parse(h.opts.body).other_task_id]) this.model.doubt(x, ['related_tasks']);
  }
  /* A refusal or an unknown answer stops op `e` before its answer, so Pocket's copy never hears what the op's earlier
     requests changed. Only a later read tells Pocket of those fields. */
  unheard(e) {
    if (!e) return;
    for (const k of this.madeField.keys()) {
      const [entry, id, field] = k.split(' ');
      if (entry === e.id) this.model.doubt(+id, [field]);
    }
  }
  // Vikunja refuses held request `h`, and changes nothing. The relay keeps the refusal. The fake reads `refuses` before
  // its first await, so only this request is refused.
  refuse(h) {
    this.v.refuses = () => 403;
    const res = this.inner(h.url, h.opts);
    this.v.refuses = () => null;
    return res;
  }
  // Reply `res` as Pocket gets it, with a task stamped with the reply's number (replyOf).
  async stamped(res, at, replayed, kind, h = null) {
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return new Response(text, { status: res.status, headers: res.headers });
    }
    if (kind && body && typeof body === 'object' && 'id' in body && 'title' in body) {
      this.replies.push({ at, kind, replayed, data: clone(body), write: h?.write });
      body[MADE] = this.replies.length - 1;
    }
    return new Response(JSON.stringify(body), { status: res.status, headers: res.headers });
  }
  replyOf(t) {
    const rec = t && this.replies[t[MADE]];
    if (!rec) throw new Error(`the store was given ${canon(t)}, which no reply of the fake Vikunja brought`);
    return rec;
  }
  entryOf(key) {
    const name = key.split(':')[0];
    return sync.all(ME.id).find(e => (e.key || e.id) === name) || null;
  }
  // Vikunja's answer to a request Pocket didn't make: the test's own read or change.
  async api(path, opts = {}) {
    const r = await this.inner(SERVER + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json' },
      body: opts.body && JSON.stringify(opts.body),
    });
    return r.ok ? r.json() : null;
  }
  // A read of tasks `ids` starts: Vikunja answers it now, and Pocket gets it when finishRead says.
  async startRead(ids, asked) {
    const at = started(),
      when = ++this.t;
    const list = (await Promise.all(ids.map(id => this.api('/tasks/' + id)))).filter(Boolean);
    for (const t of list) {
      this.replies.push({ at: when, kind: 'read', asked, data: clone(t) });
      t[MADE] = this.replies.length - 1;
    }
    this.reads.push({ at, list, asked, n: ++this.n });
  }
  // A read reaches Pocket, as a screen's load does: its tasks go into the store, then get rows.
  finishRead(i) {
    const [r] = this.reads.splice(i % this.reads.length, 1);
    this.reading = r;
    const list = putting(r.asked, r.at)(structuredClone(r.list));
    this.reading = null;
    for (const t of list) this.app.row(t);
  }
  // A direct save of edit `e` is sent once the saves before it have ended, and ends when its reply arrives, as saveTask
  // (actions.js) sends and answers it.
  save(e) {
    const run = this.saving.then(() => this.send(e));
    this.saving = run.catch(() => {});
    return run;
  }
  async send(e) {
    const write = writes({ [e.id]: e.fields }),
      mine = this.fly(e, e.id, e.fields);
    let got = null;
    try {
      const res = await this.gate(SERVER + '/tasks/' + e.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(e.fields),
        write: mine,
      });
      got = res.ok ? await res.json() : null;
    } catch {}
    write.end();
    this.land(e);
    this.edits.splice(this.edits.indexOf(e), 1);
    this.saveMade = mine.madeAt;
    this.answering = mine;
    try {
      this.app.change(x => {
        if (!got) return e.h.undo();
        x.made(e.id, e.fields, write);
        x.answer([got], TASK, write);
        e.h.ok();
      });
    } finally {
      this.saveMade = null;
      this.answering = null;
    }
  }
  // The store's copy of each task the test knows of. A write replaces a copy rather than changing it, so these stay
  // as they were.
  copiesNow() {
    return new Map(
      [...new Set([...this.model.copies.keys(), ...this.v.tasks.keys(), ...this.model.rows])].map(k => {
        const id = /^\d+$/.test(k) ? +k : k;
        return [id, copyOf(id)];
      }),
    );
  }
  /* A write of Vikunja's data (`rec`) into the copy of task `ev.id`. The model takes it when the store took it. A copy
     made where the row was made from a read keeps the changes Vikunja made to that. Then check 5 judges it. */
  wrote(ev) {
    const m = this.model,
      after = copyOf(ev.id),
      trust = trusted(ev.rec).filter(k => k in ev.rec.data);
    ev.at = ev.rec.at;
    ev.after = after;
    if (ev.thrown && !same(ev.before, after))
      this.broken.push(`check 5: ${ev.id}'s copy took a ${ev.via} that ran while another write to it was in flight`);
    else if (!same(ev.before, after))
      m.adopt(ev.id, ev.before, after, [
        { fields: Object.fromEntries(trust.map(k => [k, ev.rec.data[k]])), rec: ev.rec },
        ...(ev.before ? [] : [{ fields: m.bases.get(ev.id) || {} }]),
      ]);
    this.judge(ev);
  }
  /* Check 5: Vikunja's copy of a task only moves forward. A write that changes a field of the copy with data Vikunja
     made before Pocket's latest news of that field goes back. A reply the relay replays changes nothing in a copy
     Pocket has. A read that ran while a write of Pocket's to the task was in flight, and a reply to a write that
     crossed another, change nothing (`thrown`) and are no news. A KNOWN entry that meets the write excuses it, and
     relaxes the checks it names for the rest of the sequence. */
  judge(ev) {
    const m = this.model,
      tags = ('tag' in ev ? ev.tag : m.tags.get(ev.id)) || new Map(),
      /* Check 5 judges the fields check 4 compares, the same way. An op guesses the times Vikunja sets itself, such as
         done_at, so only a reply has them, and a list of people Vikunja gives as null is an op's []. */
      changed = differ(ev.before, ev.after).filter(
        k => CHECKED.includes(k) && !same(like(k, ev.before?.[k]), like(k, ev.after?.[k])),
      );
    const at = k => ev.fieldAt?.(k) ?? ev.at,
      older = changed.filter(k => tags.has(k) && at(k) < tags.get(k).at);
    Object.assign(ev, {
      changed,
      back: older.length > 0,
      replay: changed.length > 0 && !!ev.rec?.replayed && ev.before !== undefined,
    });
    this.wrote5 = true;
    const excused = this.known(ev),
      clashed = changed.filter(k => ev.skip?.includes(k));
    if (clashed.length)
      this.broken.push(`check 5: ${ev.id}'s copy took the ${clashed} of a change only a read can say (${ev.via})`);
    if ((ev.back || ev.replay) && !excused)
      this.broken.push(
        ev.back
          ? `check 5: ${ev.id}'s copy went back. ${ev.via === 'read' ? 'A read' : 'An answer'} (${ev.via}) wrote ${older.map(k => `${k} from ${at(k)} after Pocket had news of it from ${tags.get(k).at}`).join(', ')}`
          : `check 5: a reply the relay replayed changed the ${changed} of ${ev.id}'s copy (${ev.via})`,
      );
    /* Pocket's news of each field: a field of a reply that the copy now agrees with, and a field Pocket asked Vikunja
       to change that the copy now has (`asked`), unless only a read can say what Vikunja has there (`skip`). An op
       answered on a task Pocket has no copy of is news of the fields it changes. */
    if (m.forgotten.has(ev.id) || ev.thrown) return;
    const agrees = k => !!ev.after && same(ev.after[k], m.unrelated({ [k]: ev.rec ? ev.rec.data[k] : ev.asked[k] })[k]);
    const fields = ev.rec
      ? trusted(ev.rec).filter(k => k in ev.rec.data && agrees(k))
      : Object.keys(ev.asked || {}).filter(k => (ev.uncopied || agrees(k)) && !ev.skip?.includes(k));
    m.news(ev.id, fields, at, ev.via === 'read' ? 'read' : ev.uncopied ? 'uncopied' : 'answer');
    // A reply Vikunja made after a change it brings tells Pocket of the change.
    const unsure = m.unsure.get(ev.id);
    if (ev.rec && ev.after && unsure)
      for (const k of trusted(ev.rec))
        if (unsure.get(k) <= ev.at && same(like(k, ev.after[k]), like(k, ev.rec.data[k]))) unsure.delete(k);
  }
  // Whether a KNOWN entry meets event `ev`. Each one that does relaxes the fields it names, on each task it names.
  known(ev) {
    const m = this.model;
    let met = false;
    for (const k of KNOWN) {
      const relax = k.meets(ev, this);
      if (!relax) continue;
      met = true;
      m.met.add(k);
      for (const [id, fields] of relax) m.relaxed.set(id, new Set([...(m.relaxed.get(id) || []), ...fields]));
    }
    return met;
  }
  // Run `p` in the background. Commands wait for the app to stop working (settle), not for each promise.
  bg(p) {
    const q = Promise.resolve(p).catch(e => this.errors.push(e));
    this.busy.add(q);
    q.finally(() => this.busy.delete(q));
    return q;
  }
  // Run sending `p` in the background. An add box refreshes the outbox once its lines are sent (submitCapture), and
  // sendActs leaves that to it.
  sending(p) {
    return this.bg(Promise.resolve(p).then(() => this.app.refreshPending()));
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
  // Whether nothing waits to be sent or answered, and no read or edit runs.
  still() {
    return !this.acts().length && !this.held.length && !this.reads.length && !this.edits.length && !this.busy.size;
  }
  // The task a command names: a task's id, or the step, which is its entry's waiting id until Vikunja has made it.
  target(t) {
    return t === STEP ? (this.stepId ?? 'pending-' + STEP) : t;
  }
  async close() {
    this.closed = true;
    for (let i = 0; i < 100 && (this.busy.size || this.held.length); i++) {
      for (const h of this.held.splice(0)) h.no(new TypeError('Failed to fetch'));
      await tick();
    }
    globalThis.fetch = this.inner;
  }
}

// What the world starts with: the checklist read in full, as a screen loads it, and a step still being added to it.
async function open(clock) {
  const w = (world = new World(clock));
  await w.startRead([1, 2, 3], TASK_REACTIONS_COMMENTS);
  w.finishRead(0);
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

// The step still being added, as a checklist's screen shows it before Vikunja has made it (runView, runs.js).
const WAITING_STEP = {
  id: 'pending-' + STEP,
  title: 'Sweep up',
  done: false,
  done_at: null,
  assignees: [],
  reactions: {},
  comments: [],
};

/* Each check returns what broke it. 1: each row is the model's copy, then the waiting ops, then the edits, a row marked
   done is as it was marked, each copy is the model's, each field the store wrote comes from a reply or a change it was
   given, a task Pocket deleted is gone, and the step not yet made shows its waiting ops. 2: a row is the same object from one command to the next. 3: Vikunja made each key at most once.
   4 (matches): once nothing waits or runs, the copy of each task is Vikunja's. 5: what judge found. A field a KNOWN bug
   met in the sequence may have left wrong is skipped. */
function checks(w) {
  w.known({ via: 'sweep' });
  const out = w.broken.splice(0),
    m = w.model,
    app = w.app;
  if (w.wrote5) {
    ran('check 5', !m.relaxed.size);
    w.wrote5 = false;
  }
  if (w.errors.length) out.push(`the app threw: ${w.errors.map(e => e.stack || e).join('; ')}`);
  const fields = (id, a, b) => differ(a, b).filter(k => !m.relaxes(id, k));
  const rows = Object.keys(app.tasks).sort(),
    want = [...m.rows].sort();
  if (!same(rows, want)) out.push(`check 1: rows ${rows}, and the model has ${want}`);
  for (const k of rows) {
    const id = /^\d+$/.test(k) ? +k : k,
      row = app.tasks[k];
    if (w.seen.has(k) && w.seen.get(k) !== row) out.push(`check 2: ${k}'s row is a new object`);
    const f = m.frozen.get(id);
    if (f) {
      for (const field of fields(id, f.snap, row).filter(x => !f.touched.has(x)))
        out.push(
          `check 1: ${k} is marked done, and its ${field} changed from ${canon(f.snap[field])} to ${canon(row[field])}`,
        );
    } else if (!m.shown(id) || fields(id, row, m.shown(id)).length)
      out.push(`check 1: ${k}'s row is ${canon(row)}, and its copy, ops and edits give ${canon(m.shown(id))}`);
  }
  w.seen = new Map(rows.map(k => [k, app.tasks[k]]));
  const step = 'pending-' + STEP;
  if (w.stepId === null) {
    const shows = app.withOps(step, clone(WAITING_STEP)),
      should = m.waitingOn(step).reduce((t, a) => opOf(a).apply(t, a), clone(WAITING_STEP));
    if (fields(step, shows, should).length)
      out.push(`check 1: the step ${step} shows ${canon(shows)}, and its waiting ops give ${canon(should)}`);
  }
  for (const [id, c] of w.copiesNow()) {
    const want = m.copies.get(id);
    if (!c !== !want || fields(id, c, want).length)
      out.push(`check 1: ${id}'s copy is ${canon(c)}, and the replies taken give ${canon(want)}`);
  }
  for (const id of m.forgotten)
    if (copyOf(id) || app.tasks[id]) out.push(`check 1: Pocket deleted ${id}, and the store still has its copy or row`);
  const made = new Map();
  for (const r of w.v.requests) if (r.key && !r.replayed) made.set(r.key, (made.get(r.key) || 0) + 1);
  for (const [key, n] of made) if (n > 1) out.push(`check 3: Vikunja made ${key} ${n} times`);
  if (w.still()) out.push(...matches(w, false));
  return out;
}
/* Check 4: the copy of each task is Vikunja's, field by field for the fields Pocket reads. Unless `strict`, a field
   Vikunja changed since Pocket last heard of it is skipped. */
function matches(w, strict) {
  const out = [],
    m = w.model;
  let skipped = false;
  for (const id of new Set([...m.copies.keys(), ...w.v.tasks.keys()])) {
    const c = copyOf(id),
      t = w.v.tasks.get(id);
    if (!c) continue;
    /* Pocket hears of a delete only from its own delete's answer, and check 1 checks that those copies are gone. A
       delete stopped partway, or whose answer was unknown, leaves the copy of a task Vikunja deleted. */
    if (!t) {
      skipped = true;
      continue;
    }
    for (const k of CHECKED) {
      if (!(k in c)) continue;
      if (m.relaxes(id, k) || (!strict && m.unsure.get(id)?.has(k))) {
        skipped = true;
        continue;
      }
      if (!same(like(k, c[k]), like(k, t[k], w.v)))
        out.push(`check 4: ${id}'s copy has ${k} ${canon(like(k, c[k]))}, and Vikunja ${canon(like(k, t[k], w.v))}`);
    }
  }
  ran(strict ? 'check 4 after a read of every task' : 'check 4', !skipped);
  return out;
}
// A field as the copy and Vikunja are compared on: people, labels, reactions, comments and related tasks by their ids.
// Vikunja's related tasks leave out a task it has deleted, as its reads do.
function like(k, v, vikunja = null) {
  if (k === 'assignees' || k === 'labels' || k === 'comments') return (v || []).map(x => x.id);
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

/* ---------- the bugs not yet fixed ---------- */

/* Bugs the user hasn't decided on yet, as docs/design/single-code-paths.md numbers them under "Open bugs". Each entry
   says what is wrong, and `meets(ev, w)` says whether a write (ev, from judge) is that bug, and which fields of which
   tasks it may leave wrong ([[id, fields]]). Meeting it excuses the write, and the checks skip those fields for the
   rest of the sequence. An entry no sequence meets in a run of 1,000 fails the test, so a fixed bug's entry goes. */
const KNOWN = [
  /* A tick or a skip removes the user's other mark from the copy (marked, ops/shown.js), but its stage only adds its
     own, so Vikunja keeps both. A step the user skipped and a teammate unticked in the web app shows Done, and its
     ⏭️ stays in Vikunja. */
  {
    bug: 8,
    meets(ev, w) {
      const rs = ev.via === 'apply' && MARKS.includes(ev.a.op) && w.v.tasks.get(ev.id)?.reactions;
      const mine = r => (rs?.[r] || []).some(u => u.id === ME.id);
      return mine(DONE_MARK) && mine(SKIP_MARK) && [[ev.id, ['reactions']]];
    },
  },
];

/* ---------- the commands ---------- */

class Command {
  check(m) {
    return this.can(m);
  }
  name() {
    return this.constructor.name;
  }
  async run(m, w) {
    count(STATS.commands, (w.draining ? 'drain: ' : '') + this.name());
    await this.act(w, m);
    await w.settle();
    // An op's try that a stage ended, as a claim someone else took ends it, has no request left on its way.
    for (const k of w.pocket.keys()) if (typeof k === 'string' && !w.held.some(h => h.e?.id === k)) w.land(k);
    const broken = checks(w);
    if (broken.length) throw new Error(`${this} broke a check:\n  ${broken.join('\n  ')}`);
  }
}
/* The fields of `sample`'s op on task `id`. A delete deletes the task and its subtasks as Vikunja has them, deepest
   first, leaving out a subtask that has another parent, as the app reads them before it asks (taskTree). */
function fieldsOn(sample, id, w) {
  const copy = id => w.model.copies.get(id),
    live = list => (list || []).map(s => s.id).filter(x => w.v.tasks.has(x)),
    rel = (id, kind) => live(w.v.tasks.get(id)?.related_tasks?.[kind]);
  const tree = (id, from = null) =>
    from !== null && rel(id, 'parenttask').some(p => p !== from)
      ? []
      : [...rel(id, 'subtask').flatMap(s => tree(s, id)), id];
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
  const s = ALL[name],
    id = w.target(t);
  if (typeof id === 'string')
    return typeof s.fields !== 'function' && !s.queue && !('ids' in s.fields) && !('up' in s.fields);
  return !!w.app.tasks[id] && !w.app.beingDeleted(id) && w.app.leaving[id] !== 'deleted';
}
class Queue extends Command {
  constructor(name, t) {
    super();
    Object.assign(this, { sample: name, t });
  }
  can(m) {
    return canQueue(m.w, this.sample, this.t);
  }
  async act(w) {
    const s = ALL[this.sample],
      list = fieldsOn(s, w.target(this.t), w).map(f => ({ id: uuid7(), ...f })),
      f = list.at(-1);
    if (opOf(f).invert) w.undos.push(f);
    w.sending(s.queue ? s.queue(w.app, f) : w.app.actAll(list));
  }
  toString() {
    return `Queue(${this.sample} on ${this.t})`;
  }
}
// Send what waits, until a write is held. `retry` sends a change whose reply was lost, and the relay answers it from
// what it kept.
class Send extends Command {
  constructor(retry) {
    super();
    this.retry = retry;
  }
  can(m) {
    const acts = m.w.acts().filter(e => !e.failed && !held(e));
    return !m.w.held.some(h => h.key) && acts.some(e => !!e.sent === this.retry);
  }
  async act(w) {
    const last = w
      .acts()
      .filter(e => !held(e))
      .at(-1);
    w.online = true;
    w.app.offline = false;
    w.sending(w.app.sendActs(last.id));
    await w.settle();
    w.online = false;
  }
  name() {
    return this.retry ? 'Retry' : 'Send';
  }
  toString() {
    return this.name();
  }
}
/* A held write (the i-th) is answered: its reply arrives, is lost on its way, comes back unknown (the relay can't say
   whether Vikunja made it), or Vikunja refuses it. Vikunja makes it first, unless Reach already has. */
class Answer extends Command {
  constructor(how, i) {
    super();
    Object.assign(this, { how, i });
  }
  can(m) {
    const h = m.w.heldAt(this.i);
    return !!h && (this.how !== 'refused' || !m.w.made(h)) && (this.how !== 'unknown' || !!h.key);
  }
  async act(w, m) {
    const h = w.heldAt(this.i);
    w.held.splice(w.held.indexOf(h), 1);
    if (this.how !== 'arrives' && h.e) w.land(h.e.id);
    if (this.how === 'refused') {
      w.unheard(h.e);
      return h.ok(await w.refuse(h));
    }
    await w.make(h);
    if (this.how === 'arrives') return h.ok(await w.stamped(h.res, h.at, h.replayed, replyKind(h.method, h.url), h));
    if (this.how === 'lost') {
      /* A direct save Vikunja made, whose reply is lost, fails on the row, and Pocket doesn't hear of its fields. An
         op's reply sent again is replayed, which the store doesn't take where it has a copy, so a field the request
         changed that the op's change doesn't give, as a repeating task's next date, is unknown until a read. */
      if (!h.key && h.id) m.doubt(h.id, Object.keys(JSON.parse(h.opts.body)));
      if (h.key && h.id) m.doubt(h.id, [...(h.write?.unheard.get(h.id) || [])]);
      return h.no(new TypeError('network error'));
    }
    w.unknownKeys.add(h.key);
    w.unheard(h.e);
    h.ok(unknownReply());
  }
  name() {
    return `Answer(${this.how})`;
  }
  toString() {
    return `Answer(${this.how}, ${this.i})`;
  }
}
// Vikunja makes a held write (the i-th), and its reply stays on its way.
class Reach extends Command {
  constructor(i) {
    super();
    this.i = i;
  }
  can(m) {
    const h = m.w.heldAt(this.i);
    return !!h && !h.res;
  }
  async act(w) {
    await w.make(w.heldAt(this.i));
  }
  toString() {
    return `Reach(${this.i})`;
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
  async act(w) {
    const ids = [...new Set(this.ts.map(t => w.target(t)))].filter(id => typeof id === 'number');
    await w.startRead(ids, this.full ? TASK_REACTIONS_COMMENTS : TASK);
  }
  toString() {
    return `StartRead(${this.ts}${this.full ? ', with reactions and comments' : ''})`;
  }
}
class FinishRead extends Command {
  constructor(i) {
    super();
    this.i = i;
  }
  can(m) {
    return m.w.reads.length > 0;
  }
  async act(w) {
    w.finishRead(this.i);
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
    w.edits.push({ id, fields: this.fields, h, sent: false });
  }
  toString() {
    return `StartEdit(${this.t}, ${canon(this.fields)})`;
  }
}
// A direct save (the i-th not yet sent) sends its PATCH. Answer lets its reply arrive.
class SaveEdit extends Command {
  constructor(i) {
    super();
    this.i = i;
  }
  can(m) {
    return m.w.edits.some(e => !e.sent);
  }
  async act(w) {
    const list = w.edits.filter(e => !e.sent),
      e = list[this.i % list.length];
    e.sent = true;
    w.bg(w.save(e));
  }
  toString() {
    return `SaveEdit(${this.i})`;
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
// Restore on a deleted row's gap: the delete held for it leaves the outbox (undoDelete).
class Restore extends Command {
  constructor(t) {
    super();
    this.t = t;
  }
  can(m) {
    return m.w.app.leaving[m.w.target(this.t)] === 'deleted';
  }
  async act(w) {
    w.bg(w.app.unmark(w.target(this.t)));
  }
  toString() {
    return `Restore(${this.t})`;
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
/* Vikunja makes the step being added, under the checklist, and its ops are filed under its id, as sendStep does. It
   waits for the outbox's lock, as sendStep does. */
class StepMade extends Command {
  can(m) {
    return m.w.stepId === null && !m.w.making;
  }
  async act(w) {
    w.making = true;
    w.bg(
      sync.lock(async () => {
        const t = await w.api('/projects/5/tasks', { method: 'POST', body: { title: 'Sweep up' } });
        w.t++;
        await w.api('/tasks/1/relations', { method: 'POST', body: { other_task_id: t.id, relation_kind: 'subtask' } });
        w.t++;
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
    w.t++;
    m.doubt(id, [this.field]);
  }
  toString() {
    return `Teammate(${this.t}, ${this.field})`;
  }
}
// A teammate makes a step a subtask of step 2 as well, in the web app, so it has two parents.
class SecondParent extends Command {
  constructor(t) {
    super();
    this.t = t;
  }
  can(m) {
    const v = m.w.v,
      id = m.w.target(this.t);
    return v.tasks.has(id) && v.tasks.has(2) && !v.tasks.get(2).related_tasks?.subtask?.some(s => s.id === id);
  }
  async act(w, m) {
    const id = w.target(this.t),
      up = w.v.tasks.get(2),
      t = w.v.tasks.get(id);
    ((up.related_tasks ||= {}).subtask ||= []).push({ id });
    ((t.related_tasks ||= {}).parenttask ||= []).push({ id: 2 });
    w.t++;
    for (const x of [2, id]) m.doubt(x, ['related_tasks']);
  }
  toString() {
    return `SecondParent(${this.t})`;
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

// The step is named twice as often, because ops on a step not yet made, and a read that brings it, find bug 3.
const target = fc.constantFrom(1, 2, 3, STEP, STEP);
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
// fast-check picks each entry equally often, and skips a command that can't run, so the common ones are listed again.
const queue = fc.tuple(fc.constantFrom(...Object.keys(ALL)), target).map(([n, t]) => new Queue(n, t)),
  answer = fc
    .tuple(fc.constantFrom('arrives', 'arrives', 'lost', 'unknown', 'refused'), fc.nat(3))
    .map(([how, i]) => new Answer(how, i));
const read = fc
  .tuple(fc.uniqueArray(target, { minLength: 1, maxLength: 4 }), fc.boolean())
  .map(([ts, f]) => new StartRead(ts, f));
const COMMANDS = [
  queue,
  queue,
  queue,
  queue,
  fc.constant(new Send(false)),
  fc.constant(new Send(false)),
  fc.constant(new Send(false)),
  fc.constant(new Send(true)),
  answer,
  answer,
  answer,
  answer,
  answer,
  fc.nat(3).map(i => new Reach(i)),
  fc.nat(5).map(i => new Drop(i)),
  fc.nat(5).map(i => new Undo(i)),
  read,
  read,
  read,
  fc.nat(5).map(i => new FinishRead(i)),
  fc.nat(5).map(i => new FinishRead(i)),
  fc.tuple(target, fc.constantFrom(...EDITS)).map(([t, f]) => new StartEdit(t, f)),
  fc.nat(3).map(i => new SaveEdit(i)),
  fc.tuple(target, fc.constantFrom('done', 'open', 'deleted')).map(([t, k]) => new Mark(t, k)),
  fc.constant(new ClearBatch()),
  target.map(t => new Restore(t)),
  fc.constant(new StepMade()),
  fc.tuple(target, fc.constantFrom(...Object.keys(CHANGES))).map(([t, f]) => new Teammate(t, f)),
  fc.constantFrom(3, STEP).map(t => new SecondParent(t)),
  fc.constantFrom(1000, 30000, 61000).map(ms => new Wait(ms)),
];

/* Send and answer everything still waiting: send each edit, make the step, cancel what Vikunja refused, send what
   waits, and once Vikunja has made every write on its way, let their replies arrive in the order `picks` gives. What
   takes the outbox's lock waits until no op's reply is on its way. Then finish each read, which is older than every
   answer. Then check 4 runs, and once more after a read of every task, with nothing skipped but what a KNOWN bug
   relaxes. */
async function drain(w, picks) {
  w.draining = true;
  const m = w.model,
    run = async c => {
      if (c.check(m)) await c.run(m, w);
    };
  for (let n = 0; ; n++) {
    if (n > 200) throw new Error('the outbox never emptied');
    const list = w.acts(),
      failed = list.findIndex(e => e.failed),
      ready = !w.held.some(h => h.key);
    if (w.edits.some(e => !e.sent)) await run(new SaveEdit(0));
    else if (ready && w.stepId === null) await run(new StepMade());
    else if (ready && failed >= 0) await run(new Drop(failed));
    else if (ready && list.some(e => !e.sent && !held(e))) await run(new Send(false));
    else if (ready && list.some(e => e.sent && !held(e))) await run(new Send(true));
    else if (w.held.some(h => !h.res)) await run(new Reach(w.held.findIndex(h => !h.res)));
    else if (w.held.length) await run(new Answer('arrives', picks[n % picks.length] ?? 0));
    else if (w.reads.length) await run(new FinishRead(0));
    else if (!w.still()) {
      await run(new Wait(61000));
      await run(new ClearBatch());
    } else break;
  }
  await run(new ClearBatch());
  const broken = matches(w, false);
  if (broken.length) throw new Error(`once everything was sent:\n  ${broken.join('\n  ')}`);
  await w.startRead([...w.v.tasks.keys()], TASK_REACTIONS_COMMENTS);
  w.finishRead(0);
  await w.settle();
  const read = [...checks(w), ...matches(w, true)];
  if (read.length) throw new Error(`once every task was read again:\n  ${read.join('\n  ')}`);
}

test('the store shows each task as its copy, then the waiting ops, then the edits, whatever order things happen in', async t => {
  const seed = process.env.FC_SEED ? +process.env.FC_SEED : process.env.CI ? 6040 : undefined;
  await fc.assert(
    fc.asyncProperty(
      fc.commands(COMMANDS, {
        maxCommands: 60,
        size: 'max',
        replayPath: process.env.FC_REPLAY,
      }),
      fc.array(fc.nat(9), { minLength: 1, maxLength: 20 }),
      async (cmds, picks) => {
        const w = await open(t.mock.timers);
        try {
          const broken = checks(w);
          if (broken.length) throw new Error(`the world broke a check as it opened:\n  ${broken.join('\n  ')}`);
          await fc.asyncModelRun(() => ({ model: w.model, real: w }), cmds);
          await drain(w, picks);
        } finally {
          for (const k of w.model.met) count(STATS.met, k.bug);
          await w.close();
        }
      },
    ),
    { numRuns: RUNS, seed, path: process.env.FC_PATH, endOnFailure: false },
  );
  if (process.env.FC_STATS) {
    const all = [...STATS.commands].sort(([a], [b]) => (a < b ? -1 : 1));
    t.diagnostic(`commands run: ${all.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    t.diagnostic(`sequences meeting each KNOWN bug: ${KNOWN.map(k => `${k.bug}: ${STATS.met.get(k.bug) || 0}`)}`);
    t.diagnostic(`checks run: ${[...STATS.checks].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  if (RUNS >= 1000)
    assert.deepEqual(
      KNOWN.filter(k => !STATS.met.has(k.bug)).map(k => `no sequence met bug ${k.bug} any more. Remove it from KNOWN.`),
      [],
    );
});
