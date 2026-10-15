/* One object per task: tasks[id] is what every row of that task shows, in every list. show(id) is the only code that
   writes it. It stacks Vikunja's copy, the task's waiting ops and the direct saves still running (edit), and patches
   the result into tasks[id] field by field, so a change shows on all the task's rows at once.

   `copies` holds Vikunja's last copy of each task, written field by field (put) and read through copyOf. Undo compares
   against it, and the screens are saved from it. `opsOn` holds each task's ops waiting in the outbox, and withWaiting
   is Vikunja's copy with them applied: the task as it will be. The sheet and a checklist's screen hold ids and read
   their tasks here (sheetTask, runTask). A subtask in its parent's sheet is part of the parent's related_tasks. */
import {app, raw} from '../util.js';
import {api} from '../api.js';
import {intoKeys} from '../lists.js';
import {actTaskId} from '../sync.js';
import {OPS} from '../ops/index.js';

const forgotten = new Set();                     // tasks deleted this session, which copies kept on the phone may still hold
// Whether a field is the same as Vikunja gave it. Lists and objects compare by content, since Vikunja writes them in one order.
const same = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
// A row gets its own lists and objects, so writing a row never changes Vikunja's copy or an answer.
const own = v => v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
// Ops still shown by their own code. Their rows don't get withWaiting, which would rewrite fields where the copy and the row differ.
export const SHOWN_OWN_WAY = ['done', 'undone', 'skip', 'doneNote', 'note', 'answer', 'finish', 'reopen', 'progress', 'claim', 'unclaim', 'delete', 'position'];

/* The fields of a task that each kind of request can be trusted for (put), as Vikunja 2.7 answers. A task read alone
   or in a list, and a PATCH reply, has every field in TASK, labels and people included. Reactions, comments and the
   comment count come only with expand=, and are null without it, which would read as "none". A new task's reply comes
   before Pocket adds its labels, people, parent and files. A saved screen holds copies made of these fields. */
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
const edits = new Map();                         // task id -> its direct saves still running, oldest first: {fields, entry}
const bases = new Map();                         // task id -> what a row was made from while Vikunja's copy of it is unknown
const answers = new Map();                       // task id -> when its last answer arrived, on `clock`
// A counter, not the time, so a read and an answer in the same millisecond keep their order.
let clock = 0;
// When a read starts, for put. A read that started before a task's last answer is late for that task.
export const started = () => ++clock;
// task id -> the fields of its edits ended since it was last shown. show removes such a field from the row when
// Vikunja's copy doesn't have it either.
const ended = new Map();
// The parent's related_tasks with its subtask `id` changed by `fields`, as new lists and objects.
const withSub = (p, id, fields) => ({...p.related_tasks, subtask: (p.related_tasks?.subtask || []).map(s => s.id === id ? {...s, ...fields} : s)});
const drop = (id, e) => {
  const rest = (edits.get(id) || []).filter(x => x !== e);
  if (rest.length) edits.set(id, rest); else edits.delete(id);
  ended.set(id, new Set([...ended.get(id) || [], ...Object.keys(e.fields)]));
};
/* Write each task's trusted fields (`asked`) into its copy, and return the ids written. A field outside `asked`, or
   missing from the answer, keeps what the copy had, so a list read without expand=reactions keeps the copy's ✅. A
   trusted null is taken: a full read gives `labels: null` for a task with no labels. The copy is a new object each
   time, because Undo holds the one it compared against. Nested lists and objects are shared with the answer.

   `at` is when the read started. A read leaves alone a task answered since then, because it may carry the task as it
   was before the change. Without `at`, the list is an answer to a change, and its time is recorded. */
function write(list, asked, at){
  const ids = [];
  for (const t of list) {
    if (!t?.id) continue;
    if (at === undefined) answers.set(t.id, ++clock);
    else if ((answers.get(t.id) || 0) > at) continue;
    const c = {...copies.get(t.id)};
    for (const k of asked) if (k in t) c[k] = t[k];
    copies.set(t.id, c); ids.push(t.id);
  }
  return ids;
}
// write, then show each task on its rows.
export function put(list, asked, at){ for (const id of write(list, asked, at)) app?.show(id); }
// put, for a read's promise: allPages(path).then(putting(TASK)). The read starts as putting is called.
export const putting = (asked, at = started()) => list => { put(list, asked, at); return list; };
export const copyOf = id => copies.get(id);
export const dropCopy = id => copies.delete(id);
export const dropCopies = () => { for (const m of [copies, edits, bases, answers, ended]) m.clear(); };
// Whether a direct save of task `id` is still running, or of any task without `id`. An edit kept for an op doesn't count.
export const savesRunning = id => [...id === undefined ? edits.values() : [edits.get(id) || []]].some(list => list.some(e => !e.entry));
/* A screen is saved with Vikunja's copy of each task, never its row, so a saved screen holds no waiting op's effect
   and none of Pocket's own fields. A row with no copy is saved as it is. Only a done parent named by its subtask
   (readProject) has none. */
