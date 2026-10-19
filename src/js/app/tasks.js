/* One object per task: tasks[id] is what every row of that task shows, in every list. show(id) is the only code that
   writes it. It stacks Vikunja's copy and the task's waiting ops, and patches the result into tasks[id] field by field,
   so a change shows on all the task's rows at once.

   Every write to what show reads happens inside change(fn), as in Python's `with update():`. fn gets the writers, and
   when it ends, change shows each task they touched once. `copies` holds Vikunja's last copy of each task, written
   field by field by read, answer, made and answered alone, and read through copyOf. Undo compares against it. A
   screen is saved on the phone as the ids of its tasks, and their copies are kept beside it (keepScreen). `opsOn`
   holds the ops waiting in the outbox by each task they change, and each op shows itself through its `apply`. The
   sheet and a checklist's screen hold ids and read their tasks here (sheetTask, runTask). A subtask is read from its
   own row, never from the copy of it nested in its parent (related_tasks), which says only which subtasks there are
   and in what order (subRow). */
import { app, raw, store } from '../util.js';
import { allPages, api, serverTime } from '../api.js';
import { intoKeys, keptScreens, saved, savedScreen, screenIds } from '../lists.js';
import { sync } from '../sync.js';
import { opOf, OPS } from '../ops/index.js';
import { repeats } from '../dates.js';
import { allComments, inBatches } from '../checklists.js';

// Tasks deleted this session. A request that started before the delete may still bring one, or list it among another
// task's related tasks.
const forgotten = new Set();
// Whether a field is the same as Vikunja gave it. Lists and objects compare by content, since Vikunja writes them in one order.
const same = (a, b) =>
  a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
// A row gets its own lists and objects, so writing a row never changes Vikunja's copy or an answer.
const own = v => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

/* The fields of a task that each kind of request can be trusted for (read, answer), as Vikunja 2.7 answers. A task
   read alone or in a list, and a PATCH reply, has every field in TASK, labels and people included. Reactions, comments
   and the comment count come only with expand=, and are null without it, which would read as "none". A new task's
   reply comes before Pocket adds its labels, people, parent and files. A saved screen holds copies made of these
   fields. */
export const TASK = [
  'id',
  'title',
  'description',
  'done',
  'done_at',
  'due_date',
  'start_date',
  'end_date',
  'repeat_after',
  'repeat_mode',
  'priority',
  'percent_done',
  'hex_color',
  'is_favorite',
  'identifier',
  'index',
  'position',
  'bucket_id',
  'cover_image_attachment_id',
  'project_id',
  'created',
  'created_by',
  'updated',
  'labels',
  'assignees',
  'attachments',
  'reminders',
  'related_tasks',
];
export const TASK_COUNT = [...TASK, 'comment_count']; // expand=comment_count
export const TASK_COUNT_REACTIONS = [...TASK_COUNT, 'reactions']; // expand=comment_count and expand=reactions
export const TASK_COMMENTS = [...TASK, 'comments']; // expand=comments
export const TASK_REACTIONS_COMMENTS = [...TASK_COMMENTS, 'reactions']; // expand=reactions and expand=comments
export const CREATED = TASK.filter(k => !['labels', 'assignees', 'related_tasks', 'attachments'].includes(k));
export const SAVED = [...TASK_REACTIONS_COMMENTS, 'comment_count'];

const copies = new Map(); // task id -> Vikunja's last copy, holding only fields from those lists
const bases = new Map(); // task id -> what a row was made from while Vikunja's copy of it is unknown
// Outbox entries that no row shows any more, though they may still be in the outbox: answered, or a held delete undone.
const settled = new Set();

/* Vikunja's copy of a task only moves forward. Vikunja gives no version number, so Pocket orders what it learns by
   when it started each request, on `clock`. A field of a reply is taken only if its request started after the request
   behind that field of the copy (`since`). A read is also thrown away for a task a write was in flight on at any time
   while it ran (`flying`, `landed`), because it may carry the task from before or after that write, and the next read
   decides. */
let clock = 0;
/* When a request starts, for read and writes: the phone's time in microseconds, one more than the last at least, so
   two requests in one millisecond keep their order. An outbox entry keeps the times of its requests, and the time
   carries over to the next page. */
export const started = () => (clock = Math.max(clock + 1, Date.now() * 1000));
/* When the copies were last dropped, as a user signed out (dropCopies). A request that started before then may bring
   the last user's tasks, so nothing it brings goes into the store. A write counts from the start of its try on this
   page (`start`), and a saved copy (0) is the new user's. */
let dropped = 0;
const before = w => {
  const at = typeof w === 'number' ? w : (w.start ?? w.at);
  return at > 0 && at <= dropped;
};
// The tasks such a request brought, so that a screen's load gives none of them a row either (base).
const lastUser = new WeakSet();
// Whether the copies were dropped, as a user signed out, after a request that started at `at`.
export const droppedSince = at => before(at);
const since = new Map(); // task id -> field -> when the request behind that field of its copy started
const flying = new Map(); // task id -> the writes to it in flight (writes)
const landed = new Map(); // task id -> when the last write to it ended
/* A write to Vikunja starts now. `on` gives the values it sets on each task it changes ({id: {field: value}}), and
   made takes those values once Vikunja has made it. Returns the write, for answer and made: `at` is when it started,
   `crossed` the other writes in flight on each of its tasks at the same time, `add(id, fields)` adds a task or fields,
   such as a task the write made, and `end()` ends it once it is answered, fails or comes back unknown. Two writes in
   flight at once can reach Vikunja in either order. So neither's reply is taken for a task both change, and neither's
   own change of a field the other sets to something else. An `idle` write is in flight only from `fly()`, its first
   request. */
