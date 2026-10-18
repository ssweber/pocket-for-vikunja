/* A randomized test of the store (src/js/app/tasks.js). fast-check generates sequences of commands on a few tasks: ops
   queued, sent, answered in any order, refused, lost and undone, reads finishing late, rows marked as leaving, a
   teammate's changes in the web app, sweeps that drop the copies no kept screen needs, and reloads. Each sequence then sends
   and answers everything still waiting, and reads every task. The checks after each command compare the app with a
   model made from the fake Vikunja's replies, each op's `apply` and the outbox's database, never from the store's own
   functions. A failure prints the seed and the shortest sequence that breaks a check. */
import './browser.mjs';
import { stores, used } from './outbox-db.mjs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { fakeVikunja } from './fake.mjs';
import { CREATED, TASK, TASK_REACTIONS_COMMENTS } from '../../src/js/app/tasks.js';
import { older, uuid7 } from '../../src/js/sync.js';
import { checklist, line, ME, SAMPLES } from './samples.mjs';

/* A reload opens the other of two pages, each its own copy of the app's modules, as a new page holds nothing of the
   page before it. A module imported with ?page=<n> imports the app's modules with it too. The pages share the fake
   Vikunja, the outbox's database and localStorage. Two pages, used in turn, keep the memory a run takes bounded. */
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context),
      page = context.parentURL && new URL(context.parentURL).searchParams.get('page');
    return page && r.url.includes('/src/js/') && !r.url.includes('?') ? { ...r, url: `${r.url}?page=${page}` } : r;
  },
});
const pick = (part, ...names) => Object.fromEntries(names.map(n => [n, part[n]]));
async function loadPage(n) {
  const from = path => import(new URL(`${path}?page=${n}`, import.meta.url)),
    [fake, tasks, acts, sending, outbox, runs, actions, leaving, s, ops] = await Promise.all(
      [
        './fake.mjs',
        ...[
          ...['app/tasks', 'app/acts', 'app/sending', 'app/outbox', 'app/runs', 'app/actions', 'app/leaving'],
          ...['sync', 'ops/index'],
        ].map(p => `../../src/js/${p}.js`),
      ].map(from),
    );
  await s.sync.ready;
  return {
    component: fake.component,
    ...pick(tasks, 'copyOf', 'putting', 'started'),
    ...pick(s, 'sync', 'held'),
    ops,
    ...pick(ops, 'OPS', 'opOf'),
    parts: [
      ...[tasks, acts, sending, outbox, runs].map(m => m.default),
      pick(
        actions.default,
        ...['removeTask', 'holdDelete', 'undoDelete', 'sendHeld', 'deleteNow', 'deleteOf', 'parentIdOf'],
        ...['addAssignee', 'removeAssignee', 'addLabelTo', 'removeLabelFrom', 'sendSet'],
      ),
      leaving.default,
    ],
  };
}
const PAGES = [await loadPage(1), await loadPage(2)];
// The page open now: its store's copies and reads, its outbox and ops, and the parts its component is made from.
let page = 0,
  component,
  copyOf,
  putting,
  started,
  sync,
  held,
  ops,
  OPS,
  opOf,
  parts;
const usePage = i => {
  page = i;
  ({ component, copyOf, putting, started, sync, held, ops, OPS, opOf, parts } = PAGES[i]);
};
usePage(0);
/* CI=1 fixes the seed. FC_RUNS sets the number of sequences, and FC_SEED a seed to run again. FC_PATH and FC_REPLAY
   replay a failure's path and replayPath at once. FC_STATS=1 prints how often each command ran, each KNOWN bug was
   met, and checks 4 and 5 ran with nothing skipped. */
