/* One object per task: tasks[id] is what every row of that task shows, in every list. show(id) is the only code that
   writes it. It stacks Vikunja's copy, the task's waiting ops and the direct saves still running (edit), and patches
   the result into tasks[id] field by field, so a change shows on all the task's rows at once.

   Every write to what show reads happens inside change(fn), as in Python's `with update():`. fn gets the writers, and
   when it ends, change shows each task they touched once. `copies` holds Vikunja's last copy of each task, written
   field by field by read, answer, made and answered alone, and read through copyOf. Undo compares against it, and the
   screens are saved from it. `opsOn` holds the ops waiting in the outbox by each task they change, and each op shows
   itself through its `apply`. The sheet and a checklist's screen hold ids and read their tasks here (sheetTask, runTask). A
   subtask is read from its own row, never from the copy of it nested in its parent (related_tasks), which says only
   which subtasks there are and in what order (subRow). */
import { app, raw } from '../util.js';
import { api } from '../api.js';
import { intoKeys } from '../lists.js';
import { sync } from '../sync.js';
import { opOf, OPS } from '../ops/index.js';
import { repeats } from '../dates.js';

const forgotten = new Set(); // tasks deleted this session, which copies kept on the phone may still hold
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
const edits = new Map(); // task id -> its direct saves still running, oldest first: {fields}
const bases = new Map(); // task id -> what a row was made from while Vikunja's copy of it is unknown
// Outbox entries that no row shows any more, though they may still be in the outbox: answered, or a held delete undone.
const settled = new Set();

/* Vikunja's copy of a task only moves forward. Vikunja gives no version number, so Pocket orders what it learns by
   when it started each request, on `clock`: a counter, not the time, so two requests in one millisecond keep their
   order. A field of a reply is taken only if its request started after the request behind that field of the copy
   (`since`). A read is also thrown away for a task a write was in flight on at any time while it ran (`flying`,
   `landed`), because it may carry the task from before or after that write, and the next read decides. */
// The time of a request sent before this page loaded. The page doesn't know it, so it counts as before every request
// the page sent.
export const EARLIER = 1;
let clock = EARLIER;
// When a request starts, for read and writes.
export const started = () => ++clock;
const since = new Map(); // task id -> field -> when the request behind that field of its copy started
const flying = new Map(); // task id -> the writes to it in flight (writes)
const landed = new Map(); // task id -> when the last write to it ended
/* A write to Vikunja starts now. `on` gives the values it sets on each task it changes ({id: {field: value}}), and
   made takes those values once Vikunja has made it. Returns the write, for answer and made: `at` is when it started,
   `crossed` the other writes in flight on each of its tasks at the same time, `add(id, fields)` adds a task or fields,
   such as a task the write made, and `end()` ends it once it is answered, fails or comes back unknown. Two writes in
   flight at once can reach Vikunja in either order. So neither's reply is taken for a task both change, and neither's
   own change of a field the other sets to something else. */
export function writes(on = {}) {
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
      const list = flying.get(id) || new Set();
      for (const x of list)
        if (x !== w) {
          w.crossed.set(id, (w.crossed.get(id) || new Set()).add(x));
          x.crossed.set(id, (x.crossed.get(id) || new Set()).add(w));
        }
      flying.set(id, list.add(w));
    },
    end() {
      if (w.ended) return;
      w.ended = true;
      for (const id of w.fields.keys()) {
        flying.get(id)?.delete(w);
        if (!flying.get(id)?.size) flying.delete(id);
        landed.set(id, ++clock);
        reread(id);
      }
    },
  };
  for (const [id, fields] of Object.entries(on)) w.add(idOf(id), fields);
  return w;
}
const UNKNOWN = Symbol('unknown'),
  MOVED = ['done', 'done_at', 'due_date', 'start_date', 'end_date', 'reminders'];
