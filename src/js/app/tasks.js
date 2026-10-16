/* One object per task: tasks[id] is what every row of that task shows, in every list. show(id) is the only code that
   writes it. It stacks Vikunja's copy, the task's waiting ops and the direct saves still running (edit), and patches
   the result into tasks[id] field by field, so a change shows on all the task's rows at once.

   Every write to what show reads happens inside change(fn), as in Python's `with update():`. fn gets the writers, and
   when it ends, change shows each task they touched once. `copies` holds Vikunja's last copy of each task, written
   field by field by read and answer alone, and read through copyOf. Undo compares against it, and the screens are
   saved from it. `opsOn` holds the ops waiting in the outbox by each task they change, and each op shows itself
   through its `apply`. The sheet and a checklist's screen hold ids and read their tasks here (sheetTask, runTask). A
   subtask is read from its own row, never from the copy of it nested in its parent (related_tasks), which says only
   which subtasks there are and in what order (subRow). */
import {app, raw} from '../util.js';
import {api} from '../api.js';
import {intoKeys} from '../lists.js';
import {sync} from '../sync.js';
import {opOf, OPS} from '../ops/index.js';

const forgotten = new Set();                     // tasks deleted this session, which copies kept on the phone may still hold
// Whether a field is the same as Vikunja gave it. Lists and objects compare by content, since Vikunja writes them in one order.
const same = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
// A row gets its own lists and objects, so writing a row never changes Vikunja's copy or an answer.
const own = v => v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;

/* The fields of a task that each kind of request can be trusted for (read, answer), as Vikunja 2.7 answers. A task
   read alone or in a list, and a PATCH reply, has every field in TASK, labels and people included. Reactions, comments
   and the comment count come only with expand=, and are null without it, which would read as "none". A new task's
   reply comes before Pocket adds its labels, people, parent and files. A saved screen holds copies made of these
   fields. */
export const TASK = ['id', 'title', 'description', 'done', 'done_at', 'due_date', 'start_date', 'end_date', 'repeat_after', 'repeat_mode',
  'priority', 'percent_done', 'hex_color', 'is_favorite', 'identifier', 'index', 'position', 'bucket_id', 'cover_image_attachment_id',
  'project_id', 'created', 'created_by', 'updated', 'labels', 'assignees', 'attachments', 'reminders', 'related_tasks'];
export const TASK_COUNT = [...TASK, 'comment_count'];                              // expand=comment_count
export const TASK_COUNT_REACTIONS = [...TASK_COUNT, 'reactions'];                  // expand=comment_count and expand=reactions
export const TASK_COMMENTS = [...TASK, 'comments'];                                // expand=comments
export const TASK_REACTIONS_COMMENTS = [...TASK_COMMENTS, 'reactions'];            // expand=reactions and expand=comments
export const CREATED = TASK.filter(k => !['labels', 'assignees', 'related_tasks', 'attachments'].includes(k));
export const SAVED = [...TASK_REACTIONS_COMMENTS, 'comment_count'];

const copies = new Map();                        // task id -> Vikunja's last copy, holding only fields from those lists
const edits = new Map();                         // task id -> its direct saves still running, oldest first: {fields}
const bases = new Map();                         // task id -> what a row was made from while Vikunja's copy of it is unknown
const answers = new Map();                       // task id -> when its last answer arrived, on `clock`
// Outbox entries that no row shows any more, though they may still be in the outbox: answered, or a held delete undone.
const settled = new Set();
// A counter, not the time, so a read and an answer in the same millisecond keep their order.
let clock = 0;
// When a read starts, for read. A read that started before a task's last answer is late for that task.
export const started = () => ++clock;
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
let depth = 0, host = null;
const writing = () => { if (!depth) throw new Error('Write the store inside change().'); };
/* The id that the ops on task `task` are filed under in opsOn. A step still being inserted is 'pending-' + its entry's
   id until Vikunja has made it, and its own id from then on. Code that looks up a waiting step's ops goes through
   this too, or an op filed under the new id would vanish from the step's row. */