export function writes(on = {}, idle = false) {
  // Put the write in flight on task `id`, crossing the other writes in flight there.
  const join = id => {
    const list = flying.get(id) || new Set();
    for (const x of list)
      if (x !== w) {
        w.crossed.set(id, (w.crossed.get(id) || new Set()).add(x));
        x.crossed.set(id, (x.crossed.get(id) || new Set()).add(w));
      }
    flying.set(id, list.add(w));
  };
  const w = {
    at: started(),
    crossed: new Map(),
    fields: new Map(),
    add(id, fields = {}) {
      if (Array.isArray(fields)) throw new Error('A write names the values it sets ({field: value}).');
      if (typeof id !== 'number' || w.ended) return;
      const set = { ...fields },
        t = copies.get(id) ?? bases.get(id);
      /* Vikunja sets done_at itself when done changes. It moves a repeating task marked done on to its next dates
         instead, so only its reply says what such a write leaves. */
      if ('done' in set && !('done_at' in set)) set.done_at = UNKNOWN;
      if (set.done === true && t && repeats(t)) for (const k of MOVED) set[k] = UNKNOWN;
      w.fields.set(id, { ...w.fields.get(id), ...set });
      if (!idle) join(id);
    },
    fly() {
      if (!idle || w.ended) return;
      idle = false;
      for (const id of w.fields.keys()) join(id);
    },
    end() {
      if (w.ended) return;
      w.ended = true;
      if (idle) return;
      for (const id of w.fields.keys()) {
        flying.get(id)?.delete(w);
        if (!flying.get(id)?.size) flying.delete(id);
        landed.set(id, started());
        reread(id);
      }
    },
  };
  for (const [id, fields] of Object.entries(on)) w.add(idOf(id), fields);
  return w;
}
const UNKNOWN = Symbol('unknown');
// The fields a write marking a repeating task done may leave, since Vikunja moves such a task on to its next dates.
export const MOVED = ['done', 'done_at', 'due_date', 'start_date', 'end_date', 'reminders'];
const opWrites = new Map(); // outbox entry id -> its op's write (sendingOp)
/* The write of op entry `a` as the sender sends it (writes): the tasks it changes, each with what its apply sets
   there. A field the apply sets to the value the copy has is one it sets too, so it is found by applying the op to
   a task with nothing in it as well. A field only Vikunja's reply can say (replyOnly) is unknown until it comes. The
   write starts with the op's first request and stays in flight across tries, because a request whose reply was lost
   may still reach Vikunja. It ends once the op stops waiting in the outbox: answered, refused or gone (keyOps). A try
   after a refusal or an unknown answer, as Try again or Cancel makes, is in flight only from its first request, since
   no earlier request of the op is on its way then. The op's change counts from its first request (`at`), also when
   Try again sends it after it was refused, and also when the page before this one sent it (firstSent). */
export const sendingOp = a => {
  const was = opWrites.get(a.id);
  if (was && !was.ended) return was;
  const op = opOf(a),
    on = {},
    changed = (t, x) => Object.keys(x).filter(k => !same(t[k], x[k]));
  for (const id of new Set([...shownOn(a), opsId(a.task)]))
    if (typeof id === 'number') {
      const t = copies.get(id) ?? bases.get(id) ?? { id },
        x = op.apply(t, a),
        sets = new Set([...changed(t, x), ...changed({ id }, op.apply({ id }, a))]);
      on[id] = Object.fromEntries([...sets].map(k => [k, x[k]]));
      for (const k of op.replyOnly(a)) on[id][k] = UNKNOWN;
    }
  // The task the op made, as an earlier try or page kept it, is one its later requests change.
  if (typeof a.taskId === 'number') on[a.taskId] ||= {};
  const w = writes(on, !!was);
  Object.assign(w, { at: firstSent(a) ?? w.at, start: was?.start ?? w.at });
  opWrites.set(a.id, w);
  return w;
};
/* The time of op entry `a`'s earliest request, as the entry keeps the time of each (sentAt, stageContext). Null for an
   op not sent yet, or sent by an older Pocket, which keeps no times. */
export const firstSent = a => (a.sentAt ? Math.min(...Object.values(a.sentAt)) : null);
/* When Pocket's writes leave fields of a copy unsure, the task is read again once no write to it is in flight
   (reread), once however many writes left it unsure. Two writes crossed, or Vikunja changed what only its reply can
   say, and that reply wasn't taken. Or a read that may hold a teammate's change was thrown away. A read taken, or a
   reply that brings the field, ends the doubt. */