/* Make `request`, a write as writes() takes it, and return its reply with the write, for answer and made. */
export async function writing(on, request) {
  const w = writes(on);
  try {
    return [await request(), w];
  } finally {
    w.end();
  }
}
const opWrites = new Map(); // outbox entry id -> its op's write (sendingOp)
/* The write of op entry `a` as the sender sends it (writes): the tasks it changes, each with what its apply sets
   there. A field the apply sets to the value the copy has is one it sets too, so it is found by applying the op to
   a task with nothing in it as well. The write starts with the op's first request and stays in flight across tries,
   because a request whose reply was lost may still reach Vikunja. It ends once the op stops waiting in the outbox:
   answered, refused or gone (keyOps). The op's change counts from its first request in this session (`at`), also when
   Try again sends it after it was refused. An op sent before this page loaded was made at a time the page doesn't
   know, so it counts from before all of the page's reads (EARLIER) until it makes a request fresh (`start`,
   stageContext). From then on its part made earlier can overwrite a teammate's change the page read, so its tasks are
   read again once it is answered (`replays`). */
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
    }
  const w = writes(on);
  Object.assign(
    w,
    was ? { at: was.at, start: was.start } : { at: a.sent ? EARLIER : w.at, start: w.at, replays: !!a.sent },
  );
  opWrites.set(a.id, w);
  return w;
};
/* When Pocket's writes leave fields of a copy unsure, the task is read again once no write to it is in flight
   (reread), once however many writes left it unsure. Two writes crossed, or Vikunja changed what only its reply can
   say, and that reply wasn't taken. Or a read that may hold a teammate's change was thrown away. A read taken, or a
   reply that brings the field, ends the doubt. */
const doubts = new Map(); // task id -> the fields of its copy that may be old
const rereading = new Set(); // the tasks being read again
// What a read again asks for: every field of a task, and its reactions (expand=reactions).
const REREAD = [...TASK, 'reactions'];
const doubt = (id, fields) => {
  const d = doubts.get(id) || new Set();
  for (const k of fields) if (REREAD.includes(k)) d.add(k);
  if (d.size) doubts.set(id, d);
};
function reread(id) {
  if (!doubts.get(id)?.size || flying.get(id)?.size || rereading.has(id) || forgotten.has(id) || !app) return;
  rereading.add(id);
  const at = started();
  api(`/tasks/${id}?expand=reactions`).then(
    t => {
      rereading.delete(id);
      app.change(w => w.read([t], REREAD, at));
      reread(id); // a write ended while it ran, so the read was thrown away
    },
    () => rereading.delete(id),
  );
}
// Whether a read that started at `at` ran while a write to task `id` was in flight, other than `except`, the write of
// the op the read is part of.
export const overlaps = (id, at, except = null) =>
  [...(flying.get(id) || [])].some(x => x !== except) || (landed.get(id) || 0) > at;
// task id -> the fields of its edits ended since it was last shown, each with whether its save failed (undo). show
// removes such a field from the row when Vikunja's copy doesn't have it either.
const ended = new Map();
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
const drop = (id, e, failed = false) => {
  const rest = (edits.get(id) || []).filter(x => x !== e);
  if (rest.length) edits.set(id, rest);
  else edits.delete(id);
  const m = ended.get(id) || new Map();
  for (const k of Object.keys(e.fields)) m.set(k, failed);
  ended.set(id, m);
  touched.add(id);
};

/* The writers. change() hands them to its fn, and each throws outside a change. */

/* Write each of task `t`'s trusted fields (`asked`) into its copy, from a request that started at `at`, unless the
   copy's field came from a newer request. A write's reply comes after its own change and has the same time, so it
   wins. A saved screen (`at` 0) is judged by its caller instead. A field outside `asked`, or missing from the reply,
   keeps what the copy had, so a list read without expand=reactions keeps the copy's ✅. A trusted null is taken: a
   full read gives `labels: null` for a task with no labels. The copy is a new object each time, because Undo holds the
   one it compared against. Nested lists and objects are shared with the reply. */
