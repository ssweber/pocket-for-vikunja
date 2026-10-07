/* The tasks on screen, one copy of each: tasks[id] is the object every row of a task shows, in every list. A list
   loaded from Vikunja puts its tasks here (keep), and a change saved to one (syncTask) is then on all its rows at once.
   `cache` (util.js) is apart from it: Vikunja's last copy of each task, as it said it, which an Undo compares against
   and a failed save puts back. Not yet here: a task's sheet has a copy of its own (sheet.task), its subtasks are
   Vikunja's copies inside it, and a run's screen has its own steps (view.run). */
import {cache} from '../util.js';

export default {
  // A task as Vikunja has it now, in place of what was kept of it (a list loaded again): the object its rows show.
  keep(t){
    const had = this.tasks[t.id];
    if (!had) { this.tasks[t.id] = {...t}; return this.tasks[t.id]; }
    for (const k of Object.keys(had)) if (!(k in t)) delete had[k];
    return Object.assign(had, t);
  },
  // A change saved to a task, on its rows.
  syncTask(saved){ const t = this.tasks[saved.id]; if (t) Object.assign(t, saved); },
  // The task of a row on the page, by its id.
  rowTask(id){ return this.tasks[id] || null; },
  removeRow(id){
    for (const g of this.view.groups) { const i = g.tasks.findIndex(t => t.id === id); if (i >= 0) g.tasks.splice(i, 1); }
  },
  // A task deleted: off the list on screen, and forgotten.
  forget(id){ cache.delete(id); delete this.tasks[id]; this.removeRow(id); },
};