let later = 0; // the latest time a sequence reached
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
    [/\/labels(\/\w+)?$/, 'labels'],
    [/\/position$/, 'position'],
    [/\/relations|\/duplicate$/, 'related_tasks'],
  ])
    if (re.test(path)) return [k];
  if (h.method !== 'PATCH') return [];
  const body = Object.keys(JSON.parse(h.opts.body));
  return body.includes('done') ? [...body, 'done_at'] : body;
}
// The other task a link, or taking one out, changes (POST /tasks/:id/relations, DELETE .../relations/subtask/:other).
const otherOf = h => {
  const cut = new URL(h.url).pathname.match(/\/relations\/\w+\/(\d+)$/);
  if (cut) return [+cut[1]];
  return /\/relations$/.test(h.url) ? [JSON.parse(h.opts.body).other_task_id] : [];
};
// What kind of reply a write gets that brings a task, or null.
const replyKind = (method, url) =>
  method === 'PATCH' ? 'patch' : method === 'POST' && /\/projects\/\d+\/tasks$/.test(url) ? 'create' : null;

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
    this.leaving = new Map(); // task id -> its mark
    this.frozen = new Map(); // task id -> a row marked done, as it was marked
    this.settled = new Set(); // ops answered, still in the outbox
    this.unsure = new Map(); // task id -> field -> when Vikunja changed it without Pocket being told
    this.relaxed = new Map(); // task id -> the fields a KNOWN bug met in this sequence may have left wrong
    this.met = new Set(); // the KNOWN entries met in this sequence
    this.missing = new Set(); // tasks Vikunja answered with 404, forgotten once no outbox entry points to them
  }
  // A new page holds none of the old page's copies, rows, marks or news.
  reload() {
    for (const k of ['copies', 'bases', 'tags', 'leaving', 'frozen']) this[k] = new Map();
    for (const k of ['forgotten', 'rows', 'settled', 'missing']) this[k] = new Set();
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
    for (const m of [this.bases, this.frozen]) m.delete(id);
    this.rows.delete(String(id));
  }
  // Deleted tasks leave every list of related tasks, as Vikunja's reads leave them out.
  forgetTree(ids) {
    for (const id of ids) this.gone(id);
    for (const m of [this.copies, this.bases]) for (const [id, t] of m) m.set(id, this.unrelated(t));
  }
  leave(id, kind) {
    const row = this.w.app.tasks[id];
    if (kind === 'done' && this.leaving.get(id) !== 'done' && row) this.frozen.set(id, clone(row));
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
  // Task `id` as its rows should show it: Vikunja's copy, then the waiting ops in order.
  shown(id) {
    const b = this.copies.get(id) ?? this.bases.get(id);
    return b ? this.waitingOn(id).reduce((t, a) => opOf(a).apply(t, a), b) : null;
  }
  // The ids the outbox's entries point to, from the outbox's database, a waiting step's as its id once it is made.
  pointed() {
    const out = new Set(),
      real = id => (typeof id === 'string' ? (sync.taskOf(id.replace(/^pending-/, '')) ?? id) : id);
    for (const e of stores.get('outbox').values())
      if (e.user === ME.id)
        for (const id of [...(e.kind === 'act' && OPS[e.op] ? opOf(e).on(e) : []), e.task, e.taskId])
          if (id != null) out.add(String(real(id)));
    return out;
  }
  // A task Vikunja answered with 404 is forgotten once no outbox entry points to it. The test never opens the sheet.
  letGo() {
    const held = this.pointed(),
      ids = [...this.missing].filter(id => !held.has(String(id)));
    for (const id of ids) this.missing.delete(id);
    if (ids.length) this.forgetTree(ids);
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
  // A read that passed straight through ends as the store takes it.
  read(w, fn, list, asked, at) {
    // The copies kept on the phone, which a new page reads in as it sweeps, are no news of Vikunja.
    if (at === 0) {
      const before = w.copiesNow();
      fn(list, asked, at);
      for (const t of list) w.model.adopt(t.id, before.get(t.id), copyOf(t.id), [{ fields: t }]);
      return;
    }
    const before = w.copiesNow(),
      r = w.reading,
      end = r?.end ?? ++w.seq,
      span = t => [r?.start ?? w.replyOf(t).start, end],
      thrown = new Map(list.map(t => [t.id, w.overlaps(t.id, ...span(t))]));
    fn(list.map(strip), asked, at);
    for (const t of list) {
      const rec = w.replyOf(t),
        excused = !thrown.get(t.id) && w.opsOn(t.id, ...span(t));
      w.wrote({ via: 'read', id: t.id, rec, before: before.get(t.id), asked, thrown: thrown.get(t.id), excused });
      if (!thrown.get(t.id)) w.taken(t.id, rec, ...span(t));
    }
  },
  answer(w, fn, list, asked, from) {
    const before = w.copiesNow();
    fn(list.map(strip), asked, from);
    for (const t of list) {
      const rec = w.replyOf(t);
      w.wrote({ via: 'answer', id: t.id, rec, before: before.get(t.id), asked, thrown: w.crossed(rec, t.id) });
    }
  },
  /* A change Vikunja made, as Pocket asked for it: a checklist's progress an op wrote, or a step an op made. Its
     request is the last write to the task whose reply Pocket got (delivered), and the change is judged with the time
     Vikunja made it. */
  made(w, fn, id, from, given) {
    const m = w.model,
      before = w.copiesNow().get(id),
      fields = Object.fromEntries(
        Object.entries(given ?? from.fields?.get(id) ?? {}).filter(([, v]) => typeof v !== 'symbol'),
      );
    fn(id, from, given);
    if (m.forgotten.has(id)) return;
    if (!before) {
      if (m.bases.has(id)) m.bases.set(id, { ...m.bases.get(id), ...clone(fields) });
      return;
    }
    const after = copyOf(id),
      h = w.delivered(id);
    m.adopt(id, before, after, [{ fields }]);
    w.judge({ via: 'made', id, at: h?.at ?? w.t, before, after, asked: fields, vikunja: h?.after });
  },
  /* An op's answer: its apply goes into each copy, then Vikunja's reply about its own task, and a deleted task leaves
     every list. Each field the store took from the apply is judged with the time Vikunja made the op's last request
     that changed that field of that task (madeField). The reply is judged with its own time, against Pocket's news of
     the task before the answer, since the apply's news isn't about the fields the reply brings. An op that sent no
     request changed nothing in Vikunja. It sent none because its stage read the task and found Vikunja had its change
     already, as an Undo of a change a teammate made too, so its apply is news, as of now, of the fields Vikunja has as
     the apply leaves them. */
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
      at = w.lastMade.get(a.id) ?? w.t;
    fn(a, from, reply && { ...reply, task: strip(got) }, posted);
    m.settled.add(a.id);
    if (op.deletes(a).length) m.forgetTree(op.deletes(a));
    for (const id of new Set([...op.on(a), ...(own ? [own] : [])])) {
      if (m.forgotten.has(id)) continue;
      // A task the op deleted leaves every list of related tasks (forgetTree), which is no news of the op's apply.
      const was = before.get(id),
        b = was && m.unrelated(was),
        fieldAt = k => w.madeField.get(`${a.id} ${id} ${k}`)?.at ?? at,
        vikunja = Object.fromEntries(
          [...w.madeField].filter(([k]) => k.startsWith(`${a.id} ${id} `)).map(([k, x]) => [k.split(' ')[2], x.value]),
        );
      if (!b) {
        const uncopied = !m.bases.has(id) && own !== id;
        if (m.bases.has(id) && op.on(a).includes(id)) m.bases.set(id, m.applied(m.bases.get(id), a, posted));
        const x = m.applied({ id }, a, posted),
          asked = Object.fromEntries(differ({ id }, x).map(k => [k, x[k]]));
        if (uncopied && w.lastMade.has(a.id))
          w.judge({ via: 'apply', id, at, a, before: b, after: undefined, uncopied, fieldAt, asked });
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
      const t = w.v.tasks.get(id),
        asked = Object.fromEntries(
          differ(b, applied)
            .filter(k => w.lastMade.has(a.id) || (t && same(like(k, applied[k]), like(k, t[k]))))
            .map(k => [k, applied[k]]),
        );
      w.judge({ via: 'apply', id, at, a, before: b, after: mid, fieldAt, asked, vikunja });
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
  leave(w, fn, id, kind) {
    w.model.leave(id, kind);
    return fn(id, kind);
  },
  // The outbox changed. An op that stops waiting, refused or gone, has stopped waiting for its requests (abandon).
  keyOps(w, fn) {
    w.abandon();
    fn();
    w.model.letGo();
  },
  lost(w, fn, id) {
    fn(id);
    w.model.missing.add(id);
    w.model.letGo();
  },
  forgetLost(w, fn) {
    fn();
    w.model.letGo();
  },
  /* The sweep drops the copy and the row of each task not in `keep`. Check 7: it never drops the copy of a task an
     outbox entry points to, or of a task the kept screen shows. Pocket's news of a task dropped stays (tags). */
  prune(w, fn, keep) {
    const m = w.model,
      must = new Set([...m.pointed(), ...[...(w.screen || [])].map(String)]),
      had = [...w.copiesNow()].filter(([, c]) => c).map(([id]) => id);
    fn(keep);
    for (const id of had)
      if (must.has(String(id)) && !copyOf(id))
        w.broken.push(`check 7: the sweep dropped the copy of ${id}, which the outbox or the kept screen needs`);
    for (const id of new Set([...m.copies.keys(), ...m.bases.keys(), ...[...m.rows].map(Number)]))
      if (Number.isInteger(id) && !keep.has(id)) {
        for (const x of [m.copies, m.bases, m.frozen, m.leaving]) x.delete(id);
        m.rows.delete(String(id));
      }
  },
  offTasks(w, fn, a) {
    w.model.settled.add(a.id);
    return fn(a);
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
/* One sequence's world. A write Pocket sends waits in `held` until a command lets Vikunja make it (Reach), answer it
   (Answer), or refuse it. A key the relay answered as unknown is answered that way again. Reads pass straight through.
   `t` is the fake Vikunja's log: it counts each request Vikunja answers and each change a teammate makes. `seq`
   orders when each request reaches the fake Vikunja, when Vikunja makes it, and when its reply leaves, and when each
   read starts and ends, so the checks can tell which of Pocket's writes were in flight while a read ran. */
class World {
  constructor(clock) {
    // Each page's timer for the rows that look waiting is cleared while the clock still knows it.
    for (const p of PAGES) if (p.app) Object.assign(p.app, { pending: [] }).markSlow();
    for (const s of stores.values()) s.clear();
    localStorage.clear(); // the screens and copies the last sequence kept on the phone
    sync.entries = new Map();
    for (const k of ['volatile', 'bytes', 'claimed', 'held']) sync[k].clear();
    clock.reset();
    // The time never goes back from one sequence to the next, as the store's clock counts on it across pages.
    clock.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: (later = Math.max(later, START) + 1000) });
    this.clock = clock;
    this.v = fakeVikunja(checklist());
    this.v.labels.push(LABEL, MOP);
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
      undos: [],
      stepId: null,
      seen: new Map(),
      replies: [], // what each reply said: {at, kind, replayed, asked, data}
      madeAt: new Map(), // key -> when Vikunja made it
      lastMade: new Map(), // entry id -> when Vikunja made its latest request
      // 'entry task field' -> {at, value}: when Vikunja made the entry's latest request that changed the field, and the
      // value it left there
      madeField: new Map(),
      seq: 0,
      writes: [], // each write request of Pocket's, as it reached the fake Vikunja (gate)
      late: [], // the writes Pocket gave up on before Vikunja made them (Answer late)
      ops: new Map(), // op entry id -> {e, spans}: from its first request in a try until it stopped waiting (abandon)
      reading: null, // the read finishing
      broken: [], // what check 5 found during the command
      wrote5: false, // whether the command wrote any of Vikunja's data
      pruned: [], // the ops a fold took out of the outbox (prune)
    });
    globalThis.fetch = (url, opts = {}) => this.gate(url, opts);
    this.model = new Model(this);
    this.mount();
  }
  // Open the app on the page in use. Only its writes tell the model.
  mount() {
    const app = component(...parts),
      w = this;
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
      notesRefused() {},
      // The commands send. Nothing sends on its own.
      flush: async () => {},
      // Vikunja refuses the search for who can see the project, so a line's person is assigned and Vikunja decides.
      canSee: async () => null,
      findUser: async name => ({ id: 7, username: name }),
      loadLabels: async () => (app.labels = clone(this.v.labels)),
    });
    Object.defineProperty(app, 'toast', { value: {} });
    this.app = PAGES[page].app = app;
    const change = app.change;
    app.change = function (fn) {
      w.activity++;
      return w.app === app ? change.call(this, writers => fn(spying(w, writers))) : change.call(this, fn);
    };
    const fold = app.fold;
    app.fold = async function (entries) {
      const before = w.acts().map(clone),
        given = entries.map(clone);
      await fold.call(this, entries);
      w.prune(before, given);
    };
  }
  /* Pocket reloads. Vikunja makes each write on its way, whose reply the old page loses, and each request Pocket gave
     up on. Or, with `cut`, the connection drops first, and Vikunja never gets any of them. A read the old page started
     never finishes. The new page opens on the outbox and the claims as the database has them, with nothing in memory,
     and loads the checklist's screen. */
  async reload(cut) {
    while (this.held.length || this.late.length) {
      for (const h of this.held.splice(0)) {
        if (!cut) await this.make(h);
        this.deliver(h);
        h.no(new TypeError(cut ? 'Failed to fetch' : 'network error'));
      }
      for (const h of this.late.splice(0))
        if (!cut) await this.make(h);
        else if (!h.res) h.done = ++this.seq;
      await this.settle();
    }
    this.reads = [];
    this.app.user = null;
    this.clock.setTime(Date.now() + 1000); // a reload takes a moment
    usePage(1 - page);
    this.mount();
    for (const k of ['volatile', 'bytes', 'claimed', 'held']) sync[k].clear();
    await sync.reload();
    for (const c of await sync.tx(['claims'], 'readonly', s => s('claims').getAll())) sync.claimed.set(c.id, c);
    this.model.reload();
    Object.assign(this, { undos: [], seen: new Map() });
    this.app.refreshPending();
    await this.startRead([1, 2, 3, this.stepId ?? 1], TASK_REACTIONS_COMMENTS);
    this.finishRead(this.reads.length - 1);
  }
  /* Check 6, as a fold takes ops out of the outbox. A fold takes out an op not yet sent (x) for a new op on its task
     (e). If e stays, it must leave the task as x and e would one after the other. If e goes too, the two together must
     leave the task as it was before x, unless x alone changed nothing, which Pocket never queues. Each op taken out is
     kept, to check that Vikunja never makes a request of it (checks). */
  prune(before, given) {
    const m = this.model,
      now = new Set(this.acts().map(e => e.id)),
      gone = before.filter(x => !now.has(x.id)),
      task = x => (typeof x.task === 'string' ? (sync.taskOf(x.task.replace(/^pending-/, '')) ?? x.task) : x.task),
      apply = (t, a) => opOf(a).apply(clone(t), a),
      // Lists compare as sets, since an op that puts an item back adds it at the end.
      sorted = (k, v) => {
        const x = like(k, v),
          sort = l => [...l].sort();
        if (Array.isArray(x)) return sort(x);
        return k === 'related_tasks' ? Object.fromEntries(Object.entries(x).map(([r, l]) => [r, sort(l)])) : x;
      },
      // An untick and a tick of a task a teammate ticked cancel out without the user's ✅, which is no loss.
      changes = (a, b) => CHECKED.filter(k => k !== 'reactions' && !same(sorted(k, a?.[k]), sorted(k, b?.[k])));
    this.pruned.push(...gone);
    for (const x of gone.filter(x => !given.some(e => e.id === x.id))) {
      const id = task(x),
        e = given.find(e => task(e) === id),
        copy = typeof id === 'string' ? clone(WAITING_STEP) : (m.copies.get(id) ?? m.bases.get(id));
      if (!e || !copy) continue;
      const t = m
          .waitingIn(before, sync.held, id)
          .filter(y => older(y, x) < 0)
          .reduce(apply, copy),
        both = apply(apply(t, x), e);
      ran('check 6', true);
      if (now.has(e.id)) {
        const k = changes(apply(t, sync.entries.get(e.id)), both);
        if (k.length) this.broken.push(`check 6: ${x.op} on ${id} folded into ${e.op} changes its ${k}`);
      } else if (changes(t, both).length && changes(t, apply(t, x)).length)
        this.broken.push(`check 6: ${x.op} and ${e.op} on ${id} cancelled out, but change its ${changes(t, both)}`);
    }
  }
  async gate(url, opts) {
    this.activity++;
    if (this.closed) throw new TypeError('Failed to fetch');
    const key = opts.headers?.['Idempotency-Key']?.replaceAll('"', '') || null,
      method = opts.method || 'GET';
    if (key && this.unknownKeys.has(key)) return unknownReply();
    // A read that passes straight through starts as it reaches the fake Vikunja.
    if (method === 'GET') {
      const u = new URL(url),
        id = +(u.pathname.match(/\/tasks\/(\d+)$/) || [])[1],
        at = ++this.seq,
        expand = u.searchParams.getAll('expand'),
        asked = [...TASK, ...['reactions', 'comments'].filter(k => expand.includes(k))];
      return this.stamped(await this.inner(url, opts), ++this.t, false, 'read', {
        asked,
        overlapped: !!id && this.overlaps(id, at, at),
        start: at,
      });
    }
    const h = {
      url,
      opts,
      key,
      method,
      e: key && this.entryOf(key),
      id: +(new URL(url).pathname.match(/\/tasks\/(\d+)/) || [])[1] || null,
      res: null,
      reached: ++this.seq,
      done: Infinity,
    };
    // A link, or taking one out, changes the other task too.
    h.ids = [h.id, ...otherOf(h)].filter(Boolean);
    this.writes.push(h);
    const op = h.e && (this.ops.get(h.e.id) ?? this.ops.set(h.e.id, { e: h.e, spans: [] }).get(h.e.id));
    if (op && !(op.spans.at(-1)?.[1] === Infinity)) op.spans.push([h.reached, Infinity]);
    return new Promise((ok, no) => this.held.push(Object.assign(h, { ok, no })));
  }
  /* Whether write request `x` was in flight between `start` and `end`: it had reached the fake Vikunja, and Vikunja
     hadn't both made it and sent its reply. A request Pocket gave up on before Vikunja made it is in flight until
     Vikunja makes it. */
  inFlight(x, start, end) {
    return x.reached <= end && x.done >= start;
  }
  // Whether one of Pocket's writes to task `id` was in flight between `start` and `end`, so the store throws away a
  // read that ran then.
  overlaps(id, start, end) {
    return this.writes.some(x => x.ids.includes(id) && this.inFlight(x, start, end));
  }
  /* Whether reply `rec` answers a write that crossed another of Pocket's writes to task `id`, so the store takes
     none of it there. An op's requests are one write. A read an op kept crossed one if it overlapped one. */
  crossed(rec, id) {
    const h = rec.h,
      who = x => x.e?.id ?? x;
    return (
      !!rec.overlapped ||
      (!!h && this.writes.some(x => who(x) !== who(h) && x.ids.includes(id) && this.inFlight(x, h.reached, h.done)))
    );
  }
  // The last write to task `id` whose reply Pocket got.
  delivered(id) {
    return this.writes
      .filter(x => x.ids.includes(id) && x.left && !x.late)
      .reduce((a, x) => (a?.left > x.left ? a : x), null);
  }
  // Pocket gets write `h`'s reply, or gives up on it. One given up on before Vikunja made it stays in flight (late).
  deliver(h, late = false) {
    h.left = ++this.seq;
    h.late = late;
    if (late) this.late.push(h);
    else h.done = h.left;
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
    const related = h.method === 'DELETE' && h.id && Object.values(this.v.tasks.get(h.id)?.related_tasks || {}).flat();
    h.res = await this.inner(h.url, h.opts);
    h.replayed = h.res.headers.get('Idempotent-Replayed') === 'true';
    h.at = h.replayed ? this.madeAt.get(h.key) : ++this.t;
    if (h.late && h.done === Infinity) h.done = ++this.seq;
    this.answered(h.key);
    if (h.replayed) return;
    if (h.abandoned) {
      for (const id of h.ids) this.model.doubt(id, touches(h));
      for (const r of related || []) this.model.doubt(r.id, ['related_tasks']);
    }
    if (h.key) this.madeAt.set(h.key, h.at);
    if (h.e) this.lastMade.set(h.e.id, h.at);
    // Vikunja's task right after it made the request, which a change Pocket takes from it must agree with.
    const now = this.v.tasks.get(h.id);
    h.after = clone(now);
    if (h.e && h.id)
      for (const k of touches(h)) this.madeField.set(`${h.e.id} ${h.id} ${k}`, { at: h.at, value: clone(now?.[k]) });
    if (h.e && related) for (const r of related) this.madeField.set(`${h.e.id} ${r.id} related_tasks`, { at: h.at });
    // A field Vikunja changes that the op's answer doesn't carry, such as a position, is new to Pocket until it reads.
    const unseen = h.e && Object.entries(ALL).find(([n, s]) => (s.op ?? n) === h.e.op)?.[1].unseen;
    if (h.id && unseen) this.model.doubt(h.id, unseen);
    // A link, or taking one out, changes the related tasks of both tasks, and a copy those of the task copied, which
    // only a read brings.
    if (h.id && /\/relations|\/duplicate$/.test(h.url))
      for (const x of [h.id, ...otherOf(h)]) this.model.doubt(x, ['related_tasks']);
  }
  /* A refusal or an unknown answer stops op `e` before its answer. The store then reads again the tasks the op's
     requests went to, without their comments. So only a later read tells Pocket of a comment the op made, or of a
     task it deleted leaving the related tasks of a task its requests didn't go to. */
  unheard(e) {
    if (!e) return;
    const sent = new Set(this.writes.filter(x => x.e?.id === e.id).flatMap(x => x.ids));
    for (const k of this.madeField.keys()) {
      const [entry, id, field] = k.split(' ');
      if (entry === e.id && (field === 'comments' || !sent.has(+id))) this.model.doubt(+id, [field]);
    }
  }
  /* A request Pocket gave up on may still reach Vikunja after its op stopped waiting in the outbox, refused or gone.
     Pocket no longer waits for it, so it changes Vikunja as a teammate would (abandoned). */
  abandon() {
    const waiting = new Set(
      this.acts()
        .filter(e => !e.failed)
        .map(e => e.id),
    );
    for (const x of this.late)
      if (x.done === Infinity && !waiting.has(x.e?.id)) Object.assign(x, { done: ++this.seq, abandoned: true });
    for (const [id, op] of this.ops)
      if (!waiting.has(id) && op.spans.at(-1)[1] === Infinity) op.spans.at(-1)[1] = ++this.seq;
  }
  /* Whether an op that changes task `id` was waiting to be answered at any time between `start` and `end`: from its
     first request in a try until it was answered, refused or gone. Its requests may be on their way all that time, so
     the store throws away a read that ran then. The op changes the tasks its `on` names, its own, and those its
     requests went to. */
  opsOn(id, start, end) {
    return [...this.ops.values()].some(
      ({ e, spans }) =>
        spans.some(([a, b]) => a <= end && b >= start) &&
        [
          ...opOf(e).on(e),
          typeof e.task === 'string' ? sync.taskOf(e.task.replace(/^pending-/, '')) : e.task,
          ...this.writes.filter(x => x.e?.id === e.id).flatMap(x => x.ids),
        ].includes(id),
    );
  }
  /* The other half of check 5. A read that ran while none of Pocket's writes to task `id` was in flight, and no op
     that changes it was waiting, is taken for each field Pocket has no newer news of. A write the store never ended
     shows here, as a read thrown away. */
  taken(id, rec, start, end) {
    const m = this.model,
      c = copyOf(id),
      tags = m.tags.get(id) || new Map();
    if (m.forgotten.has(id) || !c || this.opsOn(id, start, end)) return;
    const missed = trusted(rec).filter(
      k =>
        CHECKED.includes(k) &&
        k in rec.data &&
        !m.relaxes(id, k) &&
        !(tags.get(k)?.at > rec.at) &&
        !same(like(k, c[k]), like(k, m.unrelated({ [k]: rec.data[k] })[k])),
    );
    if (missed.length)
      this.broken.push(
        `check 5: ${id}'s copy left the ${missed} of a read that ran while no write to it was in flight`,
      );
  }
  // Vikunja refuses held request `h`, and changes nothing. The relay keeps the refusal. The fake reads `refuses` before
  // its first await, so only this request is refused.
  refuse(h) {
    this.v.refuses = () => 403;
    const res = this.inner(h.url, h.opts);
    this.v.refuses = () => null;
    this.answered(h.key);
    return res;
  }
  /* The relay has an answer for `key`, so a request with it that Pocket gave up on changes nothing when it arrives. It
     is no longer in flight. */
  answered(key) {
    for (const x of this.late) if (key && x.key === key && x.done === Infinity) x.done = ++this.seq;
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
      this.replies.push({
        at,
        kind,
        replayed,
        data: clone(body),
        h: h?.reached ? h : null,
        ...pick(h || {}, 'asked', 'overlapped', 'start'),
      });
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
    this.reads.push({ at, list, asked, start: ++this.seq });
  }
  // A read reaches Pocket, as a screen's load does: its tasks go into the store, then get rows.
  finishRead(i) {
    const [r] = this.reads.splice(i % this.reads.length, 1);
    r.end = ++this.seq;
    this.reading = r;
    const list = putting(r.asked, r.at)(structuredClone(r.list));
    this.reading = null;
    for (const t of list) this.app.row(t);
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
    /* A change Pocket asked for that Vikunja made otherwise, as a repeating task it moved on rather than marked done,
       is one only a read can say. `vikunja` is the task right after Vikunja made the request. */
    const excused = this.known(ev),
      otherwise = changed.filter(
        k =>
          ev.vikunja &&
          k in ev.vikunja &&
          ev.vikunja[k] !== undefined &&
          typeof ev.vikunja[k] !== 'object' &&
          !same(ev.after?.[k], ev.vikunja[k]),
      );
    if (otherwise.length)
      this.broken.push(`check 5: ${ev.id}'s copy took the ${otherwise} of a change Vikunja made otherwise (${ev.via})`);
    if ((ev.back || ev.replay) && !excused)
      this.broken.push(
        ev.back
          ? `check 5: ${ev.id}'s copy went back. ${ev.via === 'read' ? 'A read' : 'An answer'} (${ev.via}) wrote ${older.map(k => `${k} from ${at(k)} after Pocket had news of it from ${tags.get(k).at}`).join(', ')}`
          : `check 5: a reply the relay replayed changed the ${changed} of ${ev.id}'s copy (${ev.via})`,
      );
    /* Pocket's news of each field: a field of a reply that the copy now agrees with, and a field Pocket asked Vikunja
       to change that the copy now has (`asked`). An op answered on a task Pocket has no copy of is news of the fields
       it changes. */
    // A read the store may throw away while an op waits (opsOn) is news only if the copy took something from it.
    if (m.forgotten.has(ev.id) || ev.thrown || (ev.excused && same(ev.before, ev.after))) return;
    const agrees = k => !!ev.after && same(ev.after[k], m.unrelated({ [k]: ev.rec ? ev.rec.data[k] : ev.asked[k] })[k]);
    const fields = ev.rec
      ? trusted(ev.rec).filter(k => k in ev.rec.data && agrees(k))
      : Object.keys(ev.asked || {}).filter(k => ev.uncopied || agrees(k));
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
  // Whether nothing waits to be sent or answered, and no read runs.
  still() {
    return !this.acts().length && !this.held.length && !this.late.length && !this.reads.length && !this.busy.size;
  }
  // The task a command names: a task's id, or the step, which is its entry's waiting id until Vikunja has made it.
  target(t) {
    return t === STEP ? (this.stepId ?? 'pending-' + STEP) : t;
  }
  async close() {
    later = Math.max(later, Date.now());
    this.closed = true;
    for (let i = 0; i < 100 && (this.busy.size || this.held.length); i++) {
      for (const h of this.held.splice(0)) h.no(new TypeError('Failed to fetch'));
      await tick();
    }
    globalThis.fetch = this.inner;
  }
}