function write(id, t, asked, at) {
  const s = since.get(id) || new Map(),
    fresh = asked.filter(k => k in t && (!at || at >= (s.get(k) ?? -1)));
  touched.add(id);
  if (!copies.has(id) && !fresh.length) return;
  const c = { ...copies.get(id) };
  if (!copies.has(id) && bases.has(id)) {
    /* The copy takes the place of what the row was made from, and keeps the changes Vikunja made to it (made), since
       each field's time is known (`since`). Any other field of Vikunja's that only the row had leaves it. */
    const b = bases.get(id),
      m = ended.get(id) || new Map();
    for (const k of s.keys()) if (k in b) c[k] = b[k];
    for (const k of Object.keys(b)) if (SAVED.includes(k) && !m.has(k)) m.set(k, false);
    ended.set(id, m);
    bases.delete(id);
  }
  for (const k of fresh) {
    c[k] = k === 'related_tasks' ? unrelated(t[k]) : t[k];
    if (at) s.set(k, at);
    doubts.get(id)?.delete(k);
  }
  copies.set(id, c);
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
   flight on while it ran. A read without its start time is a bug. A saved screen (`at` 0) is judged by its caller, by
   `updated` (keptRows). */
function read(list, asked, at) {
  inChange();
  if (typeof at !== 'number') throw new Error('A read needs the time it started (started()).');
  for (const t of list) {
    const id = t?.id;
    if (!id || forgotten.has(id)) continue;
    // A read thrown away may hold a teammate's change that no answer brings (reread). A saved screen holds nothing newer.
    if (overlaps(id, at)) {
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
  if (forgotten.has(id)) return;
  if (!copies.has(id)) {
    if (bases.has(id)) {
      const s = since.get(id) || new Map(),
        known = Object.entries(fields).filter(([, v]) => v !== UNKNOWN);
      for (const [k] of known) s.set(k, w.at);
      bases.set(id, { ...bases.get(id), ...Object.fromEntries(known) });
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
    // Vikunja made part of the op at a time this page doesn't know: before a replayed reply came, or before the page
    // loaded (sendingOp).
    ...(w.replayed || w.replays ? REREAD : []),
  ]);
}
// Remove a deleted task's copy, its row, and the row from the lists on screen.
function gone(id) {
  copies.delete(id);
  forgotten.add(id);
  for (const m of [edits, bases, ended, given]) m.delete(id);
  delete host.tasks[id];
  host.removeRow(id);
}
// Give task `t`, as a read or a saved screen gave it, a row, or lay the row it has over it. Without Vikunja's copy,
// the row is made from `t` until a read brings one, without the tasks deleted in this session among its related tasks.
function base(t) {
  inChange();
  if (!copies.has(t.id))
    bases.set(t.id, own(t.related_tasks ? { ...t, related_tasks: unrelated(t.related_tasks) } : t));
  given.set(t.id, t);
  touched.add(t.id);
}
/* Lay `fields` over the task while a direct save runs, in memory only. `ok()` takes the fields off once the save has
   written Vikunja's answer. Vikunja then has those fields, so an older edit still running stops laying them.
   Otherwise its older value would show again. `undo()` takes the fields off, for a failed save. Both are writers too.
   A subtask's edit changes its own row only. */
function edit(id, fields) {
  inChange();
  const e = { fields };
  edits.set(id, [...(edits.get(id) || []), e]);
  touched.add(id);
  return {
    ok: () => {
      inChange();
      const list = edits.get(id) || [];
      for (const x of list.slice(0, Math.max(0, list.indexOf(e))))
        x.fields = Object.fromEntries(Object.entries(x.fields).filter(([k]) => !(k in fields)));
      drop(id, e);
    },
    undo: () => {
      inChange();
      drop(id, e, true);
    },
  };
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
    ids = list => list.map(e => e.id).join(),
    listed = c.user ? sync.all(c.user.id) : [],
    all = listed.filter(e => !e.failed);
  for (const id of settled) if (!listed.some(e => e.id === id)) settled.delete(id);
  // An op that stops waiting, refused or gone from the outbox, has no request left on its way. A refused op keeps its
  // write's time for Try again.
  const waits = new Set(all.map(e => e.id));
  for (const [id, w] of opWrites) {
    if (!waits.has(id)) w.end();
    if (!listed.some(e => e.id === id)) opWrites.delete(id);
  }
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
  for (const id of ids) {
    const had = copies.get(id) ?? bases.get(id);
    if (!had) continue;
    const now = real(op.apply(had, a));
    made(id, w, Object.fromEntries(Object.entries(now).filter(([k, v]) => !same(had[k], v))));
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
      touched.add(id);
    }
}
const writers = { read, answer, made, base, edit, leave, keyOps, offTasks, answered, forget, forgetTree };

/* Patch the task as its rows show it (shownAs) into tasks[id] on component `c`. Only the fields that changed are
   written, so the rows of a task that didn't change have nothing to redraw. A field Pocket keeps on a row, such as a
   new task's `parent`, is left as it is. A task given to base gets a row if it has none, and its fields lie under the
   row's.

   A task marked done keeps every field until its batch clears (leaving.js), and clearing the batch shows it. Either
   its save hasn't been answered yet. Or it is a repeating task that Vikunja moved on to its next date, and its row
   would jump to another group as it leaves. Only an edit made meanwhile reaches it, such as the subtasks closed with
   it, and a failed save takes its fields back. */
function show(c, id) {
  const had = c.tasks[id],
    from = given.get(id);
  given.delete(id);
  if (!had && !from) return;
  const held = had && c.leaving[id] === 'done',
    over = (edits.get(id) || []).reduce((x, e) => ({ ...x, ...e.fields }), {});
  const t = held ? over : c.shownAs(id),
    all = from && !held ? { ...(copies.has(id) ? pocketOwn(from) : from), ...t } : t;
  if (held)
    for (const [k, failed] of ended.get(id) || [])
      if (failed && !(k in over)) {
        const now = c.shownAs(id) || {};
        if (k in now) all[k] = now[k];
        else delete had[k];
        ended.get(id).delete(k);
      }
  if (!had) {
    ended.delete(id);
    c.tasks[id] = own(all);
    return;
  }
  const was = raw(had);
  for (const [k, v] of Object.entries(all || {})) if (!same(was[k], v)) had[k] = own(v);
  if (!held && all) {
    for (const k of ended.get(id)?.keys() || []) if (!(k in all) && k in was) delete had[k];
    ended.delete(id);
  }
}

// read, for a read's promise: allPages(path).then(putting(TASK)). The read starts as putting is called. A task deleted
// meanwhile is left out of the list, so the screen doesn't show it again.
export const putting =
  (asked, at = started()) =>
  list => {
    app.change(w => w.read(list, asked, at));
    return list.filter(t => !forgotten.has(t?.id));
  };
export const copyOf = id => copies.get(id);
export const dropCopies = () => {
  for (const m of [
    copies,
    edits,
    bases,
    since,
    flying,
    landed,
    opWrites,
    doubts,
    rereading,
    ended,
    settled,
    forgotten,
    given,
  ])
    m.clear();
};
// Whether a direct save of task `id` is still running, or of any task without `id`.
export const savesRunning = id =>
  [...(id === undefined ? edits.values() : [edits.get(id) || []])].some(list => list.length);
/* A screen is saved with Vikunja's copy of each task, never its row, so a saved screen holds no waiting op's effect
   and none of Pocket's own fields. A row with no copy is saved as it is. Only a done parent named by its subtask
   (readProject) has none. */
const savedCopies = list => (list || []).map(t => copies.get(t.id) || t);
// A screen as it is saved on the phone: the tasks in its groups, its cards' steps, its checklists and a checklist's
// screen's tasks are copies.
export const savedScreen = s => ({
  ...s,
  ...(s.groups && { groups: s.groups.map(g => ({ ...g, tasks: savedCopies(g.tasks) })) }),
  ...(s.steps && { steps: savedCopies(s.steps) }),
  ...(s.tasks && { tasks: savedCopies(s.tasks) }),
  ...(s.checklists && {
    checklists: s.checklists.map(cl => ({ ...cl, runs: savedCopies(cl.runs), finished: savedCopies(cl.finished) })),
  }),
});

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
  /* The task as its rows show it: Vikunja's copy, then its waiting ops applied in order, then the direct saves still
     running, oldest first. Null when Pocket has neither a copy nor a read of it. */
  shownAs(id) {
    const b = copies.get(id) || bases.get(id);
    if (!b) return null;
    return (edits.get(id) || []).reduce((x, e) => ({ ...x, ...e.fields }), this.withOps(id, b));
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
      t = await api('/tasks/' + id);
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
  /* Rows from a screen saved on the phone, for a screen shown before it has loaded. A saved copy goes into the store
     where there is none, or where it is newer. Tasks deleted since are left out. */
  keptRows(list) {
    const newer = (a, b) => Date.parse(a.updated) > Date.parse(b.updated),
      kept = list.filter(t => !forgotten.has(t.id));
    this.change(w => {
      for (const t of kept) {
        if (!copies.has(t.id) || newer(t, copies.get(t.id))) w.read([t], SAVED, 0);
        if (!this.tasks[t.id]) w.base(t);
      }
    });
    return kept.map(t => this.tasks[t.id]);
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
    for (const g of this.view.groups) {
      const i = g.tasks.findIndex(t => t.id === id);
      if (i >= 0) g.tasks.splice(i, 1);
    }
  },
};
