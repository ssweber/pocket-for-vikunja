/* Task actions and their Undo. Lists and sheets call these methods to save, tick, set progress, move, reorder, add
   or delete tasks. Ticks, progress, and actions on a checklist and its steps go through the outbox. Changing a subtask
   also updates the parent's computed progress. Reordering in a project writes List view positions. A template keeps
   its step order in its notes instead. */
import { NetError } from '../api.js';
import { dueInfo, isSet, movedDue, repeats } from '../dates.js';
import { isSubtask, openSubtasks, pctOf } from '../progress.js';
import {
  addedPart,
  addedStopped,
  addedSubs,
  dayWord,
  deleteAsk,
  deletedSaid,
  deletedSteps,
  deletedText,
  deleteTemplateAsk,
  doneLater,
  doneRepeats,
  doneText,
  finishedText,
  movedBack,
  movedText,
  movedTo,
  movedToProject,
  noLongerSub,
  NOT_KEPT,
  notDone,
  notKnown,
  notReordered,
  notMovedBack,
  notSaved,
  placeSaid,
  progressSaid,
  repeatsNext,
  tickSaid,
  toOutbox,
  TRY_AGAIN,
  UNDO,
  waitText,
} from '../messages.js';
import { stepsOf, vikunjaNext } from '../checklists.js';
import { between, listViewOf, placeAfter, placeMove, positionOrder, siblingBlocks } from '../order.js';
import { dayGroup, parentIds } from '../lists.js';
import { itemsOf, sync, uuid7 } from '../sync.js';
import { addLines, cancelling, cancelOf, movedFrom, opOf, personOf, tagOf, waitingPositions } from '../ops/index.js';
import { copyOf, opsId } from './tasks.js';

// How long a held deletion stays valid. After that, another tab or a restarted Pocket may send it. This tab can keep
// its rows longer if a touch or scroll keeps the batch waiting.
const HELD_MS = 60e3;

