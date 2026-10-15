/* One object per task: tasks[id] is what every row of that task shows, in every list. A list loaded from Vikunja puts
   its tasks here (keep), and a change saved to a task (syncTask) shows on all its rows at once.

   `copies` is separate. It holds Vikunja's last copy of each task, written field by field (put) and read through
   copyOf. Undo compares against it, a failed save restores from it, and the screens are saved from it. `opsOn` holds
   each task's ops waiting in the outbox, and withWaiting is Vikunja's copy with them applied: the task as it will be.
   Not stored here: the sheet's own copy of its task (sheet.task), the subtasks inside it, and a checklist's steps
   (view.run). */
import {raw} from '../util.js';
import {intoKeys} from '../lists.js';
import {actTaskId} from '../sync.js';
import {OPS} from '../ops/index.js';

const forgotten = new Set();                     // tasks deleted this session, which copies kept on the phone may still hold
// Whether a field is the same as Vikunja gave it. Lists and objects compare by content, since Vikunja writes them in one order.
const same = (a, b) => a === b || (!!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
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
/* Write each task's trusted fields (`asked`) into its copy. A field outside `asked`, or missing from the answer, keeps
   what the copy had, so a list read without expand=reactions keeps the copy's ✅. A trusted null is taken: a full read
   gives `labels: null` for a task with no labels. The copy is a new object each time, because Undo holds the one it
   compared against. Nested lists and objects are shared with the answer, and so with the rows made from it. */
export function put(list, asked){
  for (const t of list) {
    if (!t?.id) continue;
    const c = {...copies.get(t.id)};
    for (const k of asked) if (k in t) c[k] = t[k];
    copies.set(t.id, c);
  }
}
// put, for a read's promise: allPages(path).then(putting(TASK)).
export const putting = asked => list => { put(list, asked); return list; };
export const copyOf = id => copies.get(id);
export const dropCopy = id => copies.delete(id);
export const dropCopies = () => copies.clear();
/* A screen is saved with Vikunja's copy of each task, never its row, so a saved screen holds no waiting op's effect
   and none of Pocket's own fields. A row with no copy is saved as it is. Only a done parent named by its subtask
   (readProject) has none. */
const savedCopies = list => (list || []).map(t => copies.get(t.id) || t);
// A screen as it is saved on the phone: the tasks in its groups, its cards' steps and its checklists are copies.
export const savedScreen = s => ({...s, ...s.groups && {groups: s.groups.map(g => ({...g, tasks: savedCopies(g.tasks)}))}, ...s.steps && {steps: savedCopies(s.steps)},
  ...s.checklists && {checklists: s.checklists.map(cl => ({...cl, runs: savedCopies(cl.runs), finished: savedCopies(cl.finished)}))}});

export default {
  /* Update the one object for task `t` from Vikunja's copy, and return it. Only the fields that changed are written,
     so the rows of a task that didn't change have nothing to redraw. Vikunja sends a new list or object each time
     even when nothing in it changed. `updated` alone isn't enough to compare, because ticking a subtask leaves the
     parent's `updated` as it was, though the parent's ring changes.

     A task marked done stays done until its batch clears (leaving.js), even if Vikunja still has it open. Either its
     save hasn't been answered yet, and the answer brings it up to date. Or it is a repeating task that Vikunja moved
     on to its next date. Then it gets Vikunja's copy when it leaves (toggleDone, actions.js; arrivedDone,
     sending.js). */
  keep(t){
    const had = this.tasks[t.id];
    if (!had) { this.tasks[t.id] = {...t}; return this.tasks[t.id]; }
    if (this.leaving[t.id] === 'done' && had.done && !t.done) return had;
    const was = raw(had);
    for (const k of Object.keys(was)) if (!(k in t)) delete had[k];
    for (const [k, v] of Object.entries(t)) if (!same(was[k], v)) had[k] = v;
    return had;
  },
  /* Rows from a screen saved on the phone, for a screen shown before it has loaded. A saved copy goes into the store
     where there is none, or where it is newer. Each row is the object already on screen, unless the saved copy is
     newer (a background load saved it since). Tasks deleted since are left out. */
  keptRows(list){
    const newer = (a, b) => Date.parse(a.updated) > Date.parse(b.updated);
    return list.filter(t => !forgotten.has(t.id)).map(t => {
      if (!copies.has(t.id) || newer(t, copies.get(t.id))) put([t], SAVED);
      const had = this.tasks[t.id];
      return had && !newer(t, had) ? had : this.keep(t);
    });
  },
  /* Write each task's waiting ops into opsOn, in the order they will be sent. A task whose ops are unchanged keeps its
     list, so only the keys of tasks whose ops changed are written (rule 10). When an op not in SHOWN_OWN_WAY joins or
     leaves a task, the task's rows get withWaiting. */
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
    for (const id of rows) this.putWaiting(id);
  },
  // Vikunja's copy of the task with its waiting ops applied in order: the task as it will be. Null without a copy.
  withWaiting(id){ const t = copies.get(id); return t ? (this.opsOn[id] || []).reduce((x, a) => OPS[a.op].apply(x, a), t) : null; },
  // Put the task as it will be on its rows. A task with no row, or no copy from Vikunja, is left as it is.
  putWaiting(id){ const t = this.tasks[id] && this.withWaiting(id); if (t) this.keep(t); },
  /* Write an op's answer into the copy and take the op off its task in one step. If the op left first, a row would
     show the old value until the answer was written. The answer is a PATCH reply or a read of the task. */
  answered(a, got){
    const id = actTaskId(a), ops = raw(this.opsOn)[id];
    if (got?.id === id) put([got], TASK);
    if (ops?.some(e => e.id === a.id)) { const rest = ops.filter(e => e.id !== a.id); if (rest.length) this.opsOn[id] = rest; else delete this.opsOn[id]; }
    if (!SHOWN_OWN_WAY.includes(a.op)) this.putWaiting(id);
  },
  // Put a saved change on the task's rows.
  syncTask(saved){ const t = this.tasks[saved.id]; if (t) Object.assign(t, saved); },
  rowTask(id){ return this.tasks[id] || null; },
  removeRow(id){
    for (const g of this.view.groups) { const i = g.tasks.findIndex(t => t.id === id); if (i >= 0) g.tasks.splice(i, 1); }
  },
  // Remove a deleted task from the list on screen, and remember it was deleted.
  forget(id){ copies.delete(id); delete this.tasks[id]; forgotten.add(id); this.removeRow(id); },
  // Forget deleted tasks, and remove them from the subtasks of tasks on screen and of the task in the sheet.
  forgetTree(ids){
    for (const id of ids) this.forget(id);
    for (const t of [this.sheet.task, ...Object.values(this.tasks)]) {
      const subs = t?.related_tasks?.subtask;
      if (subs?.some(s => ids.includes(s.id))) t.related_tasks.subtask = subs.filter(s => !ids.includes(s.id));
    }
  },
};