const doubts = new Map(); // task id -> the fields of its copy that may be old
const rereading = new Set(); // the tasks being read again
// What a read again asks for: every field of a task, its reactions, and its comments where the copy has them.
const REREAD = [...TASK, 'reactions', 'comments'];
const doubt = (id, fields) => {
  const d = doubts.get(id) || new Set(),
    t = copies.get(id) ?? bases.get(id);
  for (const k of fields) if (REREAD.includes(k) && (k !== 'comments' || (t && 'comments' in t))) d.add(k);
  if (d.size) doubts.set(id, d);
};
function reread(id) {
  if (!doubts.get(id)?.size || flying.get(id)?.size || rereading.has(id) || forgotten.has(id) || !app) return;
  rereading.add(id);
  const at = started(),
    asked = doubts.get(id).has('comments') ? REREAD : REREAD.filter(k => k !== 'comments');
  (asked === REREAD
    ? api(`/tasks/${id}?expand=reactions&expand=comments`).then(allComments)
    : api(`/tasks/${id}?expand=reactions`)
  ).then(
    t => {
      rereading.delete(id);
      app.change(w => w.read([t], asked, at));
      reread(id); // a write ended while it ran, so the read was thrown away
    },
    e => {
      rereading.delete(id);
      if (e.status === 404) app.change(w => w.lost(id));
    },
  );
}
// Whether a read that started at `at` is older than what Pocket knew of task `id` before a sweep dropped its copy
// (prune). Taking it would move the task back.
const older = (id, at) => !copies.has(id) && !bases.has(id) && [...(since.get(id)?.values() || [])].some(x => x > at);
// Whether a read that started at `at` ran while a write to task `id` was in flight, other than `except`, the write of
// the op the read is part of.
export const overlaps = (id, at, except = null) =>
  [...(flying.get(id) || [])].some(x => x !== except) || (landed.get(id) || 0) > at;
// task id -> the task as a read or a saved screen gave it (base), until the change ends. show lays the row over it.
// Once Vikunja's copy is known, only Pocket's own fields are laid, such as a new task's `parent`. A read's other
// fields would stay on the row after the copy changed.
const given = new Map();
const pocketOwn = t => Object.fromEntries(Object.entries(t).filter(([k]) => !SAVED.includes(k)));
// The tasks the writers touched in the change running, how deeply changes are nested, and the component of the outermost.
const touched = new Set();
let depth = 0,
  host = null;
const inChange = () => {
  if (!depth) throw new Error('Write the store inside change().');
};
/* The id that the ops on task `task` are filed under in opsOn. A step still being inserted is 'pending-' + its entry's
   id until Vikunja has made it, and its own id from then on. Code that looks up a waiting step's ops goes through
   this too, or an op filed under the new id would vanish from the step's row. */
export const opsId = task => (typeof task === 'string' ? (sync.taskOf(task.replace(/^pending-/, '')) ?? task) : task);
// The ids of the tasks an outbox entry changes (an op's `on`).
const shownOn = a => opOf(a).on(a);
// A key of opsOn as the task id it stands for. A task not yet sent has a string id.
const idOf = k => (/^\d+$/.test(k) ? +k : k);

/* The writers. change() hands them to its fn, and each throws outside a change. */

/* Write each of task `t`'s trusted fields (`asked`) into its copy, from a request that started at `at`, unless the
   copy's field came from a newer request. A write's reply comes after its own change and has the same time, so it
   wins. A copy kept on the phone (`at` 0) goes only where the store has none (restore). A field outside `asked`, or
   missing from the reply, keeps what the copy had, so a list read without expand=reactions keeps the copy's ✅. A
   trusted null is taken: a full read gives `labels: null` for a task with no labels. The copy is a new object each
   time, because Undo holds the one it compared against. Nested lists and objects are shared with the reply. */
function write(id, t, asked, at) {
  const s = since.get(id) || new Map(),
    fresh = asked.filter(k => k in t && (!at || at >= (s.get(k) ?? -1)));
  touched.add(id);
  if (!copies.has(id) && !fresh.length) return;
  const c = { ...copies.get(id) };
  if (!copies.has(id) && bases.has(id)) {
    /* The copy takes the place of what the row was made from, and keeps the changes Vikunja made to it (made), since
       each field's time is known (`since`). Any other field of Vikunja's that only the row had leaves it (show). */
    const b = bases.get(id);
    for (const k of s.keys()) if (k in b) c[k] = b[k];
    bases.delete(id);
  }
  for (const k of fresh) {
    c[k] = k === 'related_tasks' ? unrelated(t[k]) : t[k];
    if (at) s.set(k, at);
    doubts.get(id)?.delete(k);
  }
  copies.set(id, c);
  unsaved.add(id);
  since.set(id, s);
}
// A task's related tasks without the tasks deleted in this session, so a reply from before a delete can't bring one
// back. A list with none of them stays the reply's.
const unrelated = r =>
  !r || !Object.values(r).some(l => l?.some?.(s => forgotten.has(s.id)))
    ? r
    : Object.fromEntries(Object.entries(r).map(([k, l]) => [k, l?.filter?.(s => !forgotten.has(s.id)) ?? l]));
/* Vikunja's copies have one door: read, answer, made and answered. A task deleted in this session is left out, so a
   reply in flight can't bring it back. A read that started at `at` (started()) is left out for a task a write was in
   flight on while it ran. A read without its start time is a bug. A copy kept on the phone (`at` 0) is older than any
   read, and goes only where the store has none (restore). */
