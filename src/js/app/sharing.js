// Sharing a task's, a project's or a run's progress as a text, copying it as a Markdown list, opening it in Vikunja, and
// copying a task's notes or a comment. What the text says is share.js's; this gathers what's on screen for it.
import {cache} from '../util.js';
import {htmlToText} from '../html.js';
import {hasOwnOrder, parseStep, stepsOf} from '../checklists.js';
import {positionOrder} from '../order.js';
import {pctOf, workedOut} from '../progress.js';
import {COPIED} from '../messages.js';
import {markdownText, shareText} from '../share.js';

/* Onto the clipboard: the Clipboard API, or, where it isn't allowed (an older browser, a page not in focus), a hidden
   box's text copied the old way. Whether it worked. */
async function toClipboard(text){
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const was = document.activeElement, box = document.createElement('textarea');
  box.value = text; box.setAttribute('readonly', ''); box.className = 'sr';
  document.body.append(box); box.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  box.remove(); was?.focus?.({preventScroll: true});
  return ok;
}

export default {
  /* A task as an item of the text (share.js), with its subtasks under it, in the order Pocket shows them. `t` is the
     copy on screen; what's under a subtask is read from the one copy of it, if Pocket has it. A parent's progress is
     its ring's (shareRing). */
  shareItem(t, seen, people = null){
    seen.add(t.id);
    const full = t.related_tasks?.subtask ? t : this.tasks[t.id] || cache.get(t.id) || t;
    const subs = (hasOwnOrder(full) ? stepsOf(full) : [...(full.related_tasks?.subtask || [])].sort(positionOrder(this.positions)))
      .filter(s => !seen.has(s.id) && !this.hiddenRows.has(s.id));
    return {title: this.shareTitle(t), done: !!t.done, pct: pctOf(t), due: t.due_date, people: this.peopleOf(t.id, people || t.assignees || full.assignees || []),
      ...this.shareWords(t, full), ring: this.shareRing(full), items: subs.map(s => this.shareItem(s, seen))};
  },
  /* What else a copy that comes back writes of a task (share.js, quickWords): its priority, its labels' names and its
     repeat. `full`: the one copy of it, if Pocket has it: Vikunja gives a task's subtasks without their labels. */
  shareWords(t, full = t){
    return {priority: t.priority || 0, labels: (t.labels || full.labels || []).map(l => l.title), repeat: {after: t.repeat_after || 0, mode: t.repeat_mode || 0}};
  },
  /* A parent's worked-out figure, as its ring shows it (ringOf: parent-tasks-plan, part 5), for the text's percent and
     its bar, a segment per subtask; null for any other task. */
  shareRing(t){ const r = this.ringOf(t); return r && {pct: r.pct, done: r.done, total: r.total}; },
  // Its name, as its row shows it: a template's without "TEMPLATE: ", a template's step without its time.
  shareTitle(t){ const title = this.rowTitle(t); return this.checklistIds.has(t.project_id) ? parseStep(title).title || title : title; },
  /* What's shared: the open task (`task`), with its subtasks; the project on screen (`project`), its open tasks in its
     list's order, each with its open subtasks and how many it has done; the run on screen (`run`), who did each step. */
  shareDoc(what){
    if (what === 'task') {
      const t = this.sheet.task;
      if (!t) return null;
      const seen = new Set([t.id]), item = {title: this.shareTitle(t), done: !!t.done, pct: pctOf(t), due: t.due_date, people: this.peopleOf(t.id, t.assignees || []),
        ...this.shareWords(t), ring: this.shareRing(t), items: this.subtasks.map(s => this.shareItem(s, seen, this.sheet.subPeople[s.id]))};
      // Those still waiting to be sent, after them.
      for (const p of this.pendingSubtasks) item.items.push({title: p.title, done: !!p.done, pct: pctOf(p), due: p.due_date, ...this.shareWords(p), items: []});
      return {kind: 'task', ...item};
    }
    if (what === 'project') {
      const p = this.view.project, g = this.listGroups.find(x => x.key === 'open');
      if (!p) return null;
      const items = [], under = [];
      for (const t of g?.tasks || []) {
        const d = g.depth[t.id] || 0, subs = t.related_tasks?.subtask || [];
        const item = {title: this.shareTitle(t), done: !!t.done, pct: pctOf(t), due: t.due_date, people: this.peopleOf(t.id, t.assignees || []), ...this.shareWords(t), items: [], ring: this.shareRing(t),
          subs: {done: subs.filter(s => this.stepDone(s.id, s.done)).length, total: subs.length}};
        under.length = d;
        (d ? under[d - 1]?.items || items : items).push(item);
        under[d] = item;
      }
      const done = this.view.groups.find(x => x.key === 'done');
      return {kind: 'project', title: p.title, items, open: (g?.tasks || []).filter(t => !t.done).length, doneCount: done?.count || 0};
    }
    const r = this.view.run, v = this.runView;
    if (!r || !v) return null;
    // Its ring's figure, from its steps as its screen shows them (a skipped one done, a tick or progress waiting to be
    // sent counted), as ringOf works it out from the run's task.
    const w = workedOut(v.steps.map(s => ({done: !!s.done, pct: s.pct})));
    return {kind: 'run', title: r.run.title, ring: w && {pct: w.pct, done: w.done, total: w.total}, items: v.steps.map(s => ({title: s.title, done: s.done, skipped: s.skipped, by: s.by, pct: s.pct, items: [],
      people: s.done ? [] : this.peopleOf(s.id, r.steps.find(x => x.id === s.id)?.assignees || [])}))};
  },
  /* Progress as a text, through the phone's share sheet (to a message, say), or, where there's none, copied to paste
     into one. Said in the sheet it was shared from. */
  async shareProgress(what){
    const doc = this.shareDoc(what);
    if (!doc) return;
    const text = shareText(doc);
    if (navigator.share) {
      try { await navigator.share({title: doc.title, text}); return; }
      catch (e) { if (e?.name === 'AbortError') return; }          // put away without sharing; anything else, copied instead
    }
    await this.copyOut(text, 'sheet:top', COPIED.text);
  },
  // As a Markdown list that comes back, written in quick add's words with this person's own prefixes and due time.
  copyMarkdown(what){ const doc = this.shareDoc(what); if (doc) return this.copyOut(markdownText(doc, {mode: this.quickAddMode, dueTime: this.dueTime}), 'sheet:top', COPIED.markdown); },
  // Its page in Vikunja's web app: a task's (a run is one), or a project's.
  vikunjaUrl(what){
    const id = what === 'task' ? this.sheet.task?.id : what === 'run' ? this.view.run?.run.id : this.sheet.project?.id;
    return `${this.server}/${what === 'project' ? 'projects' : 'tasks'}/${id}`;
  },
  // A task's notes, or a comment, as plain text.
  copyNotes(){ return this.copyOut(this.notesText(this.sheet.task), 'sheet:notes', COPIED.notes); },
  copyComment(c){ return this.copyOut(htmlToText(c.comment), 'sheet:comments', COPIED.comment); },
  async copyOut(text, place, said){
    const ok = await toClipboard(text);
    this.say(ok ? said : COPIED.failed, {place, cls: ok ? '' : 'failed'});
  },
};
