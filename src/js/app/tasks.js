/* The tasks on screen, one copy of each: tasks[id] is the object every row of a task shows, in every list. A list
   loaded from Vikunja puts its tasks here (keep), and a change saved to one (syncTask) is then on all its rows at once.
   `cache` (util.js) is apart from it: Vikunja's last copy of each task, as it said it, which an Undo compares against
   and a failed save puts back. Not yet here: a task's sheet has a copy of its own (sheet.task), its subtasks are
   Vikunja's copies inside it, and a run's screen has its own steps (view.run). */
import {cache} from '../util.js';

const forgotten = new Set();                     // tasks deleted this session, still in copies kept on the phone

export default {
  // A task as Vikunja has it now, in place of what was kept of it (a list loaded again): the object its rows show.
  keep(t){
    const had = this.tasks[t.id];
    if (!had) { this.tasks[t.id] = {...t}; return this.tasks[t.id]; }
    for (const k of Object.keys(had)) if (!(k in t)) delete had[k];
    return Object.assign(had, t);
  },
  /* Tasks from a copy kept on the phone (a screen shown before it's loaded): each the one on screen already, unless the
     kept copy is newer (loaded in the background since); none deleted since. */
  keptRows(list){
    const newer = (a, b) => Date.parse(a.updated) > Date.parse(b.updated);
    return list.filter(t => !forgotten.has(t.id)).map(t => {
      const had = this.tasks[t.id];
      if (had && !newer(t, had)) return had;
      if (!cache.has(t.id) || newer(t, cache.get(t.id))) cache.set(t.id, t);
      return this.keep(t);
    });
  },
  // A change saved to a task, on its rows.
  syncTask(saved){ const t = this.tasks[saved.id]; if (t) Object.assign(t, saved); },
  // The task of a row on the page, by its id.
  rowTask(id){ return this.tasks[id] || null; },
  removeRow(id){
    for (const g of this.view.groups) { const i = g.tasks.findIndex(t => t.id === id); if (i >= 0) g.tasks.splice(i, 1); }
  },
  // A task deleted: off the list on screen, and forgotten.
  forget(id){ cache.delete(id); delete this.tasks[id]; forgotten.add(id); this.removeRow(id); },
  // Tasks deleted: forgotten, and off the subtasks of those on screen and of the task in the sheet.
  forgetTree(ids){
    for (const id of ids) this.forget(id);
    for (const t of [this.sheet.task, ...Object.values(this.tasks)]) {
      const subs = t?.related_tasks?.subtask;
      if (subs?.some(s => ids.includes(s.id))) t.related_tasks.subtask = subs.filter(s => !ids.includes(s.id));
    }
  },
};