function read(list, asked, at) {
  inChange();
  if (typeof at !== 'number') throw new Error('A read needs the time it started (started()).');
  if (before(at)) {
    for (const t of list) if (t && typeof t === 'object') lastUser.add(t);
    return;
  }
  for (const t of list) {
    const id = t?.id;
    if (!id || forgotten.has(id)) continue;
    // A read thrown away may hold a teammate's change that no answer brings (reread). A copy kept on the phone holds
    // nothing newer.
    if (overlaps(id, at) || older(id, at)) {
      if (at) {
        doubt(id, asked);
        touched.add(id);
      }
      continue;
    }
    write(id, t, asked, at);
    for (const k of asked) doubts.get(id)?.delete(k);
  }
}
/* Vikunja's reply to write `w` (writes), or to one of its requests ({at, crossed, replayed}, stageContext). It is left
   out for a task another write was in flight on at the same time, and the task is read again. A reply the relay
   replayed is as old as the request's first send, so it goes only where Pocket has no copy. */
function answer(list, asked, w) {
  inChange();
  if (typeof w?.at !== 'number') throw new Error('An answer needs the write it answers (writes()).');
  if (before(w)) {
    for (const t of list) if (t && typeof t === 'object') lastUser.add(t);
    return;
  }
  for (const t of list) {
    const id = t?.id;
    if (!id || forgotten.has(id)) continue;
    if (w.crossed.has(id)) doubt(id, asked);
    else if (!(w.replayed && copies.has(id))) write(id, t, asked, w.at);
  }
}
/* Vikunja made write `w` (writes) on task `id`, setting the values the write names there. An op's answer passes what
   its apply sets now instead (`fields`), and so does a write that only learns its values from its outcome. The fields
   go into the copy, unless another write in flight at the same time sets the same field to something else, or only
   Vikunja's reply can say what the write left in a field. Those fields are unsure until a read, and so is a field the
   copy has newer that disagrees, since an op's time may be earlier than its request's (sendingOp). A task shown from
   what its parent says of it (bases) takes them there, with their times, so a copy made later keeps them. */
function made(id, w, fields = w?.fields?.get(id) ?? {}) {
  inChange();
  if (typeof w?.at !== 'number') throw new Error('A change Vikunja made needs its write (writes()).');
  if (forgotten.has(id) || before(w)) return;
  if (!copies.has(id)) {
    if (bases.has(id)) {
      const s = since.get(id) || new Map(),
        known = Object.entries(fields).filter(([, v]) => v !== UNKNOWN);
      for (const [k] of known) s.set(k, w.at);
      bases.set(id, { ...bases.get(id), ...Object.fromEntries(known) });
      unsaved.add(id);
      since.set(id, s);
    }
    touched.add(id);
    return;
  }
  const mine = w.fields?.get(id) || {},
    others = [...(w.crossed.get(id) || [])].map(x => x.fields.get(id)),
    kept = Object.keys(fields).filter(
      k => mine[k] !== UNKNOWN && others.every(o => !(k in o) || (o[k] !== UNKNOWN && same(o[k], fields[k]))),
    );
  write(id, fields, kept, w.at);
  const c = copies.get(id);
  doubt(id, [
    ...Object.keys(mine).filter(k => mine[k] === UNKNOWN),
    ...Object.keys(fields).filter(k => !kept.includes(k) || !same(c[k], fields[k])),
    // Vikunja made part of the op before a replayed reply came, and a teammate may have changed the task since.
    ...(w.replayed || w.replays ? REREAD : []),
  ]);
}
// Remove a deleted task's copy, its row, and the row from the lists on screen.
function gone(id) {
  copies.delete(id);
  store.del('saved.task.' + id);
  forgotten.add(id);
  for (const m of [bases, given]) m.delete(id);
  delete host.tasks[id];
  host.removeRow(id);
}
// Give task `t`, as a read or a saved screen gave it, a row, or lay the row it has over it. Without Vikunja's copy,
// the row is made from `t` until a read brings one, without the tasks deleted in this session among its related tasks.
function base(t) {
  inChange();
  if (lastUser.has(t)) return;
  if (!copies.has(t.id)) {
    // A task a sweep dropped starts afresh from what its row is made from, until a read brings its copy.
    if (!bases.has(t.id)) since.delete(t.id);
    bases.set(t.id, own(t.related_tasks ? { ...t, related_tasks: unrelated(t.related_tasks) } : t));
    unsaved.add(t.id);
  }
  given.set(t.id, t);
  touched.add(t.id);
}
// Mark task `id` as leaving with `kind` (leaving.js), or take its mark off without one.
function leave(id, kind) {
  inChange();
  if (kind) host.leaving[id] = kind;
  else delete host.leaving[id];
  touched.add(id);
}
/* Write the ops waiting in the outbox into opsOn, under each task they change, in the order they will be sent. The
   outbox tells the rows of each change to it (sync.js), and a refused op stops waiting. A task whose ops are unchanged
   keeps its list, so only the keys of tasks whose ops changed are written (rule 10). A held delete shows only on the
   tasks it deletes, so their gaps keep Restore until the batch clears, and their parent lists them until then. */