const savedCopies = list => (list || []).map(t => copies.get(t.id) || t);
// A screen as it is saved on the phone: the tasks in its groups, its cards' steps, its checklists and a checklist's
// screen's tasks are copies.
export const savedScreen = s => ({...s, ...s.groups && {groups: s.groups.map(g => ({...g, tasks: savedCopies(g.tasks)}))}, ...s.steps && {steps: savedCopies(s.steps)}, ...s.tasks && {tasks: savedCopies(s.tasks)},
  ...s.checklists && {checklists: s.checklists.map(cl => ({...cl, runs: savedCopies(cl.runs), finished: savedCopies(cl.finished)}))}});

export default {
  /* Patch the task as its rows show it (shownAs) into tasks[id], and return tasks[id]. Only the fields that changed
     are written, so the rows of a task that didn't change have nothing to redraw. A field Pocket keeps on a row, such
     as a new task's `parent`, is left as it is. With `from`, a task as a read gave it, a task with no row gets one,
     and a task with no copy from Vikunja is shown from `from`.

     A task marked done keeps every field until its batch clears (leaving.js), and clearing the batch shows it. Either
     its save hasn't been answered yet. Or it is a repeating task that Vikunja moved on to its next date, and its row
     would jump to another group as it leaves. Only an edit made meanwhile reaches it, such as the subtasks closed with
     it. */
  show(id, from){
    const had = this.tasks[id];
    if (!had && !from) return null;
    if (from && !copies.has(id)) bases.set(id, own(from));
    const held = had && this.leaving[id] === 'done';
    const t = held ? (edits.get(id) || []).reduce((x, e) => ({...x, ...e.fields}), {}) : this.shownAs(id), all = from && !held ? {...from, ...t} : t;
    if (!had) { ended.delete(id); this.tasks[id] = own(all); return this.tasks[id]; }
    const was = raw(had);
    for (const [k, v] of Object.entries(all || {})) if (!same(was[k], v)) had[k] = own(v);
    if (!held && all) { for (const k of ended.get(id) || []) if (!(k in all) && k in was) delete had[k]; ended.delete(id); }
    return had;
  },
  /* The task as its rows show it: Vikunja's copy, then its waiting ops applied in order, then the direct saves still
     running, oldest first. Null when Pocket has neither a copy nor a read of it. */
  shownAs(id){
    const base = copies.get(id) || bases.get(id);
    if (!base) return null;
    const t = (this.opsOn[id] || []).filter(a => !SHOWN_OWN_WAY.includes(a.op)).reduce((x, a) => OPS[a.op].apply(x, a), base);
    return (edits.get(id) || []).reduce((x, e) => ({...x, ...e.fields}), t);
  },
  // The row for task `t` as a read gave it: the row already on screen, or a new one.
  row(t){ return this.tasks[t.id] || this.show(t.id, t); },
  // Read a task into its copy, and return the copy. A read that started before the task's last answer is late (put).
  async readCopy(id){ const at = started(); put([await api('/tasks/' + id)], TASK, at); return copies.get(id) || null; },

  /* Lay `fields` over the task while a direct save runs, in memory only. `ok(answer)` writes Vikunja's answer into the
     copy and takes the fields off in one show. `undo()` takes them off, for a failed save. `until(entry)` keeps them
     until outbox entry `entry` is answered or leaves the outbox, for a change sent as an op.
     `under` is the parent whose sheet lists the task as a subtask. The parent's row gets the fields on that subtask
     too, as an edit of its related_tasks. On `ok`, Vikunja's copy of the parent takes the answer for that subtask, or
     the subtask would show its old value until the parent is read again. */
  edit(id, fields, under = null){
    const e = {fields, entry: null}, up = under != null && this.subOf(under, id) ? this.edit(under, {related_tasks: withSub(raw(this.tasks[under]), id, fields)}) : null;
    edits.set(id, [...edits.get(id) || [], e]);
    this.show(id);
    return {
      ok: got => {
        if (got) write([got], TASK); drop(id, e); this.show(id);
        const c = up && copies.get(under);
        if (c) copies.set(under, {...c, related_tasks: withSub(c, id, own({...fields, ...got}))});
        up?.ok();
      },
      undo: () => { drop(id, e); this.show(id); up?.undo(); },
      until: entry => { e.entry = entry; if (![...this.pending || [], ...this.failed || []].some(x => x.id === entry)) { drop(id, e); this.show(id); } up?.until(entry); },
    };
  },
  // The subtask `id` as the row of its parent `parent` lists it, or null.
  subOf(parent, id){ return (this.tasks[parent]?.related_tasks?.subtask || []).find(s => s.id === id) || null; },
  // The task the sheet shows, as its rows show it. Null while the sheet loads it.
  get sheetTask(){ return this.sheet.id == null ? null : this.tasks[this.sheet.id] || null; },
  // The checklist on its screen, as its rows show it.
  get runTask(){ const r = this.view.shownRun; return r ? this.tasks[r.id] || null : null; },
  /* Rows from a screen saved on the phone, for a screen shown before it has loaded. A saved copy goes into the store
     where there is none, or where it is newer. Tasks deleted since are left out. */
  keptRows(list){
    const newer = (a, b) => Date.parse(a.updated) > Date.parse(b.updated);
    return list.filter(t => !forgotten.has(t.id)).map(t => {
      if (!copies.has(t.id) || newer(t, copies.get(t.id))) put([t], SAVED, 0);
      return this.row(t);
    });
  },
  /* Write each task's waiting ops into opsOn, in the order they will be sent. A task whose ops are unchanged keeps its
     list, so only the keys of tasks whose ops changed are written (rule 10). A task is shown again when an op not in
     SHOWN_OWN_WAY joins or leaves it, or when an op that an edit waits for (until) leaves the outbox. */
  keyOps(){
    const was = raw(this.opsOn), out = {}, rows = new Set(), ids = list => list.map(e => e.id).join();
    for (const e of this.pending) if (e.kind === 'act' && OPS[e.op]) (out[actTaskId(e)] ||= []).push(e);
    for (const k of new Set([...Object.keys(was), ...Object.keys(out)])) {
      const a = was[k] || [], b = out[k] || [];
      if (ids(a) === ids(b)) { if (b.length) out[k] = a; continue; }
      const moved = [...a.filter(x => !b.some(y => y.id === x.id)), ...b.filter(y => !a.some(x => x.id === y.id))];
      for (const e of moved) if (!SHOWN_OWN_WAY.includes(e.op)) rows.add(actTaskId(e));
    }
    intoKeys(this.opsOn, out, raw);
    const live = new Set([...this.pending, ...this.failed || []].map(e => e.id));
    for (const [id, list] of edits) for (const e of list) if (e.entry && !live.has(e.entry)) { drop(id, e); rows.add(id); }
    for (const id of rows) this.show(id);
  },
  // Vikunja's copy of the task with its waiting ops applied in order: the task as it will be. Null without a copy.
  withWaiting(id){ const t = copies.get(id); return t ? (this.opsOn[id] || []).reduce((x, a) => OPS[a.op].apply(x, a), t) : null; },
  /* Write an op's answer into the copy, take the op off its task, and end the edits that waited for it, in one show.
     If the op left first, a row would show the old value until the answer was written. The answer is a PATCH reply
     or a read of the task. An op answered with something else still counts as an answer, for a late read. */
  answered(a, got){
    const id = actTaskId(a), ops = raw(this.opsOn)[id];
    if (got?.id === id) write([got], TASK); else answers.set(id, ++clock);
    if (ops?.some(e => e.id === a.id)) { const rest = ops.filter(e => e.id !== a.id); if (rest.length) this.opsOn[id] = rest; else delete this.opsOn[id]; }
    for (const e of edits.get(id) || []) if (e.entry === a.id) drop(id, e);
    this.show(id);
  },
  rowTask(id){ return this.tasks[id] || null; },
  removeRow(id){
    for (const g of this.view.groups) { const i = g.tasks.findIndex(t => t.id === id); if (i >= 0) g.tasks.splice(i, 1); }
  },
  // Remove a deleted task from the list on screen, and remember it was deleted.
  forget(id){ for (const m of [copies, edits, bases, ended]) m.delete(id); delete this.tasks[id]; forgotten.add(id); this.removeRow(id); },
  // Forget deleted tasks, and remove them from the subtasks in Vikunja's copies, and so on screen and in the sheet.
  forgetTree(ids){
    for (const id of ids) this.forget(id);
    const has = t => t?.related_tasks?.subtask?.some(s => ids.includes(s.id)), left = t => ({...t, related_tasks: {...t.related_tasks, subtask: t.related_tasks.subtask.filter(s => !ids.includes(s.id))}});
    for (const m of [copies, bases]) for (const [id, t] of m) if (has(t)) { m.set(id, left(t)); this.show(id); }
  },
};
