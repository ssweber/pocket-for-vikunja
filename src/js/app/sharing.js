// Gathers what is on screen for share.js, which writes the text. It shares the progress of a task, a project or a
// checklist, copies a task or a project as a Markdown list that Pocket can read back (not a checklist, see share.js),
// builds links to Vikunja's web app, and copies a task's notes or a comment.
import { htmlToText } from '../html.js';
import { parseStep, stepsOf } from '../checklists.js';
import { positionOrder } from '../order.js';
import { pctOf, workedOut } from '../progress.js';
import { COPIED } from '../messages.js';
import { notesText } from '../ops/index.js';
import { doneTodayText, markdownText, shareText } from '../share.js';
import { copyOf } from './tasks.js';

/* Copy `text` to the clipboard. Where the Clipboard API isn't allowed (an older browser, a page not in focus), it
   selects the text in a hidden textarea and copies with execCommand instead. Returns whether it worked. */
async function toClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const was = document.activeElement,
    box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.className = 'sr';
  document.body.append(box);
  box.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  box.remove();
  was?.focus?.({ preventScroll: true });
  return ok;
}

export default {
  /* A task as an item of the shared text (share.js), with its subtasks under it in the order Pocket shows them. `t` is
     the copy on screen. If `t` doesn't list its subtasks, they are read from the full task Pocket has stored for it,
     if any. A parent's progress is the one its ring shows (shareRing). */
  shareItem(t, seen) {
    seen.add(t.id);
    const full = t.related_tasks?.subtask ? t : this.tasks[t.id] || copyOf(t.id) || t;
    const subs = (
      this.hasOwnOrder(full)
        ? stepsOf(full)
        : [...(full.related_tasks?.subtask || [])].sort(positionOrder(this.positions))
    )
      .filter(s => !seen.has(s.id) && !this.hiddenRows.has(s.id))
      .map(s => this.subRow(s));
    return {
      title: this.shareTitle(t),
      done: !!t.done,
      pct: pctOf(t),
      due: t.due_date,
      people: this.peopleOf(t.id, t.assignees || full.assignees || []),
      ...this.shareWords(t, full),
      ring: this.shareRing(full),
      items: subs.map(s => this.shareItem(s, seen)),
    };
  },
  /* The other things a Markdown copy writes for a task (share.js, quickLine): priority, label names, repeat and notes.
     `full` is the full task object, if Pocket has one, because Vikunja returns a task's subtasks without their
     labels. The notes are plain text, without Pocket's own lines, so a step's asks aren't copied. */
  shareWords(t, full = t) {
    return {
      priority: t.priority || 0,
      labels: (t.labels || full.labels || []).map(l => l.title),
      repeat: { after: t.repeat_after || 0, mode: t.repeat_mode || 0 },
      notes: notesText(t.description == null ? full : t),
    };
  },
  /* A parent's progress as its ring shows it (ringOf). It gives the percentage in the text and a bar with one segment
     per subtask. Null for a task that isn't a parent. */
  shareRing(t) {
    const r = this.ringOf(t);
    return r && { pct: r.pct, done: r.done, total: r.total };
  },
  // The title as its row shows it: a template's without "TEMPLATE: ", a template's step without its time.
  shareTitle(t) {
    const title = this.rowTitle(t);
    return this.checklistIds.has(t.project_id) ? parseStep(title).title || title : title;
  },
  /* Build what is shared. `task` is the open task with its subtasks. `project` is the project on screen: its open
     tasks in list order, each with its open subtasks and the number it has done. `run` is the checklist on screen,
     with who did each step. */
  shareDoc(what) {
    if (what === 'task') {
      const t = this.sheetTask;
      if (!t) return null;
      const seen = new Set([t.id]),
        item = {
          title: this.shareTitle(t),
          done: !!t.done,
          pct: pctOf(t),
          due: t.due_date,
          people: this.peopleOf(t.id, t.assignees || []),
          ...this.shareWords(t),
          ring: this.shareRing(t),
          items: this.subtasks.map(s => this.shareItem(s, seen)),
        };
      // Subtasks still waiting to be sent come after them.
      for (const p of this.pendingSubtasks)
        item.items.push({
          title: p.title,
          done: !!p.done,
          pct: pctOf(p),
          due: p.due_date,
          ...this.shareWords(p),
          items: [],
        });
      return { kind: 'task', ...item };
    }
    if (what === 'project') {
      const p = this.view.project,
        g = this.listGroups.find(x => x.key === 'open');
      if (!p) return null;
      const items = [],
        under = [];
      for (const t of g?.tasks || []) {
        const d = g.depth[t.id] || 0,
          subs = t.related_tasks?.subtask || [];
        const item = {
          title: this.shareTitle(t),
          done: !!t.done,
          pct: pctOf(t),
          due: t.due_date,
          people: this.peopleOf(t.id, t.assignees || []),
          ...this.shareWords(t),
          items: [],
          ring: this.shareRing(t),
          subs: { done: subs.filter(s => this.subRow(s).done).length, total: subs.length },
        };
        under.length = d;
        (d ? under[d - 1]?.items || items : items).push(item);
        under[d] = item;
      }
      const done = this.view.groups.find(x => x.key === 'done');
      return {
        kind: 'project',
        title: p.title,
        items,
        open: (g?.tasks || []).filter(t => !t.done).length,
        doneCount: done?.count || 0,
      };
    }
    const r = this.view.shownRun,
      run = this.runTask,
      v = this.runView;
    if (!r || !v) return null;
    // The ring's percentage is calculated from the steps as the screen shows them, the way ringOf calculates it from
    // the checklist's task. A skipped step counts as done, and so does a tick or progress waiting to be sent.
    const w = workedOut(v.steps.map(s => ({ done: !!s.done, pct: s.pct })));
    return {
      kind: 'run',
      title: run.title,
      ring: w && { pct: w.pct, done: w.done, total: w.total },
      items: v.steps.map(s => ({
        title: s.title,
        done: s.done,
        skipped: s.skipped,
        by: s.by,
        pct: s.pct,
        items: [],
        people: s.done ? [] : this.peopleOf(s.id, (r.steps.includes(s.id) && this.tasks[s.id]?.assignees) || []),
      })),
    };
  },
  /* Share progress as text through the phone's share sheet, or copy it where there is no share sheet. A message about
     the result shows in the sheet it was shared from. The share sheet is requested directly in the tap, with no await
     before it, because a phone allows it only then. */
  async shareProgress(what) {
    const doc = this.shareDoc(what);
    if (!doc) return;
    const text = shareText(doc);
    if (navigator.share) {
      try {
        await navigator.share({ title: doc.title, text });
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return;
      } // the user closed the share sheet. Any other error falls back to copying
    }
    await this.copyOut(text, 'sheet:top', COPIED.text);
  },
  // Copy the same text straight to the clipboard, from the Copy button beside ⋯. A message says so at `place`.
  copyProgress(what, place) {
    const doc = this.shareDoc(what);
    if (doc) return this.copyOut(shareText(doc), place, COPIED.text);
  },
  /* Copy Done today's done tasks as text, each with its project. A row unticked there since it loaded is left out. It
     reads listBase, as the screen does, so a copy of Today saved yesterday doesn't copy yesterday's tasks. */
  copyDoneToday() {
    const g = this.listBase.find(x => x.key === 'donetoday');
    if (!g) return;
    const items = g.tasks
      .filter(t => t.done)
      .map(t => ({
        title: this.shareTitle(t),
        project: this.projById.get(t.project_id)?.title,
        ring: this.shareRing(t),
      }));
    return this.copyOut(doneTodayText(items), 'donetoday', COPIED.text);
  },
  // Copy the open task, or the project on screen, as a Markdown list that Pocket can read back. It is written in quick
  // add's syntax, with the user's own prefixes and default due time.
  copyMarkdown(what) {
    const doc = this.shareDoc(what);
    if (doc)
      return this.copyOut(
        markdownText(doc, { mode: this.quickAddMode, dueTime: this.dueTime }),
        'sheet:top',
        COPIED.markdown,
      );
  },
  // The address of a task or a project in Vikunja's web app. A checklist is a task.
  vikunjaUrl(what) {
    const id = what === 'task' ? this.sheet.id : what === 'run' ? this.view.shownRun?.id : this.sheet.project?.id;
    return `${this.server}/${what === 'project' ? 'projects' : 'tasks'}/${id}`;
  },
  // Copy a task's notes, or a comment, as plain text.
  copyNotes() {
    return this.copyOut(this.notesText(this.sheetTask), 'sheet:notes', COPIED.notes);
  },
  copyComment(c) {
    return this.copyOut(htmlToText(c.comment), 'sheet:comments', COPIED.comment);
  },
  async copyOut(text, place, said) {
    const ok = await toClipboard(text);
    this.say(ok ? said : COPIED.failed, { place, cls: ok ? '' : 'failed' });
  },
};