function keyOps() {
  inChange();
  const c = host,
    was = raw(c.opsOn),
    out = {},
    // Cancel marks an entry that has sent a request `cancelled` in place (cancelling), and its op then shows what Cancel
    // takes back, so the mark counts as a change too.
    ids = list => list.map(e => e.id + (e.cancelled ? ':cancelled' : '')).join(),
    listed = c.user ? sync.all(c.user.id) : [],
    all = listed.filter(e => !e.failed);
  /* An op that stops waiting, refused or gone from the outbox, has no request left on its way. A refused op keeps its
     write's time for Try again. If this tab didn't see the op answered (settled), its tasks are read again: another
     tab may have sent it, a stage may have been made before a refusal, or the answer was unknown. */
  const waits = new Set(all.map(e => e.id));
  for (const [id, w] of opWrites) {
    if (!waits.has(id) && !w.ended && !settled.has(id)) for (const t of w.fields.keys()) doubt(t, REREAD);
    if (!waits.has(id)) w.end();
    if (!listed.some(e => e.id === id)) opWrites.delete(id);
  }
  for (const id of settled) if (!listed.some(e => e.id === id)) settled.delete(id);
  for (const e of all)
    if (e.kind === 'act' && OPS[e.op] && !settled.has(e.id))
      for (const id of shownOn(e)) if (!sync.held.has(e.id) || e.ids.includes(id)) (out[id] ||= []).push(e);
  for (const k of new Set([...Object.keys(was), ...Object.keys(out)])) {
    const a = was[k] || [],
      b = out[k] || [];
    if (ids(a) === ids(b)) {
      if (b.length) out[k] = a;
      continue;
    }
    touched.add(idOf(k));
  }
  intoKeys(c.opsOn, out, raw);
  forgetLost();
}
/* Take outbox entry `a` off the tasks it changes, at once and for good, though it may still be in the outbox: once
   Vikunja has answered it, or when Restore takes back a held delete. Returns the ids of those tasks. */
function offTasks(a) {
  inChange();
  const ids = shownOn(a),
    was = raw(host.opsOn);
  settled.add(a.id);
  for (const id of ids) {
    touched.add(id);
    const rest = (was[id] || []).filter(e => e.id !== a.id);
    if (rest.length === (was[id] || []).length) continue;
    if (rest.length) host.opsOn[id] = rest;
    else delete host.opsOn[id];
  }
  return ids;
}
/* An op's answer. Vikunja did what the op asked, so each task the op changes takes the op's apply into Vikunja's copy
   (made), also when the reply is not a task, as for a claim, a comment or a ✅. `w` is the op's write (sendingOp).
   Then its own task takes the `reply` its stages kept (answer), and the op stops waiting, all in one change. The
   comment Vikunja made (`posted`) takes the place of the op's waiting one. If the op stopped waiting first, a row would
   show the old value until the answer was written. A deleted task is forgotten. */
function answered(a, w, reply = null, posted = null) {
  inChange();
  if (before(w)) return;
  const op = opOf(a),
    ids = shownOn(a);
  // A copy read once the comment had reached Vikunja, as after a reload, has it already, and the waiting one goes.
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
  // A field the op only guesses (replyOnly) is unsure until a reply or a read says it, also when the op sent nothing
  // because Vikunja seemed to have its change already.
  const guessed = new Set(op.replyOnly(a));
  for (const id of ids) {
    const had = copies.get(id) ?? bases.get(id);
    if (!had) continue;
    const now = real(op.apply(had, a)),
      changed = Object.keys(now).filter(k => !same(had[k], now[k])),
      unsure = changed.filter(k => guessed.has(k));
    made(id, w, Object.fromEntries(changed.filter(k => !guessed.has(k)).map(k => [k, now[k]])));
    doubt(id, unsure);
  }
  if (reply && reply.task.id === opsId(a.task)) answer([reply.task], TASK, reply);
  offTasks(a);
  const deleted = op.deletes(a);
  if (deleted.length) forgetTree(deleted);
}
// Remove a deleted task from the lists on screen, and remember it was deleted, so no read brings it back.
function forget(id) {
  inChange();
  if (!forgotten.has(id)) gone(id);
  touched.add(id);
}
/* Forget deleted tasks, and remove them from every list of related tasks in Vikunja's copies and the rows' bases, and
   so on screen and in the sheet. A step with a second parent then no longer names the parent deleted. */
function forgetTree(ids) {
  for (const id of ids) forget(id);
  for (const [id, t] of copies) if (unrelated(t.related_tasks) !== t.related_tasks) write(id, t, ['related_tasks'], 0);
  for (const [id, t] of bases)
    if (unrelated(t.related_tasks) !== t.related_tasks) {
      bases.set(id, { ...t, related_tasks: unrelated(t.related_tasks) });
      unsaved.add(id);
      touched.add(id);
    }
}
/* Vikunja answered task `id` with 404, as a task deleted in the web app. It is forgotten once nothing points to it
   (forgetLost), and a request that started before then can't bring it back (forgotten). */
function lost(id) {
  inChange();
  missing.add(id);
  forgetLost();
}
// Forget the tasks Vikunja answered with 404 that no outbox entry points to, and that aren't open in the sheet.
function forgetLost() {
  inChange();
  if (!missing.size) return;
  const held = pointed(host),
    ids = [...missing].filter(id => !held.has(id) && host.sheet?.id !== id);
  for (const id of ids) missing.delete(id);
  if (ids.length) forgetTree(ids);
}
/* Drop the copy and the row of each task not in `keep` (sweep). When each field was learnt (`since`) stays, so a read
   that started before then can't bring the task back older (read). */