export default {
  /* On Today, a task ticked there joins Done today when the batch clears, so Copy includes it at once. A checklist's
     step doesn't, since its checklist stands for it. */
  intoDoneToday(ids) {
    const g = this.route.name === 'today' && this.view.groups.find(x => x.key === 'donetoday');
    for (const id of g ? ids : []) {
      const t = this.tasks[id];
      if (t?.done && !this.stepRun(t) && !g.tasks.includes(t)) g.tasks.unshift(t);
    }
  },

  /* ---------- done, and not done again ---------- */
  /* Tick or untick a task from any row or sheet, as a `done` or `undone` op. The op shows on the task's rows at once
     and waits in the outbox while Pocket is offline. A checklist is finished or reopened instead (tickRunTask), and a
     checklist's step is ticked as on its checklist's screen (tickRunStep). Ticking a task leaves its subtasks open
     unless `extra.close` asks to close its open, non-repeating subtasks too, each with an op of its own. Undo undoes
     exactly those ops.

     A ticked list row stays in place from the tap until its op is sent (holdRow). Then it is marked until the batch
     clears, and tapping its tick undoes it. A repeating task shows as done until its next date appears. A tick in a
     sheet shows Undo only when it closed subtasks or the task repeats. `extra.pct` is the progress the user set with
     the tick or untick (setProgress). */
  async toggleDone(t, rowEl, extra = {}) {
    const run = this.stepRun(t);
    if (run) return this.tickRunStep(t, run, rowEl);
    if (this.isRunTask(t)) return this.tickRunTask(t, rowEl);
    const { sub: inSheet, sheet, close = false, pct } = extra,
      sub = inSheet || isSubtask(t),
      was = t.done,
      head = was && this.isHead(t),
      rolls = !was && repeats(t),
      inList = !!rowEl && !sheet && !inSheet;
    // The open subtasks shown to the user, each with its own row, where the ring and the sheet show it closed. The last
    // one's op writes the parent's progress, once they are all done.
    const subs = was || !close ? [] : openSubtasks(t, s => this.row(s));
    const f = {
      id: uuid7(),
      op: was ? 'undone' : 'done',
      task: t.id,
      ...this.upOf(t, inSheet),
      ...(pct !== undefined && { pct }),
      // What the tick of a repeating task moves on, and the progress it sets, which its Undo puts back.
      ...(rolls && { was: { ...movedFrom(t), ...(pct !== undefined && { percent_done: t.percent_done }) } }),
      // The progress an untick at a progress replaces, which its Undo puts back.
      ...(was && pct !== undefined && { was: pctOf(t) }),
    };
    const ops = [
      f,
      ...subs.map((s, i) => ({
        id: uuid7(),
        op: 'done',
        task: s.id,
        run: null,
        ...(i === subs.length - 1 && { up: t.id }),
      })),
    ];
    const sending = this.actAll(ops);
    // The row is held only after the op is on it, because a row held done takes no op until its batch clears.
    const letGo = !was && inList ? this.holdRow(t.id, 'done') : null;
    try {
      const r = await sending;
      if ((r.all.find(x => x.id === f.id) ?? r).status === 'error') return;
      if (sheet) this.sheet.dirty = true;
      let over = false;
      const undo = () => {
        if (over) this.outOfDone(t.id); // the Done count followed the parent shown above its open subtasks (makeHead)
        return this.undoTicks(ops);
      };
      if (rolls) {
        // Vikunja moves the task on to its next date, where Pocket expects it to (vikunjaNext).
        const n = vikunjaNext(t),
          due = n ? new Date(n).toISOString() : t.due_date,
          d = n && dueInfo(due),
          next = d ? 'next ' + d.label : '';
        if (sheet) {
          this.say(repeatsNext(next), { place: 'sheet:top', action: { label: UNDO, fn: undo } });
          return;
        }
        if (!inList) return;
        // The completed row keeps its old date until the batch clears, then shows its next date or leaves Today.
        const beyond = () => this.route.name === 'today' && dayGroup(due) === null;
        this.markRow(t.id, {
          kind: 'done',
          out: () => (beyond() ? [t.id] : []),
          undo,
          said: doneRepeats(t.title, next),
          gone: () => {
            if (beyond()) this.removeRow(t.id);
            else if (this.route.name === 'today') this.regroupToday();
          },
        });
        return;
      }
      if (head) return this.reopenedHead(t, !inList, ops);
      // The subtasks closed with the parent show as done on their own rows.
      const ids = ops.map(x => x.task),
        closed = ids.slice(1);
      // On a project's list, a done parent stays above the subtasks that are still open, which are those that repeat.
      over = !was && !sub && !sheet && this.leftOpenUnder(t) && this.makeHead(t);
      const text = doneText(closed.length, subs.length, t.title);
      // Show the sheet's closed-subtask count and Undo under its subtasks.
      if (sheet || inSheet) {
        if (closed.length) this.say(text, { place: 'sheet:subtasks', action: { label: UNDO, fn: undo } });
        return;
      }
      if (!inList) return;
      // After the batch clears, completed rows leave Today or Open. A completed parent stays above subtasks that are
      // still open.
      const moves = () => !!this.searchGroups(t);
      if (was && !moves()) {
        this.said = tickSaid(false, t.title);
        return;
      }
      this.markRow(t.id, {
        kind: was ? 'open' : 'done',
        ids,
        undo,
        said: was ? tickSaid(false, t.title) : text,
        out: () => (over ? closed : this.bothWays && !moves() ? [] : ids),
        gone: () => {
          if (over) this.moveInSearch(t, closed);
          else if (this.bothWays) this.moveInSearch(t, ids);
          else if (t.done) {
            ids.forEach(id => this.removeRow(id));
            this.intoDoneToday(ids);
          }
        },
      });
    } finally {
      letGo?.();
    }
  },
  // Undo the ops queued from `list` (their fields), from a row's tick or a message's Undo. A task changed since says
  // so on its row (undoOps).
  async undoTicks(list) {
    await this.undoOps(list, false).left;
    this.render();
  },
  /* Where an op on task `t` writes a parent's progress: a checklist's step its checklist's (`run`), and a subtask its
     parent's (`up`). For a subtask in its parent's sheet (`inSheet`) that is the sheet's task. */
  upOf(t, inSheet = false) {
    const run = this.stepRun(t) ?? null,
      up = run ? null : inSheet ? this.sheet.id : isSubtask(t) ? this.parentIdOf(t) : null;
    return { run, ...(typeof up === 'number' && { up }) };
  },
  // Find a task's parent from the task itself, from the open sheet, or from the subtask relations of the loaded tasks.
  parentIdOf(t) {
    const own = parentIds(t)[0],
      has = p => p?.related_tasks?.subtask?.some(s => s.id === t.id);
    return own ?? (has(this.sheetTask) ? this.sheet.id : (Object.values(this.tasks).find(has)?.id ?? null));
  },
  // Whether a done task is shown struck through on a project's open list, above subtasks that are still open
  // (loadProject).
  isHead(t) {
    return (
      !!t?.done &&
      this.route.name === 'project' &&
      !!this.view.groups.find(g => g.key === 'open')?.heads?.includes(t.id)
    );
  },
  // Whether a task on a project's open list has subtasks still open under it there.
  leftOpenUnder(t) {
    const g = this.route.name === 'project' && this.view.groups.find(x => x.key === 'open');
    return (
      !!g &&
      g.tasks.includes(t) &&
      g.tasks.some(x => !x.done && !this.beingDeleted(x.id) && parentIds(x).includes(t.id))
    );
  },
  // Add a completed parent to Done and its count, while its heading stays on the open list above its open subtasks.
  makeHead(t) {
    const open = this.view.groups.find(x => x.key === 'open'),
      done = this.view.groups.find(x => x.key === 'done');
    open.heads = [...new Set([...(open.heads || []), t.id])];
    if (done?.loaded && !done.tasks.includes(t)) done.tasks.unshift(t);
    if (typeof done?.count === 'number') done.count++;
    return true;
  },
  /* Reopen a completed parent in place above its open subtasks and remove it from Done. Unless `quiet`, the row is
     marked, so tapping its tick undoes the untick, the ops queued from `list`. */
  reopenedHead(t, quiet, list) {
    this.outOfDone(t.id);
    if (quiet) return;
    this.markRow(t.id, { kind: 'open', out: [], said: tickSaid(false, t.title), undo: () => this.undoTicks(list) });
  },
  // Remove a reopened task from Done and lower the count. The count is lowered even if Done has not loaded.
  outOfDone(id) {
    const g = this.view.groups.find(x => x.key === 'done');
    if (!g) return;
    const i = g.tasks.findIndex(x => x.id === id);
    if (i >= 0) g.tasks.splice(i, 1);
    if ((i >= 0 || !g.loaded) && typeof g.count === 'number') g.count = Math.max(0, g.count - 1);
  },
  /* Finish or reopen a checklist through the outbox, leaving its steps as they are. The ring asks before finishing
     a checklist that has open steps. A list row is marked until the batch clears, and tapping the ring undoes it. */
  async tickRunTask(t, rowEl) {
    const was = t.done,
      head = was && this.isHead(t),
      f = { id: uuid7(), op: was ? 'reopen' : 'finish', task: t.id, run: t.id };
    const r = await this.act(f);
    if (r.status === 'error') return;
    // A finished checklist shown above steps that are still open (isHead) stays in place when reopened. It only
    // leaves Done.
    if (head) return this.outOfDone(t.id);
    const offline = r.status === 'offline',
      said = was ? tickSaid(false, t.title) : finishedText(t.title, offline);
    const undo = () => this.undoTicks([f]);
    // Without a visible row, show Undo at the top of the sheet, or in a toast.
    if (!rowEl) {
      if (!was)
        this.say(offline ? finishedText('', true) : said, { place: 'sheet:top', action: { label: UNDO, fn: undo } });
      return;
    }
    const moves = () => !!this.searchGroups(t),
      steps = () => stepsOf(t).map(s => s.id);
    if (was && !moves()) {
      this.said = said;
      return;
    }
    this.markRow(t.id, {
      kind: was ? 'open' : 'done',
      undo,
      said,
      out: () => (this.bothWays && !moves() ? [] : [t.id]),
      gone: () => {
        if (this.bothWays) this.moveInSearch(t, [t.id]);
        else if (t.done) {
          [t.id, ...steps()].forEach(id => this.removeRow(id));
          this.intoDoneToday([t.id]);
        }
      },
    });
  },
  /* Tick a checklist step through the outbox, which records who did it and works offline. The op shows the tick on
     the step's row while it waits. A list row waits for the batch to clear. In a sheet the step stays visible as done. */
  async tickRunStep(t, run, rowEl) {
    const was = t.done,
      f = { id: uuid7(), op: was ? 'undone' : 'done', task: t.id, run },
      acting = this.act(f);
    // Hold the row until the outbox has sent the tick, as toggleDone does. The row is held only after the op is on it,
    // because a row held done takes no op until its batch clears.
    const letGo = !was && rowEl ? this.holdRow(t.id, 'done') : null;
    try {
      const r = await acting;
      if (r.status === 'error') return;
      const later = !was && r.status === 'offline' ? doneLater(t.title) : '';
      // In a sheet while offline, the step's row says it will be sent later.
      if (!rowEl) {
        if (later) this.say(later, { row: { id: t.id, text: doneLater(), stays: true }, place: 'sheet:top' });
        return;
      }
      const moves = () => !!this.searchGroups(t);
      if (was && !moves()) {
        this.said = tickSaid(false, t.title);
        return;
      }
      this.markRow(t.id, {
        kind: was ? 'open' : 'done',
        said: later || tickSaid(!was, t.title),
        undo: () => this.undoTicks([f]),
        out: () => (this.bothWays && !moves() ? [] : [t.id]),
        gone: () => {
          if (this.bothWays) this.moveInSearch(t, [t.id]);
          else if (t.done) this.removeRow(t.id);
        },
      });
    } finally {
      letGo?.();
    }
  },
  // In search and in a project, Open and Done show together. Returns the group a task is in and the group its tick
  // moves it to, or null.
  searchGroups(t) {
    if (!this.bothWays) return null;
    const from = this.view.groups.find(g => g.key === (t.done ? 'open' : 'done')),
      to = this.view.groups.find(g => g.key === (t.done ? 'done' : 'open'));
    return from && to && from.tasks.some(x => x.id === t.id) ? { from, to } : null;
  },
  /* Move completed tasks and closed subtasks to the top of Done, or reopened tasks back to Open. In a project,
     reopened tasks go back to their List view positions. If Done has not loaded, only its count changes. Returns
     whether a row moved. */
  moveInSearch(t, ids) {
    const g = this.searchGroups(t);
    if (!g) return false;
    for (const id of ids) {
      const i = g.from.tasks.findIndex(x => x.id === id);
      if (i < 0) continue;
      const [x] = g.from.tasks.splice(i, 1);
      if (g.to.loaded !== false && !g.to.tasks.includes(x)) g.to.tasks.unshift(x);
      for (const k of ['from', 'to']) if (typeof g[k].count === 'number') g[k].count += k === 'to' ? 1 : -1;
    }
    if (this.route.name === 'project' && !t.done) this.render();
    return true;
  },
  // Tick the sheet's task, the same as a row's tick, with the progress the user set (`pct`), if any.
  async sheetDone(pct) {
    const t = this.sheetTask;
    if (!t) return;
    await this.toggleDone(t, null, { sheet: true, ...(pct !== undefined && { pct }) });
    this.sheet.dirty = true;
  },
  // Tick a subtask in its parent's sheet, the same as in a list. A checklist's step is ticked as on the checklist's
  // own screen.
  async toggleSubtask(st) {
    if (this.checklistRole === 'run') await this.tickRunStep(st, this.sheet.id, null);
    else await this.toggleDone(st, null, { sub: true });
    this.sheet.dirty = true;
  },

  /* ---------- progress ---------- */
  /* Set progress on a list row or a sheet subtask, as a `progress` op. At 100% the task is ticked, and a repeating task
     starts its next date at 0%. Below 100% a done task is unticked at that progress, and any other task shows the new
     progress on its tick. A change of progress shows no message, so the next swipe is not blocked. Sliding back is its
     undo. `sub` says the task is a subtask in its parent's sheet. */
  async setProgress(t, pct, rowEl, { sub = false } = {}) {
    if (t.done && pct < 100) return this.toggleDone(t, rowEl, { pct, sub });
    if (pct >= 100) return t.done ? undefined : this.toggleDone(t, rowEl, { sub, ...(repeats(t) && { pct: 0 }) });
    const r = await this.act({ id: uuid7(), op: 'progress', task: t.id, ...this.upOf(t, sub), pct, was: pctOf(t) });
    if (r.status !== 'error') this.said = progressSaid(pct, t.title);
  },
  // Set progress from the sheet the same way a list does. 100% ticks the task.
  async sheetProgress(t, pct) {
    if (t.done && pct < 100) return this.toggleDone(t, null, { pct, sheet: true }); // reopens at that progress
    if (pct >= 100) return t.done ? undefined : this.sheetDone(repeats(t) ? 0 : undefined);
    const r = await this.act({ id: uuid7(), op: 'progress', task: t.id, ...this.upOf(t), pct, was: pctOf(t) });
    this.sheet.dirty = true;
    if (r.status !== 'error') this.said = progressSaid(pct);
  },

  /* ---------- moving ---------- */
  // Whether the open task can move to another project. A template, a checklist and their steps can't, because Pocket
  // finds them by their checklist project.
  get canMove() {
    return this.sheet.kind === 'task' && this.canEdit && [null, 'candidate'].includes(this.checklistRole);
  },
  /* Move the open task to project `pid`, with its subtasks at every level, as one `project` op. The task and its
     subtasks show in the new project at once, and the op waits in the outbox while Pocket is offline. The message at
     `at` has an Undo, which puts each back in the project it came from, unless it has moved since. */
  async moveTask(pid, at = 'sheet:props') {
    const t = this.sheetTask,
      from = t?.project_id;
    if (!t || pid === from || !this.canMove) return;
    const subs = (await this.subtaskTree(t.id)).filter(s => s.project_id !== pid),
      title = id => this.projById.get(id)?.title;
    const f = {
      id: uuid7(),
      op: 'project',
      task: t.id,
      pid,
      subs: Object.fromEntries(subs.map(s => [s.id, pid])),
      was: Object.fromEntries([t, ...subs].map(s => [s.id, s.project_id])),
      into: title(pid),
      from: title(from),
      run: null,
    };
    const r = await this.act(f);
    this.sheet.dirty = true;
    if (r.status === 'error') return;
    const undo = async () => {
      if (!(await this.undoOps([f], false).left)) this.said = movedBack(title(from));
      this.sheet.dirty = true;
    };
    this.say(movedToProject(title(pid), subs.length), {
      place: at,
      action: { label: UNDO, fn: undo },
    });
  },
  /* Task `id`'s subtasks at every level, each once, as their rows show them. A subtask Pocket has no copy of is read
     first, so its own subtasks are found too. Offline, such a subtask is found without its subtasks. */
  async subtaskTree(id) {
    const out = [],
      seen = new Set([id]);
    const walk = async tid => {
      for (const s of this.shownAs(tid)?.related_tasks?.subtask || []) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        if (!copyOf(s.id)) await this.readCopy(s.id).catch(() => null);
        out.push(this.shownAs(s.id) || s);
        await walk(s.id);
      }
    };
    await walk(id);
    return out;
  },
  /* Detach the open subtask from all its parents and keep it in its project, with an `unlink` op for each parent, which
     writes that parent's progress last. If the first parent's List view position is known, the task is placed just
     after the parent. Undo undoes the ops and puts the position back. A checklist step or a template step cannot be
     detached, because the order notes still name it. */
  get canOwn() {
    return this.sheet.kind === 'task' && this.canEdit && !!this.parentTask && !this.checklistRole;
  },
  async ownTask() {
    const t = this.sheetTask;
    if (!this.canOwn) return;
    const parents = t.related_tasks.parenttask,
      first = parents[0],
      ids = parents.map(p => p.id);
    const view = listViewOf(this.projById.get(t.project_id))?.id,
      at = this.positions[first.id],
      was = this.positions[t.id];
    // Each op records the parents the task has before it, for its Undo.
    const ops = parents.map((p, i) => ({
      id: uuid7(),
      op: 'unlink',
      task: t.id,
      up: p.id,
      over: p.title,
      was: ids.slice(i),
      run: null,
    }));
    // The task goes right after its first parent, before the task that follows the parent on the list on screen.
    let pos = null;
    if (view && at && (copyOf(first.id)?.project_id ?? first.project_id) === t.project_id) {
      const g =
        this.route.name === 'project' &&
        this.view.project?.id === t.project_id &&
        this.listGroups.find(x => x.key === 'open');
      const tops = g ? g.tasks.filter(x => !g.depth[x.id] && !x.pending) : [],
        i = tops.findIndex(x => x.id === first.id);
      pos = between(at, i < 0 ? at : this.positions[tops[i + 1]?.id] || null);
    }
    // A refused move puts the task back itself (positionRefused).
    const place = p => {
      const had = this.positions[t.id];
      this.positions[t.id] = p;
      return this.act({ op: 'position', task: t.id, view, pos: p, was: had, run: null });
    };
    const r = await this.actAll(ops);
    this.sheet.dirty = true;
    if (r.all.some(x => x.status === 'error')) return;
    if (pos !== null) await place(pos);
    if (this.cursor?.id === t.id) this.aim(this.tasks[t.id]); // keeps the add box on the task at its new level
    // The last parent's op is undone first, so each Undo finds the parents its op left.
    const undo = async () => {
      await this.undoOps([...ops].reverse(), false).left;
      if (pos !== null && was) await place(was);
      this.sheet.dirty = true;
    };
    this.say(noLongerSub(ops.length, first.title), {
      place: 'sheet:top',
      action: { label: UNDO, fn: undo },
    });
  },
  // Whether Move all to today has anything to move. Repeating tasks and repeating checklists don't count.
  get overdueMovable() {
    return this.overdueTasks.some(t => !repeats(t) && this.role(t) !== 'template');
  },
  /* Move overdue tasks to today, keeping their time of day. Repeating tasks and repeating checklists stay, because
     moving them would change their schedule. Each task's move is a `due` op, and they are queued together, so the
     message under Overdue shows at once, online or offline. Its Undo undoes each op. A move Vikunja refuses stays in
     the Outbox, as any op does. */
  async moveOverdueToToday() {
    // A card counts its own task and those of its subtasks that are overdue themselves (overdueTasks).
    const overdue = this.overdueTasks,
      tasks = overdue.filter(t => !repeats(t) && this.role(t) !== 'template');
    const tpl = overdue.filter(t => this.role(t) === 'template').length,
      stay = overdue.length - tasks.length - tpl;
    const stays = [
      stay &&
        `${stay === 1 ? '1 repeating task stays' : stay + ' repeating tasks stay'}. Tick ${stay === 1 ? 'it' : 'them'} to move ${stay === 1 ? 'it to its' : 'them to their'} next date.`,
      tpl &&
        `${tpl === 1 ? '1 checklist stays' : tpl + ' checklists stay'}. Start ${tpl === 1 ? 'it' : 'them'} to move ${tpl === 1 ? 'it to its' : 'them to their'} next date.`,
    ]
      .filter(Boolean)
      .join(' ');
    if (!tasks.length && stays) {
      this.say(movedText(0, stays), { place: 'overdue' });
      return;
    }
    if (!tasks.length || this.movingOverdue) return;
    this.movingOverdue = true;
    const now = new Date(),
      moves = tasks.map(t => ({
        id: uuid7(),
        op: 'due',
        task: t.id,
        was: t.due_date,
        due: movedDue(t.due_date, now, now),
        run: null,
      }));
    const sending = this.actAll(moves);
    const undo = async () => {
      const { left } = this.undoOps(moves);
      this.render();
      const k = await left;
      if (k) {
        this.say(notMovedBack(k, 'today'), { place: 'overdue', cls: 'failed' });
        this.render();
      }
    };
    this.say(movedText(moves.length, stays), {
      place: 'overdue',
      action: { label: UNDO, fn: undo },
    });
    this.render();
    await sending;
    this.movingOverdue = false;
  },
  /* Move a held Today row to `to.due` at once, as a `due` op, and offer Undo. On a card, only the parent's date
     changes. If an earlier subtask keeps the card where it is, a message beside the add box says why. Undo is shown
     on the destination row, or beside the add box if the row left Today or is offscreen. Undo undoes the op, sent or
     not. When Vikunja refuses the move, the op leaves the outbox, and the task goes back to its old group with Try
     again. */
  async reschedule(t, to) {
    const c = this.view.cards?.[t.id],
      key = isSet(t.due_date) ? undefined : this.todayKey(t);
    const op = { id: uuid7(), op: 'due', task: t.id, was: t.due_date, due: to.due, run: null },
      sending = this.act(op, true);
    this.placeOnToday(t, to.due);
    // A task due on that date goes in the same group as a task waiting to be sent with that date (pendingPlace).
    const want = this.pendingPlace({ due_date: to.due }),
      kept =
        c && this.todayKey(t) !== want && c.when !== t.due_date
          ? this.cardSubs(t, false)
              .filter(s => !s.done && isSet(s.due_date))
              .sort((a, b) => Date.parse(a.due_date) - Date.parse(b.due_date))[0]
          : null;
    // Undo puts the task back and highlights it at once. It places the task by the date the row then shows, because
    // Undo of a move that replaced an earlier one goes back to the date before both.
    const place = () => this.placeOnToday(t, t.due_date, key);
    let failed = false,
      undone = false;
    const undo = {
      label: UNDO,
      fn: async () => {
        if (failed) return;
        undone = true;
        const { left } = this.undoOps([op]);
        place();
        this.flash([t.id], 'arrived');
        if (!(await left)) return;
        place();
        this.say(notMovedBack(1, to.label && dayWord(to.label), t.title), { place: 'cap', cls: 'failed' });
      },
    };
    await this.$nextTick(); // waits until the row has moved
    const text = movedTo(to.label, kept?.title);
    const where = this.say(text, {
      row: !kept && this.rowSeen(t.id) ? { id: t.id, stays: true } : null,
      place: 'cap',
      action: undo,
    });
    const r = await sending;
    // An Undo tapped while the move was being sent deals with a refusal itself.
    if (r.status !== 'error' || undone) return r.status !== 'error';
    // A move whose answer is unknown stays in the Outbox, where the user checks it first.
    const e = r.error,
      unknown = e.code === 'unknown';
    failed = true;
    if (!unknown) {
      await sync.lock(() => sync.remove(r.entry));
      this.refreshPending();
    }
    place();
    if (where === 'place' && this.places.cap?.text === text) this.endPlace('cap', this.places.cap, false); // the move failed, so the Undo beside the add box has nothing to undo
    await this.$nextTick(); // waits until a task that left Today has its row back
    this.say(unknown ? notKnown(e.what) : notSaved(e.what, e.message), {
      row: { id: t.id, stays: true, cls: 'failed' },
      place: 'cap',
      action: unknown ? toOutbox(this) : { label: TRY_AGAIN, fn: () => this.reschedule(t, to) },
    });
    return false;
  },
  // The key of the Today group that task `t` is in, or null.
  todayKey(t) {
    return this.view.groups.find(g => g.tasks.some(x => x.id === t.id))?.key ?? null;
  },
  /* Put task `t`, whose row already has the date `due`, in the Today group for that date, or remove it from Today if
     the date is beyond the next seven days. A card uses the earliest date of its parent and open subtasks. A task
     without a date goes in the group `key`, which is the Added today, no date group by default. */
  placeOnToday(t, due, key = 'nodate') {
    const c = this.view.cards?.[t.id];
    if (c)
      c.when = [
        due,
        ...this.cardSubs(t, false)
          .filter(s => !s.done)
          .map(s => s.due_date),
      ]
        .filter(isSet)
        .reduce((a, b) => (!a || Date.parse(b) < Date.parse(a) ? b : a), null);
    const k = dayGroup(c ? c.when : due),
      groups = this.view.groups,
      into = k && groups.find(g => g.key === (k === 'nodate' ? key : k));
    for (const g of groups) g.tasks = g.tasks.filter(x => x.id !== t.id);
    into?.tasks.push(t);
    this.regroupToday();
  },

  /* ---------- reordering ---------- */
  /* Move `t` among its siblings `sibs` in the project's List view `view`. The screen updates at once, and the new
     positions are queued through the outbox. If Vikunja refuses one, that task goes back (positionRefused), and so do
     the ones not queued yet. If Vikunja renumbers the positions, positionSent reloads the view. Returns whether the
     task moved. */
  async reorder(t, sibs, to, view) {
    const from = sibs.findIndex(s => s.id === t.id);
    if (from < 0 || to === from || to < 0 || to >= sibs.length || !view) return false;
    const writes = placeMove(
      sibs.map(s => ({ id: s.id, pos: this.positions[s.id] || 0 })),
      from,
      to,
    );
    const was = Object.fromEntries(writes.map(([id]) => [id, this.positions[id]]));
    for (const [id, pos] of writes) this.positions[id] = pos;
    this.said = placeSaid(t.title, to + 1, sibs.length);
    for (const [i, [id, pos]] of writes.entries()) {
      const r = await this.act({ op: 'position', task: id, view, pos, was: was[id], run: null });
      if (r.status !== 'error') continue;
      for (const [rest] of writes.slice(i + 1)) this.positions[rest] = was[rest];
      return false;
    }
    this.saveProject();
    return true;
  },
  // Reload the list if Vikunja renumbered the position instead of keeping the value sent.
  positionSent(a) {
    if (typeof a.got !== 'number' || Math.abs(a.got - a.pos) < 1e-6) return;
    this.positions[a.task] = a.got;
    if (this.route.name === 'project') this.render();
    if (this.sheet.subView) this.loadSubOrder(this.sheetTask);
  },
  // Put a refused move's task back where it was, or where a later move of it still waiting puts it, and say why.
  positionRefused(a, error) {
    this.positions[a.task] = waitingPositions(this.pending.filter(e => e.id !== a.id))[a.task] ?? a.was;
    this.say(notReordered(error), { row: { id: a.task, stays: true, cls: 'failed' }, place: 'sheet:top' });
    if (this.route.name === 'project') {
      this.render();
      this.saveProject();
    }
    if (this.sheet.subView) this.loadSubOrder(this.sheetTask);
  },
  // Move a task one position up (-1) or down (1) from its menu. `where` is passed to orderOf.
  moveBy(t, dir, where) {
    const o = this.orderOf(t, where),
      i = o ? o.sibs.findIndex(s => s.id === t.id) : -1;
    return i >= 0 ? this.reorder(t, o.sibs, i + dir, o.view) : false;
  },
  /* Returns {sibs, view, blocks} for reordering a task among its siblings, or null if it can't be reordered. In a
     list, each sibling's block includes its subtasks. In a sheet, the loaded subtask order is used. For the sheet's
     own task, the visible list or the parent's known subtask order is used. Done, pending, read-only and
     cross-project subtasks are left out. So are template steps and checklist steps, which keep their order in notes. */
  orderOf(t, where) {
    if (!t || t.pending || t.done || this.lines[t.id] || this.leaving[t.id] || !this.canWrite(t.project_id))
      return null;
    const under = p => !!p && !this.hasOwnOrder(p) && p.project_id === t.project_id;
    if (where === 'sheet')
      return this.sheet.subView && under(this.sheetTask) ? { sibs: this.subtasks, view: this.sheet.subView } : null;
    const g =
      this.route.name === 'project' &&
      this.view.listView &&
      this.view.project?.id === t.project_id &&
      this.listGroups.find(x => x.key === 'open');
    if (g && g.tasks.some(x => x.id === t.id)) {
      const blocks = siblingBlocks(g.tasks, g.depth, t.id).filter(b => !b.task.pending);
      const parent = g.depth[t.id] && g.tasks[g.tasks.findIndex(x => x.id === blocks[0].id) - 1];
      return !parent || under(parent) ? { sibs: blocks.map(b => b.task), view: this.view.listView, blocks } : null;
    }
    if (where !== 'own') return null;
    // Reorder among the parent's subtasks, as Vikunja last returned them.
    const pid = t.related_tasks?.parenttask?.[0]?.id,
      parent = pid && (this.tasks[pid] || copyOf(pid));
    const subs = under(parent) && parent.related_tasks?.subtask,
      view = listViewOf(this.projById.get(t.project_id))?.id;
    if (!subs?.length || !view || subs.some(s => !(s.id in this.positions))) return null;
    return { sibs: [...subs].sort(positionOrder(this.positions)), view };
  },
  // Whether the ⋯ menu's Up one place and Down one place apply to the open task, or null if neither does.
  get sheetMoves() {
    const t = this.sheetTask,
      o = this.sheet.kind === 'task' && this.orderOf(t, 'own'),
      i = o ? o.sibs.findIndex(s => s.id === t.id) : -1;
    return i < 0 ? null : { up: i > 0, down: i < o.sibs.length - 1 };
  },

  /* ---------- adding subtasks ---------- */
  /* Subtasks typed in a subtask box are queued like quick add, so they appear at once and survive a lost
     connection. The sheet's box inserts at its selected row, or at the end. The list's box inserts at the cursor and
     then follows each newly added subtask. List view positions are saved so Vikunja doesn't put the new subtasks
     first. The input keeps focus, and a mistake is fixed by deleting the row and using Undo. */
  /* Positions for `n` new sheet subtasks. They go after the selected row or its latest pending addition, or last
     when the box is at the end. Returns null until the order is known. No position is one that another task
     already has. */
  subPlaces(n) {
    const s = this.sheet;
    if (!s.subView && this.subtasks.length) return null;
    const sibs = this.subtasks.map(x => this.positions[x.id] || 0),
      under = s.subAt != null;
    const places = this.clearPlaces(
      placeAfter(sibs, under ? (s.subAfter ?? this.positions[s.subAt] ?? null) : null, n),
      sibs,
    );
    if (under) s.subAfter = places.at(-1);
    return places;
  },
  async addSubtasks(w = 'sub') {
    const foot = w === 'under',
      today = foot && this.route.name === 'today',
      parent = this.boxParent(w),
      b = this.box(w),
      parsed = this.boxParsedLines(w);
    if (!parent || !parsed.some(p => p.title)) return;
    const n = parsed.filter(p => p.title).length;
    const at = foot ? this.cursorPlaces(n) : this.subPlaces(n);
    const items = itemsOf(this.boxItems(w), k => at && { position: at[k] }),
      lastTop = items.findLastIndex(x => x.under === null);
    const entries = addLines(items, {
      parent: { id: parent.id, project_id: parent.project_id, title: parent.title },
    }).map(f => this.actEntry(f));
    // Add placeholder rows for the new direct subtasks to Today's card at once. They go in the order typed, after
    // the cursor row or below the header.
    if (today) {
      if (!this.cardAdded[parent.id]) this.cardAdded[parent.id] = [];
      const rows = this.cardAdded[parent.id];
      let after = this.cursor?.under != null ? this.cursor.id : null;
      items.forEach((x, i) => {
        if (x.under === null) {
          rows.push({ id: 'pending-' + entries[i].id, after });
          after = rows.at(-1).id;
        }
      });
    }
    // Move the highlight to the last new direct subtask, so the next entry goes after it and not under a nested
    // child.
    if (foot) this.aimAdded(entries[lastTop], parent);
    const here = () => foot || this.sheet.id === parent.id,
      place = foot ? 'cap' : 'sheet:subtasks';
    // `adding` counts the batches still sending, so the user can submit another batch meanwhile.
    b.adding++;
    b.text = '';
    if (!foot || b.focus) this.$nextTick(() => this.boxEl(w)?.focus());
    try {
      // The rows and the highlight appear before queuing finishes. The waiting look is delayed until sending takes
      // a while.
      const r = await this.sendLines(entries),
        { kept } = r;
      if (foot) this.refreshPending(); // swaps the waiting rows for the sent rows at once
      // Replace the pending card rows with their saved tasks, and keep the highlight on the right row.
      if (today)
        this.change(w => {
          for (const { child, problems, arrived, was, place, ...x } of r.tasks || []) {
            w.base(x);
            for (const a of this.cardAdded[parent.id] || []) {
              if (a.id === was) a.id = x.id;
              if (a.after === was) a.after = x.id;
            }
          }
        });
      this.placeSent(r.tasks || []);
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      if (r.ids?.length && foot) {
        this.flash(r.ids);
        // Reload the parent's subtask count. Today's card already holds the new rows in their insertion positions.
        this.readCopy(parent.id).catch(() => {});
      } else if (r.ids?.length && here()) {
        this.sheet.dirty = true;
        try {
          const t = await this.readCopy(parent.id);
          if (t && here()) {
            this.showTask(t);
            this.loadSubPeople(t);
            this.loadSubOrder(t);
          }
        } catch {}
        // Move the selection to the last added sheet subtask, so the next entry goes after it.
        const last = sync.taskOf(entries[lastTop].id);
        if (here() && this.sheet.subAt != null && last) {
          this.sheet.subAt = last;
          this.sheet.subAfter = null;
          this.seatFoot('sheet');
        }
      }
      if (r.status === 'offline') {
        sync.keep();
        // When the subtasks were added from the add box, their rows show that they are waiting, so no message.
        if (!foot || !kept || today) this.say(!kept ? NOT_KEPT : waitText(r, n), { place, cls: kept ? '' : 'failed' });
      } else if (r.status === 'error') {
        if (here() && r.unsent.length) b.text = [r.unsent.join('\n'), b.text].filter(Boolean).join('\n'); // puts the lines that weren't added back in the box
        // A line whose answer is unknown stays in the Outbox, and the message's button opens the Outbox.
        const added = r.ids.length ? addedPart(r.ids.length, n, but) + ' ' : '';
        if (r.error.code === 'unknown')
          this.say(added + notKnown(r.error.what), { place, cls: 'failed', action: toOutbox(this) });
        else
          this.say(
            r.ids.length ? addedStopped(r.ids.length, n, but, r.error.message) : notDone('added', r.error.message),
            { place, cls: 'failed' },
          );
      } else if (r.ids?.length && but)
        this.say(addedSubs(r.ids.length, but), {
          place,
          cls: 'failed',
        });
    } finally {
      b.adding--;
      this.refreshPending();
    }
  },

  /* ---------- deleting ---------- */
  /* A delete op's fields for `tree`, a task and its subtasks, deepest first (taskTree). Its last stage writes the
     progress of the parent that stays (`up`). */
  deleteOf(tree) {
    const task = tree.at(-1),
      up = this.parentIdOf(this.tasks[task] || { id: task });
    return { op: 'delete', run: null, task, ids: tree, ...(typeof up === 'number' && !tree.includes(up) && { up }) };
  },
  /* Delete each of `trees` (deleteOf) at once, with no Restore. Nothing can bring those tasks back, so the changes
     not sent or refused on them leave the outbox first, as Cancel takes them out. One that made tasks, such as a
     refused start of a template, deletes them with its Cancel stages, sent before the delete, since the tasks it made
     may not be among `trees`. Returns how sending went (actAll). */
  async deleteNow(trees) {
    const ids = new Set(trees.flat());
    await sync.lock(async () => {
      for (const e of sync.all(this.user?.id))
        if (e.kind === 'act' && ids.has(opsId(e.task)) && (!e.sent || e.failed)) {
          if (cancelOf(e) === 'unmade' && (!e.sent || opOf(e).deletes(cancelling(e)).length)) await this.unmake(e);
          else {
            await sync.remove(e.id);
            this.unmade(e.id);
          }
        }
    });
    return this.actAll(trees.map(tree => this.deleteOf(tree)));
  },
  // The label for deleting the open task. Deleting also deletes its subtasks, or a template's or checklist's steps.
  get deleteLabel() {
    const n = this.subtasks.length,
      role = this.checklistRole;
    if (role === 'run') return 'Delete checklist';
    if (role === 'template') return n ? `Delete template and its ${n} step${n === 1 ? '' : 's'}` : 'Delete template';
    return n ? `Delete task and its ${n} subtask${n === 1 ? '' : 's'}` : 'Delete task';
  },
  // `asked` is the list of tasks to delete when the user was already asked, as with a swiped row (swipeDelete,
  // progress.js).
  async deleteTask(asked = null) {
    const t = this.sheetTask,
      role = this.checklistRole;
    if (role === 'run') return this.confirmDeleteRun(t, this.subtasks);
    // If the sheet was opened from the parent's sheet, go back to the parent afterwards.
    const back =
      this.sheet.from && (t.related_tasks?.parenttask || []).some(x => x.id === this.sheet.from)
        ? this.sheet.from
        : null;
    const leave = async () => {
      Object.assign(this.sheet, { dirty: false, editingDesc: false, commentDraft: '' });
      this.sheet.sub.text = '';
      if (back) {
        await this.openTask(back);
        this.sheet.dirty = true;
      } else this.closeSheet();
    };
    if (role !== 'template') {
      if (await this.removeTask(t, asked)) await leave();
      return;
    }
    // A template is deleted after asking, with no Restore. Checklists already started from it keep their steps.
    let tree;
    try {
      tree = await this.taskTree(t.id);
    } catch (e) {
      this.say(notDone('deleted', e.message), { place: 'sheet:top', cls: 'failed' });
      return;
    }
    const n = tree.length - 1;
    if (!confirm(deleteTemplateAsk(t.title, n))) return;
    // A refusal keeps the sheet open, and the sender says why there (sheetPlace).
    if ((await this.deleteNow([tree])).status === 'error') return;
    await leave();
    this.render();
    this.notify(deletedSteps(n)); // a toast, because the sheet and row are gone
  },
  // Only saved, writable tasks can be deleted by swiping. Checklists, their steps and templates have their own ways
  // to delete.
  canDelete(t, sheet) {
    return (
      !t.pending &&
      this.canWrite(t.project_id) &&
      !['run', 'step', 'template'].includes(this.role(t)) &&
      !(sheet && ['run', 'template'].includes(this.checklistRole))
    );
  },
  /* Delete a task and its descendants, asking first if it has any. The deletion is held in the outbox while the
     marked rows keep a Restore gap until the batch clears. Restore removes the held entry, so no task has to be
     recreated. The deletion is sent when the rows or the Undo message leave, or when Pocket closes. The hold is
     saved, so reopening Pocket or reconnecting finishes the deletion. Returns false if the user cancels. `tree`
     reuses a deletion the user already confirmed. */
  async removeTask(t, tree = null) {
    const d = await this.holdDelete(
      t,
      d => {
        const undo = () => this.undoDelete(d.id),
          gone = () => this.sendHeld(d.id);
        if (this.rowEl(t.id))
          return this.markRow(t.id, {
            kind: 'deleted',
            ids: d.ids,
            undo,
            gone,
            said: deletedSaid(t.title),
          });
        this.notify(deletedText(t.title, d.n), {
          label: UNDO,
          fn: undo,
          gone,
        });
      },
      tree,
    );
    return !!d;
  },
  // Whether a task has subtasks as far as the phone knows, judging by its own copy, the copy on screen, or the last
  // copy from Vikunja.
  hasSubtasks(t) {
    return [t, this.tasks[t.id], copyOf(t.id)].some(x => x?.related_tasks?.subtask?.length);
  },
  /* Find the task and its descendants to delete, deepest first, and ask the user to confirm how many. Returns null
     if the user cancels or a read fails. A swipe asks before the row moves. */
  async askDelete(t) {
    let tree;
    try {
      tree = await this.taskTree(t.id);
    } catch (e) {
      this.say(notDone('deleted', e.message), { row: { id: t.id, stays: true, cls: 'failed' }, place: 'sheet:top' });
      return null;
    }
    const n = tree.length - 1,
      direct = (t.related_tasks?.subtask || []).filter(s => tree.includes(s.id)).length;
    return n && !confirm(deleteAsk(t.title, direct, n - direct)) ? null : tree;
  },
  /* Ask the user to confirm the deletion, unless `tree` is given. Queue a held deletion and call show({id, n, ids})
     before the unmarked rows are hidden. The entry stays until sendHeld or undoDelete. Returns {id, n}, or null if
     the user cancels. */
  async holdDelete(t, show, tree = null) {
    tree ||= await this.askDelete(t);
    if (!tree) return null;
    const n = tree.length - 1,
      entry = Object.assign(this.actEntry({ ...this.deleteOf(tree), label: t.title }), { until: Date.now() + HELD_MS });
    sync.held.add(entry.id);
    const added = sync.add(entry, []);
    show?.({ id: entry.id, n, ids: tree });
    this.refreshPending(); // hide unmarked rows immediately while Restore gaps stay visible
    await added;
    return { id: entry.id, n };
  },
  // Cancel the held deletion and restore its rows.
  async undoDelete(id) {
    if (!sync.held.delete(id)) return;
    // Restore the rows before removing the outbox entry so they do not disappear for a frame.
    const e = this.user ? sync.all(this.user.id).find(x => x.id === id) : null;
    if (e) this.change(w => w.offTasks(e));
    await sync.lock(() => sync.remove(id));
    this.refreshPending();
  },
  // Send a deletion after its rows or Undo leave. Without id, send all held deletions when Pocket is hidden.
  async sendHeld(id) {
    if (!id) {
      await Promise.all([...sync.held].map(h => this.sendHeld(h)));
      return;
    }
    if (!sync.held.delete(id)) return; // already undone or sent
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (e?.until) {
        delete e.until;
        await sync.save(e);
      }
    });
    await this.sendActs(id);
  },
  /* Collect the task and its descendants from the store, deepest first. A subtask that still has another parent is
     left out, with its descendants, and so is a subtask that a waiting delete already deletes. */
  async taskTree(id) {
    const out = [],
      seen = new Set();
    const walk = async (tid, from) => {
      if (seen.has(tid) || (from && this.beingDeleted(tid))) return;
      seen.add(tid);
      // Each task is read into the store first. Offline, Vikunja's last copy is used. A subtask that was never loaded
      // can't be included in the deletion.
      if (tid !== this.sheet.id || !this.sheetTask)
        await this.readCopy(tid).catch(e => {
          if (!(e instanceof NetError)) throw e;
        });
      const t = this.shownAs(tid) || { id: tid };
      if (from && (t.related_tasks?.parenttask || []).some(p => p.id !== from)) return;
      for (const sub of t.related_tasks?.subtask || []) await walk(sub.id, tid);
      out.push(tid);
    };
    await walk(id, null);
    return out;
  },

  /* ---------- people and labels ---------- */
  /* Put a person or a label on task `t`, or take one off, as an `assign` or `label` op. The row shows it at once, and
     the op changes Vikunja's people or labels by that one when it is sent. A new label (`l` null) is made with `title`
     as it is sent. Each op keeps the people or labels the row showed, for Cancel's words. */
  addAssignee(t, u) {
    return this.sendSet(t, { op: 'assign', person: personOf(u), add: true, was: (t.assignees || []).map(personOf) });
  },
  removeAssignee(t, uid) {
    const u = (t.assignees || []).find(x => x.id === uid) || { id: uid };
    return this.sendSet(t, { op: 'assign', person: personOf(u), add: false, was: (t.assignees || []).map(personOf) });
  },
  addLabelTo(t, l, title) {
    return this.sendSet(t, { op: 'label', tag: tagOf(l || { title }), add: true, was: (t.labels || []).map(tagOf) });
  },
  removeLabelFrom(t, lid) {
    const l = (t.labels || []).find(x => x.id === lid) || { id: lid, title: '' };
    return this.sendSet(t, { op: 'label', tag: tagOf(l), add: false, was: (t.labels || []).map(tagOf) });
  },
  // A sheet that changed its task redraws the screen behind it as it closes (dirty).
  sendSet(t, fields) {
    if (this.sheet.id === t.id) this.sheet.dirty = true;
    return this.act({ task: t.id, run: null, ...fields });
  },
};
