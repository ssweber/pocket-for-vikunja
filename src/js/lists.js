// The lists Pocket shows, and the copies it keeps for opening without a connection.
import {store} from './util.js';
import {isSet} from './dates.js';
import {hasOwnOrder, stepsOf} from './checklists.js';

// The lists Pocket last loaded, shown when it opens without a connection. Cleared on sign-out.
export const saved = {
  get(k){ try { return JSON.parse(store.get('saved.' + k)); } catch { return null; } },
  set(k, v){ store.set('saved.' + k, JSON.stringify(v)); },
  clear(){ try { for (const k of Object.keys(localStorage)) if (k.startsWith('pocket.saved.')) localStorage.removeItem(k); } catch {} },
};
// Open tasks in a list: dated first, soonest first, then undated, by priority and then newest first.
export const soonestFirst = tasks => [...tasks.filter(t => isSet(t.due_date)).sort((a,b) => new Date(a.due_date) - new Date(b.due_date)),
  ...tasks.filter(t => !isSet(t.due_date)).sort((a,b) => (b.priority||0) - (a.priority||0) || b.id - a.id)];
// The tasks a task is a subtask of: one waiting to be sent names its parent in `parent`.
export const parentIds = t => t.parent ? [t.parent] : (t.related_tasks?.parenttask || []).map(x => x.id);
/* A list with each subtask straight after its parent, when the parent is in the same list, in the parent's order (a run's
   steps as on its screen), and depth: task id -> how many parents up it has there. The others stay where they were, or,
   given `order` (a project's List view: positionOrder, in order.js), are put in it, and so are an ordinary task's
   subtasks. A task waiting to be sent names its parent in `parent`, and goes after the rest. */
export const nestSubtasks = (tasks, order = null) => {
  const ids = new Map(tasks.map(t => [t.id, t])), kids = new Map(), top = [];
  for (const t of tasks) {
    const p = parentIds(t).find(id => id !== t.id && ids.has(id));
    if (p === undefined) top.push(t); else kids.set(p, [...(kids.get(p) || []), t]);
  }
  for (const [p, list] of kids) {
    if (order && !hasOwnOrder(ids.get(p))) { list.sort(order); continue; }
    const line = stepsOf(ids.get(p)).map(s => s.id), at = t => { const i = line.indexOf(t.id); return i < 0 ? line.length : i; };
    list.sort((a, b) => at(a) - at(b));
  }
  if (order) top.sort(order);
  const out = [], depth = {};
  const walk = (t, d) => { if (t.id in depth) return; depth[t.id] = d; out.push(t); for (const k of kids.get(t.id) || []) walk(k, d + 1); };
  for (const t of top) walk(t, 0);
  for (const t of tasks) walk(t, 0);             // tasks that are each other's subtasks: nothing above them to go under
  return {tasks: out, depth};
};
/* The parents a project's open list shows though they're done: a task done with subtasks still open (ticked done in
   Vikunja's web app, say, or a subtask opened again under it). Each is shown struck through, over those subtasks, so
   they aren't left at the top level as if they had none. `tasks`: what its List view gave, open tasks and the subtasks
   of those, done ones too. The ids of those parents, in project `pid`, that aren't open on it. */
export const doneParentIds = (tasks, pid) => {
  const open = new Set(tasks.filter(t => !t.done).map(t => t.id)), out = new Set();
  for (const t of tasks) if (!t.done) for (const p of t.related_tasks?.parenttask || []) if (p.done && p.project_id === pid && !open.has(p.id)) out.add(p.id);
  return [...out];
};
export const viewKey = r => r.name === 'project' ? `project.${r.id}.${r.showDone ? 'done' : 'open'}` : r.name === 'run' ? 'run.' + r.id : r.name;
/* The order in each of Today's groups: Overdue the most urgent first, then the longest overdue; Today and the next 7
   days soonest first; "Added today, no date" newest first, a task not sent yet (no `created`) before them all. A task
   just added or sent goes straight to where the next load will put it, rather than to the bottom first. */
const due = t => +new Date(t.due_date), made = t => t.created ? +new Date(t.created) : Infinity;
export const todayOrder = {
  overdue: (a, b) => (b.priority || 0) - (a.priority || 0) || due(a) - due(b),
  today: (a, b) => due(a) - due(b),
  week: (a, b) => due(a) - due(b),
  nodate: (a, b) => made(b) - made(a),
};
// Today's groups. "Added today, no date" keeps tasks added without a date in view until midnight, so they don't vanish into a project.
export const todayGroups = () => [{key:'overdue', cls:'overdue', title:'Overdue', tasks:[]}, {key:'today', cls:'today', title:'Today', tasks:[]},
  {key:'runs', cls:'', title:'Checklist runs', tasks:[]}, {key:'nodate', cls:'', title:'Added today, no date', tasks:[]}, {key:'week', cls:'', title:'Next 7 days', tasks:[]}];