export const opsId = task => typeof task === 'string' ? sync.taskOf(task.replace(/^pending-/, '')) ?? task : task;
// The ids of the tasks an outbox entry changes (an op's `on`).
const shownOn = a => opOf(a).on(a);
// A key of opsOn as the task id it stands for. A task not yet sent has a string id.
const idOf = k => /^\d+$/.test(k) ? +k : k;
const drop = (id, e, failed = false) => {
  const rest = (edits.get(id) || []).filter(x => x !== e);
  if (rest.length) edits.set(id, rest); else edits.delete(id);
  const m = ended.get(id) || new Map();
  for (const k of Object.keys(e.fields)) m.set(k, failed);
  ended.set(id, m); touched.add(id);
};

/* The writers. change() hands them to its fn, and each throws outside a change. */

/* The one door into Vikunja's copies, through read and answer. Write each task's trusted fields (`asked`) into its
   copy. A field outside `asked`, or missing from the reply, keeps what the copy had, so a list read without
   expand=reactions keeps the copy's ✅. A trusted null is taken: a full read gives `labels: null` for a task with no
   labels. The copy is a new object each time, because Undo holds the one it compared against. Nested lists and objects
   are shared with the reply. A task deleted in this session is left out, so a read in flight can't bring it back. */
function write(list, asked, at){
  writing();
  for (const t of list) {
    const id = t?.id;
    if (!id || forgotten.has(id)) continue;
    if (at === undefined) answers.set(id, ++clock);
    else if ((answers.get(id) || 0) > at) continue;
    if (!asked) gone(id);
    else if (copies.has(id) || asked.some(k => k in t)) { const c = {...copies.get(id)}; for (const k of asked) if (k in t) c[k] = t[k]; copies.set(id, c); }
    touched.add(id);
  }
}
/* A read that started at `at` (started()). It leaves alone a task answered since then, because it may carry the task
   as it was before the change. That holds for every task with an answer time, also one shown from what its parent
   says of it (bases). A read without its start time is a bug. */
function read(list, asked, at){
  if (typeof at !== 'number') throw new Error('A read needs the time it started (started()).');
  write(list, asked, at);
}
/* Vikunja's answer to a change Pocket made, and the time it arrived. With `asked` null, Vikunja has deleted the tasks.
   Their copies and rows go, and no read brings them back. */
function answer(list, asked){ write(list, asked); }
// Remove a deleted task's copy, its row, and the row from the lists on screen.
function gone(id){
  copies.delete(id); forgotten.add(id);
  for (const m of [edits, bases, ended, given]) m.delete(id);
  delete host.tasks[id]; host.removeRow(id);
}
// Give task `t`, as a read or a saved screen gave it, a row, or lay the row it has over it. Without Vikunja's copy,
// the row is made from `t` until a read brings one.
function base(t){ writing(); if (!copies.has(t.id)) bases.set(t.id, own(t)); given.set(t.id, t); touched.add(t.id); }
/* Lay `fields` over the task while a direct save runs, in memory only. `ok(answer)` writes Vikunja's answer, if it is
   given, and takes the fields off. Vikunja then has those fields, so an older edit still running stops laying them.
   Otherwise its older value would show again. `undo()` takes the fields off, for a failed save. Both are writers too.
   A subtask's edit changes its own row only. */
function edit(id, fields){
  writing();
  const e = {fields};
  edits.set(id, [...edits.get(id) || [], e]); touched.add(id);
  return {
    ok: got => {
      writing();
      if (got) answer([got], TASK);
      const list = edits.get(id) || [];
      for (const x of list.slice(0, Math.max(0, list.indexOf(e)))) x.fields = Object.fromEntries(Object.entries(x.fields).filter(([k]) => !(k in fields)));
      drop(id, e);
    },
    undo: () => { writing(); drop(id, e, true); },
  };
}
// Mark task `id` as leaving with `kind` (leaving.js), or take its mark off without one.
function leave(id, kind){ writing(); if (kind) host.leaving[id] = kind; else delete host.leaving[id]; touched.add(id); }
/* Write the waiting ops into opsOn, under each task they change, in the order they will be sent. A task whose ops are
   unchanged keeps its list, so only the keys of tasks whose ops changed are written (rule 10). A held delete is not in
   `pending`, but its rows hide at once. It shows only on the tasks it deletes, so their gaps keep Restore until the
   batch clears, and their parent lists them until then. */
