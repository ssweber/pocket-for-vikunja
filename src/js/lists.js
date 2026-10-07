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
/* A list with each subtask straight after its parent, when the parent is in the same list, in the parent's order (a run's
   steps as on its screen), and depth: task id -> how many parents up it has there. The others stay where they were, or,
   given `order` (a project's List view: positionOrder, in order.js), are put in it, and so are an ordinary task's
   subtasks. A task waiting to be sent names its parent in `parent`, and goes after the rest. */
export const nestSubtasks = (tasks, order = null) => {
  const ids = new Map(tasks.map(t => [t.id, t])), kids = new Map(), top = [];
  for (const t of tasks) {
    const p = (t.parent ? [t.parent] : (t.related_tasks?.parenttask || []).map(x => x.id)).find(id => id !== t.id && ids.has(id));
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
export const viewKey = r => r.name === 'project' ? `project.${r.id}.${r.showDone ? 'done' : 'open'}` : r.name === 'run' ? 'run.' + r.id : r.name;
// Today's groups. "Added today, no date" keeps tasks added without a date in view until midnight, so they don't vanish into a project.
export const todayGroups = () => [{key:'overdue', cls:'overdue', title:'Overdue', tasks:[]}, {key:'today', cls:'today', title:'Today', tasks:[]},
  {key:'runs', cls:'', title:'Checklist runs', tasks:[]}, {key:'nodate', cls:'', title:'Added today, no date', tasks:[]}, {key:'week', cls:'', title:'Next 7 days', tasks:[]}];