function prune(keep) {
  inChange();
  for (const id of new Set([...copies.keys(), ...bases.keys(), ...Object.keys(host.tasks).map(idOf)]))
    if (typeof id === 'number' && !keep.has(id)) {
      for (const m of [copies, bases, doubts, given]) m.delete(id);
      delete host.tasks[id];
    }
}
const writers = { read, answer, made, base, leave, keyOps, offTasks, answered, lost, forgetLost, prune };

/* Patch the task as its rows show it (shownAs) into tasks[id] on component `c`. Only the fields that changed are
   written, so the rows of a task that didn't change have nothing to redraw. A field Pocket keeps on a row, such as a
   new task's `parent`, is left as it is, and a field of Vikunja's that the task as shown doesn't have leaves the row. A
   task given to base gets a row if it has none, and its fields lie under the row's.

   A task marked done keeps every field until its batch clears (leaving.js), and clearing the batch shows it. Either
   its op hasn't been answered yet. Or it is a repeating task that Vikunja moved on to its next date, and its row
   would jump to another group as it leaves. A task given to base while it is marked done shows as it was given, as a
   line that arrived done does (arrivedDone, sending.js). */
function show(c, id) {
  const had = c.tasks[id],
    from = given.get(id),
    held = c.leaving[id] === 'done';
  given.delete(id);
  if (!from && (!had || held)) return;
  const t = held ? from : c.shownAs(id),
    all = from && !held ? { ...(copies.has(id) ? pocketOwn(from) : from), ...t } : t;
  if (!had) {
    c.tasks[id] = own(all);
    return;
  }
  const was = raw(had);
  for (const [k, v] of Object.entries(all || {})) if (!same(was[k], v)) had[k] = own(v);
  if (!held && all) for (const k of Object.keys(was)) if (SAVED.includes(k) && !(k in all)) delete had[k];
}

/* read, for a read's promise: allPages(path).then(putting(TASK)). The read starts as putting is called. A task deleted
   meanwhile is left out of the list, so the screen doesn't show it again. A read that started before a user signed out
   gives an empty list, so the screen shows and saves none of the last user's tasks. */
export const putting =
  (asked, at = started()) =>
  list => {
    if (before(at)) return [];
    app.change(w => w.read(list, asked, at));
    return list.filter(t => !forgotten.has(t?.id));
  };
export const copyOf = id => copies.get(id);
export const dropCopies = () => {
  for (const m of [
    copies,
    bases,
    since,
    flying,
    landed,
    opWrites,
    doubts,
    rereading,
    settled,
    forgotten,
    given,
    unsaved,
    missing,
  ])
    m.clear();
  dropped = clock;
  unread = null;
  caughtAt = null;
  shownFrom = Date.now();
};

/* Vikunja's copies are kept on the phone, each under its own key, with the list of their ids. So a screen saved as
   the ids of its tasks opens from them before its load returns, and a save writes only the copies that changed
   (`unsaved`). A task with no copy keeps what its row was made from (bases), as a done parent named by its subtask
   does (readProject). They are in localStorage, since a screen opened from IndexedDB showed its first row no sooner,
   and would wait on a promise. */
let unread = null; // the ids of the copies kept on the phone that the store hasn't read yet, once their list is read
const unsaved = new Set();
const keptCopy = id => copies.get(id) ?? bases.get(id);
/* Read the copies kept on the phone into the store: those of tasks `ids`, or all that are left. A screen saved on the
   phone reads its own tasks' copies first, so its first row isn't held up by the rest (keptScreen). A copy the store
   has already is newer, and a copy read after a write to its task is thrown away (read). */
function restore(c, ids = null) {
  if (!unread) {
    unread = new Set(saved.get('tasks') || []);
    // The phone's copies may be as old as the oldest kept screen's load, so the next catch-up reads from then.
    const oldest = Math.min(
      ...keptScreens()
        .map(k => Date.parse(saved.get(k)?.at))
        .filter(Number.isFinite),
    );
    if (unread.size && oldest < (shownFrom ?? Infinity)) shownFrom = oldest;
  }
  const list = (ids ?? [...unread])
    .filter(id => unread.delete(id) && !copies.has(id))
    .map(id => saved.get('task.' + id))
    .filter(Boolean);
  if (list.length) c.change(w => w.read(list, SAVED, 0));
  for (const t of list) unsaved.delete(t.id); // the phone has them as they are
}
/* Keep on the phone the copies of tasks `ids`, and no others. A copy the phone has that this tab doesn't stays, since
   another tab may have kept it after this tab read the phone's list. */
function keepCopies(c, ids) {
  restore(c);
  const was = new Set(saved.get('tasks') || []),
    kept = [...ids].filter(id => keptCopy(id) || (was.has(id) && !forgotten.has(id)));
  for (const id of was) if (!ids.has(id)) store.del('saved.task.' + id);
  for (const id of kept) if (keptCopy(id) && (unsaved.has(id) || !was.has(id))) saved.set('task.' + id, keptCopy(id));
  unsaved.clear();
  saved.set('tasks', kept);
}
// A sweep waits until the outbox is read, or it would drop the copies of the tasks its entries change.
let outboxRead = false;
sync.ready.then(() => {
  outboxRead = true;
});
// The ids of the tasks the outbox's entries point to.
const pointed = c => {
  const out = new Set();
  for (const e of c.user ? sync.all(c.user.id) : [])
    for (const id of [...(e.kind === 'act' && OPS[e.op] ? shownOn(e) : []), e.task, e.taskId]) out.add(opsId(id));
  return out;
};
/* The ids of the tasks whose copies the store keeps (sweep): those the kept screens show (keptScreens) and those the
   outbox's entries point to, which are kept on the phone too, and on this page the tasks of the screen on display,
   the sheet's task with its parents and subtasks, and the rows marked or holding a message. Each comes with its
   subtasks, which its ring counts. */