/* What the world starts with: the checklist read in full, as a screen loads it, and a step still being added to it. The
   step's entry only holds its waiting id, as an addStep op's entry does, and StepMade makes the step. */
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

/* Each check returns what broke it. 1: each row is the model's copy, then the waiting ops, a row marked done is as it
   was marked, each copy is the model's, each field the store wrote comes from a reply or a change it was
   given, a task Pocket deleted is gone, and the step not yet made shows its waiting ops. 2: a row is the same object from one command to the next. 3: Vikunja made each key at most once.
   4 (matches): once nothing waits or runs, the copy of each task is Vikunja's. 5: what judge found. 6: a fold took
   out of the outbox only ops Vikunja never made, and lost no change the user asked for (prune). 7: a sweep kept the
   copy of each task the outbox or a kept screen needs (HEARD.prune). A field a KNOWN bug met in the sequence may have
   left wrong is skipped. */
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
      for (const field of fields(id, f, row))
        out.push(
          `check 1: ${k} is marked done, and its ${field} changed from ${canon(f[field])} to ${canon(row[field])}`,
        );
    } else if (!m.shown(id) || fields(id, row, m.shown(id)).length)
      out.push(`check 1: ${k}'s row is ${canon(row)}, and its copy and ops give ${canon(m.shown(id))}`);
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
  for (const x of w.pruned)
    if (w.writes.some(h => h.e?.id === x.id && w.made(h)))
      out.push(`check 6: a fold took ${x.op} on ${x.task} out of the outbox, and Vikunja made its request`);
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
const KNOWN = [];

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
    const broken = checks(w);
    if (broken.length) throw new Error(`${this} broke a check:\n  ${broken.join('\n  ')}`);
  }
}
/* The fields of `sample`'s op on task `id`. A delete deletes the task and its subtasks as Vikunja has them, deepest
   first, leaving out a subtask that has another parent, as the app reads them before it asks (taskTree). An op on a
   parent names the `p`-th parent the task has. */