function keyOps(){
  writing();
  const c = host, was = raw(c.opsOn), out = {}, ids = list => list.map(e => e.id).join();
  const held = c.user ? sync.all(c.user.id).filter(e => sync.held.has(e.id) && !e.failed) : [], all = [...c.pending, ...held];
  const listed = new Set([...all, ...c.failed || []].map(e => e.id));
  for (const id of settled) if (!listed.has(id)) settled.delete(id);
  for (const e of all) if (e.kind === 'act' && OPS[e.op] && !settled.has(e.id))
    for (const id of shownOn(e)) if (!sync.held.has(e.id) || e.ids.includes(id)) (out[id] ||= []).push(e);
  for (const k of new Set([...Object.keys(was), ...Object.keys(out)])) {
    const a = was[k] || [], b = out[k] || [];
    if (ids(a) === ids(b)) { if (b.length) out[k] = a; continue; }
    touched.add(idOf(k));
  }
  intoKeys(c.opsOn, out, raw);
}
/* Take outbox entry `a` off the tasks it changes, at once and for good, though it may still be in the outbox: once
   Vikunja has answered it, or when Restore takes back a held delete. Returns the ids of those tasks. */
function offTasks(a){
  writing();
  const ids = shownOn(a), was = raw(host.opsOn);
  settled.add(a.id);
  for (const id of ids) {
    touched.add(id);
    const rest = (was[id] || []).filter(e => e.id !== a.id);
    if (rest.length === (was[id] || []).length) continue;
    if (rest.length) host.opsOn[id] = rest; else delete host.opsOn[id];
  }
  return ids;
}
/* An op's answer. Each task the op changes takes the op's apply into Vikunja's copy, then the fields the reply is
   trusted for, and the op stops waiting, all in one change. Vikunja did what the op asked, so its copy has it now,
   also when the reply is not a task, as for a claim, a comment or a ✅. The comment Vikunja made (`posted`) takes the
   place of the op's waiting one. If the op stopped waiting first, a row would show the old value until the answer
   was written. A task shown from what its parent says of it (bases) takes the apply there, with the answer's time. A
   task Pocket has neither copy nor row for gets no time, so the read that brings it is taken. A deleted task is
   forgotten. */
function answered(a, got, posted = null){
  writing();
  const op = opOf(a), ids = shownOn(a);
  const real = t => !t.comments?.some(c => c.id === a.id) ? t : {...t, comments: t.comments.map(c => c.id !== a.id ? c : posted || {...c, waiting: false})};
  for (const id of ids) {
    const had = copies.get(id);
    if (had) { const now = real(op.apply(had, a)); answer([now], Object.keys(now)); }
    else if (bases.has(id)) { bases.set(id, real(op.apply(bases.get(id), a))); answer([{id}], []); }
  }
  if (got?.id === opsId(a.task)) answer([got], TASK);
  offTasks(a);
  const deleted = op.deletes(a);
  if (deleted.length) forgetTree(deleted);
}
// Remove a deleted task from the lists on screen, and remember it was deleted, so no read brings it back.
function forget(id){ answer([{id}], null); }
// Forget deleted tasks, and remove them from the subtasks in Vikunja's copies, and so on screen and in the sheet.
function forgetTree(ids){
  for (const id of ids) forget(id);
  const has = t => t?.related_tasks?.subtask?.some(s => ids.includes(s.id)), left = t => ({...t, related_tasks: {...t.related_tasks, subtask: t.related_tasks.subtask.filter(s => !ids.includes(s.id))}});
  for (const t of copies.values()) if (has(t)) answer([left(t)], ['related_tasks']);
  for (const [id, t] of bases) if (has(t)) { bases.set(id, left(t)); touched.add(id); }
}
const writers = {read, answer, base, edit, leave, keyOps, offTasks, answered, forget, forgetTree};