function keptIds(c, phone = false) {
  const keep = new Set(),
    add = id => typeof id === 'number' && keep.add(id);
  for (const k of keptScreens()) for (const id of screenIds(saved.get(k)) || []) add(id);
  for (const id of pointed(c)) add(id);
  if (!phone) {
    for (const g of c.view?.groups || []) for (const t of g.tasks) add(t.id);
    for (const cl of c.view?.checklists || [])
      for (const t of [...(cl.runs || []), ...(cl.finished || []), ...(cl.templates || [])]) add(t.id);
    const r = c.view?.shownRun,
      s = c.tasks[c.sheet?.id];
    for (const id of r ? [r.id, ...r.steps] : []) add(id);
    for (const x of [s, ...(s?.related_tasks?.parenttask || []), ...(s?.related_tasks?.subtask || [])]) add(x?.id);
    for (const k of [...Object.keys(c.leaving || {}), ...Object.keys(c.lines || {})]) add(idOf(k));
  }
  for (const id of [...keep]) for (const s of keptCopy(id)?.related_tasks?.subtask || []) add(s.id);
  return keep;
}
// Tasks Vikunja answered with 404. Each is forgotten once no outbox entry points to it and it isn't open in the sheet.
const missing = new Set();
/* Vikunja changes tasks Pocket doesn't hear of, as a teammate's edit or a delete in the web app, so the store catches
   up when Pocket comes back to the screen or the connection comes back (catchUp). It reads what changed since the last
   catch-up started (`caughtAt`), kept on Vikunja's clock, since the phone's clock may be set between catch-ups. It
   also reads what changed since the oldest read behind a copy this page shows, which no catch-up has covered yet
   (`shownFrom`, on the phone's clock): the page's load, or the oldest kept screen's load once the phone's copies are
   read (restore). */
let caughtAt = null,
  shownFrom = Date.now(),
  catching = false;
// How many ids one request names. Some proxies refuse a URL over about 8 KB, and an id takes up to about 12 bytes.
export const ID_CHUNK = 300;