function fieldsOn(sample, id, w, p = 0) {
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
  const ups = copy(id)?.related_tasks?.parenttask || [];
  if ('up' in f) f.up = ups[p % Math.max(1, ups.length)]?.id ?? null;
  if (f.up === null) delete f.up;
  return [f];
}
// Whether sample `name` can be queued on target `t`: a task with a row, or the step for an op on one task alone.
function canQueue(w, name, t) {
  const s = ALL[name],
    id = w.target(t);
  if (typeof id === 'string')
    return typeof s.fields !== 'function' && !s.queue && !('ids' in s.fields) && !('up' in s.fields);
  if (s.parented && !w.model.copies.get(id)?.related_tasks?.parenttask?.length) return false;
  return !!w.app.tasks[id] && !w.app.beingDeleted(id) && w.app.leaving[id] !== 'deleted';
}
class Queue extends Command {
  constructor(name, t, p = 0) {
    super();
    Object.assign(this, { sample: name, t, p });
  }
  can(m) {
    return canQueue(m.w, this.sample, this.t);
  }
  async act(w) {
    const s = ALL[this.sample],
      list = fieldsOn(s, w.target(this.t), w, this.p).map(f => ({ id: uuid7(), ...f })),
      f = list.at(-1);
    if (opOf(f).invert) w.undos.push(f);
    w.sending(s.queue ? s.queue(w.app, f) : w.app.actAll(list));
  }
  toString() {
    return `Queue(${this.sample} on ${this.t}${this.p ? `, parent ${this.p}` : ''})`;
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
   whether Vikunja made it), or Vikunja refuses it. Vikunja makes it first, unless Reach already has. Or an op's request
   is lost before Vikunja makes it: Pocket gives up on it, and Vikunja makes it later (late, then Late). */
class Answer extends Command {
  constructor(how, i) {
    super();
    Object.assign(this, { how, i });
  }
  can(m) {
    const h = m.w.heldAt(this.i);
    return (
      !!h &&
      (this.how !== 'refused' || !m.w.made(h)) &&
      (this.how !== 'unknown' || !!h.key) &&
      (this.how !== 'late' || (!!h.key && !h.res))
    );
  }
  async act(w, m) {
    const h = w.heldAt(this.i);
    w.held.splice(w.held.indexOf(h), 1);
    if (this.how === 'late') {
      w.deliver(h, true);
      return h.no(new TypeError('network error'));
    }
    if (this.how === 'refused') {
      w.unheard(h.e);
      const res = await w.refuse(h);
      w.deliver(h);
      return h.ok(res);
    }
    await w.make(h);
    w.deliver(h);
    if (this.how === 'arrives') return h.ok(await w.stamped(h.res, h.at, h.replayed, replyKind(h.method, h.url), h));
    if (this.how === 'lost') return h.no(new TypeError('network error'));
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
/* Vikunja makes a request Pocket gave up on before Vikunja made it (the i-th, Answer late). Once Pocket has sent its
   key again and had an answer, the relay answers it from what it kept, and it changes nothing. */
class Late extends Command {
  constructor(i) {
    super();
    this.i = i;
  }
  can(m) {
    return m.w.late.length > 0;
  }
  async act(w) {
    const [h] = w.late.splice(this.i % w.late.length, 1);
    await w.make(h);
  }
  toString() {
    return `Late(${this.i})`;
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
/* Vikunja makes the step being added, under the checklist, and its ops are filed under its id, as an addStep op does.
   It waits for the outbox's lock, as the sender does. */
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
/* The user adds or removes a person or a label in a task's sheet (actions.js), which queues an assign or label op. A new
   label is made as its op is sent, once. */
const LABEL = { id: 600, title: 'floor' },
  MOP = { id: 601, title: 'mop' };
const SHEET = {
  assign: (app, t) => app.addAssignee(t, { id: 7, username: 'bob' }),
  unassign: (app, t) => app.removeAssignee(t, 7),
  label: (app, t) => app.addLabelTo(t, LABEL),
  unlabel: (app, t) => app.removeLabelFrom(t, LABEL.id),
  'new label': (app, t) => app.addLabelTo(t, null, 'Urgent'),
};
class Sheet extends Command {
  constructor(t, change) {
    super();
    Object.assign(this, { t, change });
  }
  can(m) {
    const id = m.w.target(this.t);
    return typeof id === 'number' && !!m.w.app.tasks[id] && m.w.v.tasks.has(id);
  }
  async act(w) {
    const id = w.target(this.t);
    w.sending(SHEET[this.change](w.app, w.app.tasks[id]));
  }
  toString() {
    return `Sheet(${this.t}, ${this.change})`;
  }
}
// A teammate changes a task in Vikunja's web app: a field an op changes, or one none does.
const CHANGES = {
  done: t => !t.done,
  percent_done: () => 0.75,
  due_date: t => (t.due_date === '2026-10-20T09:00:00Z' ? '0001-01-01T00:00:00Z' : '2026-10-20T09:00:00Z'),
  assignees: t => [...(t.assignees || []), { id: 7, username: 'bob' }],
  labels: t => [...(t.labels || []).filter(l => l.id !== MOP.id), MOP],
  title: t => t.title + ' (renamed)',
  priority: () => 3,
  repeat_after: t => (t.repeat_after ? 0 : 86400),
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
/* Today is saved with the rows of some tasks, as its load saves it, and the store sweeps: it drops the copies and rows
   that no kept screen, outbox entry or row on screen needs (check 7). */
class Sweep extends Command {
  constructor(ts) {
    super();
    this.ts = ts;
  }
  can() {
    return true;
  }
  async act(w) {
    const ids = [...new Set(this.ts.map(t => w.target(t)))].filter(id => typeof id === 'number' && w.app.tasks[id]);
    w.screen = new Set(ids);
    w.app.keepScreen('today', { groups: [{ key: 'today', tasks: ids.map(id => w.app.tasks[id]) }] });
  }
  toString() {
    return `Sweep(${this.ts})`;
  }
}
// Pocket reloads, between any two requests of an op, with the connection cut first or not (World.reload).
class Reload extends Command {
  constructor(cut) {
    super();
    this.cut = cut;
  }
  can() {
    return true;
  }
  async act(w) {
    await w.reload(this.cut);
  }
  toString() {
    return `Reload(${this.cut ? 'cut' : 'lost'})`;
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
// fast-check picks each entry equally often, and skips a command that can't run, so the common ones are listed again.
const queue = fc.tuple(fc.constantFrom(...Object.keys(ALL)), target, fc.nat(1)).map(([n, t, p]) => new Queue(n, t, p)),
  answer = fc
    .tuple(fc.constantFrom('arrives', 'arrives', 'lost', 'late', 'unknown', 'refused'), fc.nat(3))
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
  fc.nat(3).map(i => new Late(i)),
  fc.nat(5).map(i => new Drop(i)),
  fc.nat(5).map(i => new Undo(i)),
  read,
  read,
  read,
  fc.nat(5).map(i => new FinishRead(i)),
  fc.nat(5).map(i => new FinishRead(i)),
  fc.tuple(target, fc.constantFrom('done', 'open', 'deleted')).map(([t, k]) => new Mark(t, k)),
  fc.constant(new ClearBatch()),
  target.map(t => new Restore(t)),
  fc.constant(new StepMade()),
  fc.tuple(target, fc.constantFrom(...Object.keys(CHANGES))).map(([t, f]) => new Teammate(t, f)),
  fc.tuple(target, fc.constantFrom(...Object.keys(SHEET))).map(([t, f]) => new Sheet(t, f)),
  fc.constantFrom(3, STEP).map(t => new SecondParent(t)),
  fc.constantFrom(1000, 30000, 61000).map(ms => new Wait(ms)),
  fc.uniqueArray(target, { maxLength: 3 }).map(ts => new Sweep(ts)),
  fc.boolean().map(cut => new Reload(cut)),
];

/* Send and answer everything still waiting: make the step, cancel what Vikunja refused, send what
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
    if (ready && w.stepId === null) await run(new StepMade());
    else if (ready && failed >= 0) await run(new Drop(failed));
    else if (ready && list.some(e => !e.sent && !held(e))) await run(new Send(false));
    else if (ready && list.some(e => e.sent && !held(e))) await run(new Send(true));
    else if (w.held.some(h => !h.res)) await run(new Reach(w.held.findIndex(h => !h.res)));
    else if (w.held.length) await run(new Answer('arrives', picks[n % picks.length] ?? 0));
    else if (w.late.length) await run(new Late(0));
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

test('the store shows each task as its copy, then the waiting ops, whatever order things happen in', async t => {
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

/* The repeat reaches Vikunja, but its answer is unknown and it is cancelled, so the copy doesn't know task 1 repeats.
   The tick's reply is lost, and the relay replays it when the tick is sent again. A replayed reply isn't taken where
   Pocket has a copy, so only a read can say that Vikunja moved the task on to its next date. */
test("a tick on a task the copy doesn't know repeats takes nothing into the copy when its reply is replayed", async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Teammate(1, 'due_date'),
      new Queue('repeat', 1),
      new Send(false),
      new Answer('unknown', 0),
      new Queue('done', 1),
      new Drop(0),
      new Send(false),
      new Answer('lost', 0),
      new Send(true),
      new Answer('arrives', 0),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* A template's date is taken off with done: true, built from a read that found no repeat. A teammate makes the task
   repeat before the request arrives, so Vikunja moves it on to its next date instead. Only a read can say that. */
test('a date taken off with done takes nothing into the copy when a teammate makes the task repeat first', async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('due', 3),
      new Send(false),
      new Teammate(3, 'repeat_after'),
      new Teammate(3, 'due_date'),
      new Answer('lost', 0),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* A step repeated in checklist 1 is a copy of step 2, which then lists the copy as copied to it. Vikunja's answer to a
   later request of the repeat is unknown. Deleting the checklist then cancels the repeat, which deletes the copy, and
   step 2's copy stops listing it, which is no news of the repeat's own change. Vikunja's answer to the checklist's
   delete is unknown too. */
test("a copy a cancelled step made leaves its source step's links when it is deleted", async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('addStep, repeated', 1),
      new Send(false),
      new Answer('arrives', 0),
      new Answer('arrives', 0),
      new Queue('delete, with no Restore', 1),
      new Answer('unknown', 0),
      new Answer('arrives', 0),
      new Send(false),
      new Answer('unknown', 0),
      new Queue('done', 1),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* A step repeated in checklist 1 keeps the checklist as Vikunja gave it when the step was put in its order, before a
   teammate's progress. Its last stage writes the checklist's progress, whose reply is lost, and the relay replays it
   when the step is sent again. The older copy the step kept mustn't take that progress back. */
test("a step's add keeps the checklist's newest copy once it writes the checklist's progress", async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('addStep, repeated', 1),
      new Send(false),
      new Teammate(1, 'percent_done'),
      new Answer('arrives', 0),
      new Answer('arrives', 0),
      new Answer('arrives', 0),
      new Answer('arrives', 0),
      new Answer('lost', 0),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* A delete of step 2 reaches Vikunja, but its answer is unknown, and it is cancelled. A move of step 3 then finds no
   step 2 in the order Vikunja has, so it sends nothing. Its order line is only a guess, which a read decides. */
test('a move of a step that sends nothing, because the step it moves past is gone, leaves the order to a read', async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('delete, with no Restore', 2),
      new Send(false),
      new Queue('edit, order', 1),
      new Answer('unknown', 0),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* Make template marks the checklist's steps done as template steps. A teammate makes step 2 repeat first, so Vikunja
   moves it on to its next date instead, which only the reply can say. */
test('a step a teammate made repeat takes nothing into the copy when Make template marks it done', async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('makeTemplate', 1),
      new Teammate(2, 'repeat_after'),
      new Teammate(2, 'due_date'),
      new StartRead([1], false),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* A repeat on step 101 reaches Vikunja, and its Undo waits. A teammate turns the repeat off, so the Undo finds its
   change there already and sends nothing. The copy takes the Undo's change as of then, and a read that started before
   the teammate's change, which still has the repeat, is too old for it. */
test('an Undo that finds its change made by a teammate keeps the copy from going back to a read from before', async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('repeat', STEP),
      new StepMade(),
      new Send(false),
      new Answer('arrives', 0),
      new Undo(0),
      new StartRead([STEP], true),
      new Teammate(STEP, 'repeat_after'),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* A template step under checklist 1 is refused once its first request is made, and a note on the checklist comes back
   unknown. A read of the checklist with its comments starts, and then Cancel resumes the template step, which has made
   nothing, so it sends nothing. A try that sends nothing has nothing on its way, so the read is taken. */
test('a Cancel that sends nothing leaves a read of the task it would change to be taken', async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('templateStep', 1),
      new Send(false),
      new Queue('note', 1),
      new Answer('refused', 0),
      new Send(false),
      new Answer('unknown', 0),
      new StartRead([1], true),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});

/* A step's progress reaches Vikunja, and a teammate changes it. The connection drops before the checklist's progress
   is sent, and Pocket reloads. The new page reads the teammate's change, then sends the checklist's progress fresh.
   The step's progress counts from when the page before sent it, so it doesn't overwrite the teammate's change. */
test("an op's part made before a reload doesn't overwrite a teammate's change the new page read", async t => {
  const w = await open(t.mock.timers);
  try {
    for (const c of [
      new Queue('progress', 2),
      new Send(false),
      new Answer('arrives', 0),
      new Teammate(2, 'percent_done'),
      new Reload(true),
    ]) {
      assert.ok(c.check(w.model), `${c} can run`);
      await c.run(w.model, w);
    }
    await drain(w, [0]);
  } finally {
    await w.close();
  }
});