/* Patch the task as its rows show it (shownAs) into tasks[id] on component `c`. Only the fields that changed are
   written, so the rows of a task that didn't change have nothing to redraw. A field Pocket keeps on a row, such as a
   new task's `parent`, is left as it is. A task given to base gets a row if it has none, and its fields lie under the
   row's.

   A task marked done keeps every field until its batch clears (leaving.js), and clearing the batch shows it. Either
   its save hasn't been answered yet. Or it is a repeating task that Vikunja moved on to its next date, and its row
   would jump to another group as it leaves. Only an edit made meanwhile reaches it, such as the subtasks closed with
   it, and a failed save takes its fields back. */
function show(c, id){
  const had = c.tasks[id], from = given.get(id);
  given.delete(id);
  if (!had && !from) return;
  const held = had && c.leaving[id] === 'done', over = (edits.get(id) || []).reduce((x, e) => ({...x, ...e.fields}), {});
  const t = held ? over : c.shownAs(id), all = from && !held ? {...copies.has(id) ? pocketOwn(from) : from, ...t} : t;
  if (held) for (const [k, failed] of ended.get(id) || []) if (failed && !(k in over)) {
    const now = c.shownAs(id) || {};
    if (k in now) all[k] = now[k]; else delete had[k];
    ended.get(id).delete(k);
  }
  if (!had) { ended.delete(id); c.tasks[id] = own(all); return; }
  const was = raw(had);
  for (const [k, v] of Object.entries(all || {})) if (!same(was[k], v)) had[k] = own(v);
  if (!held && all) { for (const k of ended.get(id)?.keys() || []) if (!(k in all) && k in was) delete had[k]; ended.delete(id); }
}

// read, for a read's promise: allPages(path).then(putting(TASK)). The read starts as putting is called. A task deleted
// meanwhile is left out of the list, so the screen doesn't show it again.
export const putting = (asked, at = started()) => list => { app.change(w => w.read(list, asked, at)); return list.filter(t => !forgotten.has(t?.id)); };
export const copyOf = id => copies.get(id);
export const dropCopies = () => { for (const m of [copies, edits, bases, answers, ended, settled, forgotten, given]) m.clear(); };
// Whether a direct save of task `id` is still running, or of any task without `id`.
export const savesRunning = id => [...id === undefined ? edits.values() : [edits.get(id) || []]].some(list => list.length);
/* A screen is saved with Vikunja's copy of each task, never its row, so a saved screen holds no waiting op's effect
   and none of Pocket's own fields. A row with no copy is saved as it is. Only a done parent named by its subtask
   (readProject) has none. */
const savedCopies = list => (list || []).map(t => copies.get(t.id) || t);
// A screen as it is saved on the phone: the tasks in its groups, its cards' steps, its checklists and a checklist's
// screen's tasks are copies.
export const savedScreen = s => ({...s, ...s.groups && {groups: s.groups.map(g => ({...g, tasks: savedCopies(g.tasks)}))}, ...s.steps && {steps: savedCopies(s.steps)}, ...s.tasks && {tasks: savedCopies(s.tasks)},
  ...s.checklists && {checklists: s.checklists.map(cl => ({...cl, runs: savedCopies(cl.runs), finished: savedCopies(cl.finished)}))}});