export default {
  /* Run `fn` with the writers, then show each task they touched once, also when `fn` throws. A change inside a change
     joins it. `fn` must not await, since a write after the await would land outside the change. Make the request
     first, then write its answer inside change. Returns what `fn` returns. */
  change(fn) {
    if (!depth) host = this;
    depth++;
    let out;
    try {
      out = fn(writers);
    } finally {
      if (!--depth) {
        const c = host,
          ids = [...touched];
        host = null;
        touched.clear();
        for (const id of ids) show(c, id);
        for (const id of ids) reread(id);
      }
    }
    if (typeof out?.then === 'function')
      throw new Error('change() runs at once. Await the request first, then write its answer inside change().');
    return out;
  },
  // The task as its rows show it: Vikunja's copy, then its waiting ops applied in order. Null when Pocket has neither
  // a copy nor a read of it.
  shownAs(id) {
    const b = copies.get(id) || bases.get(id);
    return b ? this.withOps(id, b) : null;
  },
  // `t` with the ops waiting on task `id` applied in order. A step still being inserted gets its ops this way too.
  withOps(id, t) {
    return this.opsOf(id).reduce((x, a) => opOf(a).apply(x, a), t);
  },
  // The ops waiting in the outbox that change task `id`, in the order they will be sent.
  opsOf(id) {
    return this.opsOn[id] || [];
  },
  // The row for task `t` as a read gave it: the row already on screen, or a new one. Call it outside a change, since
  // a new row is made when the change ends.
  row(t) {
    if (!this.tasks[t.id]) this.change(w => w.base(t));
    return this.tasks[t.id] || null;
  },
  // Read a task into its copy, and return the copy. A read that started before the task's last answer is late (read).
  async readCopy(id) {
    const at = started(),
      t = await api('/tasks/' + id).catch(e => {
        if (e.status === 404) this.change(w => w.lost(id));
        throw e;
      });
    this.change(w => w.read([t], TASK, at));
    return copies.get(id) || null;
  },
  /* Subtask `s` from its parent's list (related_tasks), as its own row shows it. The parent's copy of a subtask is as
     old as the parent's last read and lacks its people and labels, so it is read only for a subtask with no row. */
  subRow(s) {
    return this.tasks[s.id] || s;
  },
  /* Give each subtask of `t` that has no row one, as the sheet opens, so the sheet's subtask rows are the subtasks' own
     rows. Without Vikunja's copy, the row is made from the parent's list (bases), until a read of the subtask comes. */
  subRows(t) {
    const subs = (t?.related_tasks?.subtask || []).filter(s => !this.tasks[s.id]);
    if (subs.length)
      this.change(w => {
        for (const s of subs) w.base(s);
      });
  },
  // The task the sheet shows, as its rows show it. Null while the sheet loads it.
  get sheetTask() {
    return this.sheet.id == null ? null : this.tasks[this.sheet.id] || null;
  },
  // The checklist on its screen, as its rows show it.
  get runTask() {
    const r = this.view.shownRun;
    return r ? this.tasks[r.id] || null : null;
  },
  /* Drop the copies and rows that no kept screen, outbox entry or open screen needs (keptIds), and keep on the phone
     the copies of the kept screens' tasks and the outbox's. Runs when a load replaces a screen's ids (keepScreen), and
     once as Pocket opens. */
  sweep() {
    if (!this.user || !outboxRead) return;
    restore(this);
    this.change(w => {
      w.forgetLost();
      w.prune(keptIds(this));
    });
    keepCopies(this, keptIds(this, true));
  },
  // Save screen `s` on the phone under `key`, as the ids of its tasks, with their copies. A load sweeps the store.
  keepScreen(key, s, fresh = true) {
    if (!this.user) return;
    saved.set(key, savedScreen(s));
    if (fresh) this.sweep();
    else this.keepChanged();
  },
  // Keep on the phone the copies that changed since they were last kept, as Pocket is hidden, so an offline open shows
  // the newest copy Pocket had.
  keepChanged() {
    if (this.user && outboxRead) keepCopies(this, keptIds(this, true));
  },
  /* Read the tasks Vikunja changed since the last catch-up, by `updated` on Vikunja's clock, into the copies the store
     keeps, then forget the tasks Vikunja deleted (findRemoved). Each read follows the store's rule, so one that ran
     while a write to its task was in flight is thrown away. `updated` misses labels, people, reactions, positions and
     subtasks ticked, so each screen's own load still runs. A catch-up that fails is tried again the next time. */
  async catchUp() {
    if (!this.user || this.offline || !outboxRead || catching) return;
    catching = true;
    const from = serverTime(Date.now()),
      was = shownFrom,
      since = Math.min(caughtAt ?? Infinity, was === null ? Infinity : serverTime(was));
    try {
      const at = started(),
        // Vikunja keeps times in whole seconds, so the second the last catch-up started in is read again.
        changed = await allPages(
          '/tasks?' +
            new URLSearchParams([
              ['filter', `updated > '${new Date(since - 1000).toISOString()}'`],
              ['expand', 'reactions'],
              ['expand', 'comment_count'],
            ]),
        );
      this.change(w =>
        w.read(
          changed.filter(t => keptCopy(t.id)),
          TASK_COUNT_REACTIONS,
          at,
        ),
      );
      await this.findRemoved();
      caughtAt = from;
      if (shownFrom === was) shownFrom = null;
    } catch {
      /* tried again the next time */
    } finally {
      catching = false;
    }
  },
  /* Forget the tasks the store keeps that Vikunja no longer has (lost), unless an op points to them. A count of the
     ids that still exist (per_page=1) says whether any is gone. Then the whole list says which, and each is read alone,
     since only Vikunja's 404 for the task itself says it was deleted. Vikunja's /tasks leaves out the tasks of an
     archived project, so only the tasks of the projects Pocket lists are asked about. */
  async findRemoved() {
    const ids = [...new Set([...copies.keys(), ...bases.keys()])].filter(id =>
      this.projById?.has(keptCopy(id)?.project_id),
    );
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const part = ids.slice(i, i + ID_CHUNK),
        q = '/tasks?' + new URLSearchParams({ filter: 'id in ' + part.join(', ') }),
        left = (await api(q + '&per_page=1'))?.total;
      if (left == null || left >= part.length) continue;
      const found = new Set((await allPages(q)).map(t => t.id));
      await inBatches(
        part.filter(id => !found.has(id)),
        6,
        id => this.readCopy(id).catch(() => null),
      );
    }
  },
  // The screen saved on the phone under `key`, with the copies its tasks are shown from. A screen saved before screens
  // were saved as ids is ignored.
  keptScreen(key) {
    const s = saved.get(key),
      ids = s && screenIds(s);
    if (!ids) return null;
    restore(this, ids);
    setTimeout(() => restore(this));
    return s;
  },
  // The rows of the tasks `ids` of a saved screen, from the store's copies. A task with no copy, as one deleted since,
  // is left out.
  rowsOf(ids = []) {
    restore(this, ids);
    const made = ids.filter(id => !this.tasks[id] && keptCopy(id));
    if (made.length)
      this.change(w => {
        for (const id of made) w.base(keptCopy(id));
      });
    return ids.map(id => this.tasks[id]).filter(Boolean);
  },
  // Show each task's waiting ops as the outbox has them now (keyOps).
  keyOutbox() {
    this.change(w => w.keyOps());
  },
  // Whether a waiting delete, held for Restore or not, deletes task `id`.
  beingDeleted(id) {
    return this.opsOf(id).some(a => opOf(a).deletes(a).includes(id));
  },
  // Hide tasks that a waiting delete deletes (beingDeleted), unless their marked rows are waiting for the batch to clear.
  get hiddenRows() {
    return new Set(
      Object.keys(this.opsOn)
        .map(Number)
        .filter(id => !this.leaving[id] && this.beingDeleted(id)),
    );
  },
  rowTask(id) {
    return this.tasks[id] || null;
  },
  removeRow(id) {
    for (const list of [
      ...this.view.groups.map(g => g.tasks),
      ...(this.view.checklists || []).flatMap(cl => [cl.runs, cl.finished]),
    ]) {
      const i = list?.findIndex(t => t.id === id) ?? -1;
      if (i >= 0) list.splice(i, 1);
    }
  },
};