export default {
  /* Run `fn` with the writers, then show each task they touched once, also when `fn` throws. A change inside a change
     joins it. `fn` must not await, since a write after the await would land outside the change. Make the request
     first, then write its answer inside change. Returns what `fn` returns. */
  change(fn){
    if (!depth) host = this;
    depth++;
    let out;
    try { out = fn(writers); }
    finally {
      if (!--depth) {
        const c = host, ids = [...touched];
        host = null; touched.clear();
        for (const id of ids) show(c, id);
      }
    }
    if (typeof out?.then === 'function') throw new Error('change() runs at once. Await the request first, then write its answer inside change().');
    return out;
  },
  /* The task as its rows show it: Vikunja's copy, then its waiting ops applied in order, then the direct saves still
     running, oldest first. Null when Pocket has neither a copy nor a read of it. */
  shownAs(id){
    const b = copies.get(id) || bases.get(id);
    if (!b) return null;
    return (edits.get(id) || []).reduce((x, e) => ({...x, ...e.fields}), this.withOps(id, b));
  },
  // `t` with the ops waiting on task `id` applied in order. A step still being inserted gets its ops this way too.
  withOps(id, t){ return this.opsOf(id).reduce((x, a) => opOf(a).apply(x, a), t); },
  // The ops waiting in the outbox that change task `id`, in the order they will be sent.
  opsOf(id){ return this.opsOn[id] || []; },
  // The row for task `t` as a read gave it: the row already on screen, or a new one. Call it outside a change, since
  // a new row is made when the change ends.
  row(t){ if (!this.tasks[t.id]) this.change(w => w.base(t)); return this.tasks[t.id] || null; },
  // Read a task into its copy, and return the copy. A read that started before the task's last answer is late (read).
  async readCopy(id){ const at = started(), t = await api('/tasks/' + id); this.change(w => w.read([t], TASK, at)); return copies.get(id) || null; },
  /* Subtask `s` from its parent's list (related_tasks), as its own row shows it. The parent's copy of a subtask is as
     old as the parent's last read and lacks its people and labels, so it is read only for a subtask with no row. */
  subRow(s){ return this.tasks[s.id] || s; },
  /* Give each subtask of `t` that has no row one, as the sheet opens, so the sheet's subtask rows are the subtasks' own
     rows. Without Vikunja's copy, the row is made from the parent's list (bases), until a read of the subtask comes. */
  subRows(t){
    const subs = (t?.related_tasks?.subtask || []).filter(s => !this.tasks[s.id]);
    if (subs.length) this.change(w => { for (const s of subs) w.base(s); });
  },
  // The task the sheet shows, as its rows show it. Null while the sheet loads it.
  get sheetTask(){ return this.sheet.id == null ? null : this.tasks[this.sheet.id] || null; },
  // The checklist on its screen, as its rows show it.
  get runTask(){ const r = this.view.shownRun; return r ? this.tasks[r.id] || null : null; },
  /* Rows from a screen saved on the phone, for a screen shown before it has loaded. A saved copy goes into the store
     where there is none, or where it is newer. Tasks deleted since are left out. */
  keptRows(list){
    const newer = (a, b) => Date.parse(a.updated) > Date.parse(b.updated), kept = list.filter(t => !forgotten.has(t.id));
    this.change(w => {
      for (const t of kept) {
        if (!copies.has(t.id) || newer(t, copies.get(t.id))) w.read([t], SAVED, 0);
        if (!this.tasks[t.id]) w.base(t);
      }
    });
    return kept.map(t => this.tasks[t.id]);
  },
  // Whether a waiting delete, held for Restore or not, deletes task `id`.
  beingDeleted(id){ return this.opsOf(id).some(a => opOf(a).deletes(a).includes(id)); },
  // Hide tasks that a waiting delete deletes (beingDeleted), unless their marked rows are waiting for the batch to clear.
  get hiddenRows(){ return new Set(Object.keys(this.opsOn).map(Number).filter(id => !this.leaving[id] && this.beingDeleted(id))); },
  rowTask(id){ return this.tasks[id] || null; },
  removeRow(id){
    for (const g of this.view.groups) { const i = g.tasks.findIndex(t => t.id === id); if (i >= 0) g.tasks.splice(i, 1); }
  },
};
