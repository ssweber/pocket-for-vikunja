// Start checklists and compute their steps, progress, countdowns and pending changes.
import { andList, memo, motion, raw, store, ZERO } from '../util.js';
import { allPages, api, ApiError, errText, items, NetError, serverTime } from '../api.js';
import { addDays, dueInfo, fmtTime, isSet, startOfDay } from '../dates.js';
import { pctOf, tickFeel, workedOut } from '../progress.js';
import { haptic } from '../haptics.js';
import { htmlToText, textToHtml } from '../html.js';
import {
  addedText,
  allComments,
  comesRound,
  isAnswer,
  countText,
  DONE_MARK,
  durText,
  inBatches,
  nextAfter,
  noteOf,
  notesOnly,
  parseStep,
  plainRun,
  runParts,
  plainStep,
  problemText,
  runWithoutDay,
  skippedBy,
  stepProblems,
  stepTimes,
  lockOf,
  stepsOf,
  templateName,
  vikunjaNext,
  whereNext,
} from '../checklists.js';
import { routeOf } from '../routing.js';
import { stepAnswers } from '../asks.js';
import { packParsed, sync, uuid7 } from '../sync.js';
import { opened, saved } from '../lists.js';
import {
  completeAsk,
  deleteRunAsk,
  deleteStepAsk,
  finishedText,
  KEPT,
  notDone,
  notKnown,
  notRepeated,
  notSaved,
  nowFor,
  othersDoneAsk,
  progressSaid,
  repeatedStep,
  SAID,
  startedText,
  tickSaid,
  toOutbox,
  UNDO,
  ringSaid,
  startMarksDone,
  waitText,
  tickableAt,
  waitingFor,
  waitingText,
} from '../messages.js';
import { newBox } from './core.js';
import { renderSeq } from './views.js';
import { keptTicks } from './acts.js';
import { lastTick, stagesOf, stepsAdding } from '../ops/index.js';
import { copyOf, putting, started } from './tasks.js';
import { opsId, TASK_COMMENTS, TASK_REACTIONS_COMMENTS } from '../tasks.js';

const LAST_WAIT = 600; // ms loadRun waits for Last time's notes after the steps load, when nothing is on screen yet
/* Cache each computed step by id and serialized content. Reuse unchanged step objects so their rows do not redraw
   when another step or countdown changes. */
const lastSteps = new Map();

export default {
  async openStart(id) {
    this.openSheet('start');
    const mine = this.sheet;
    Object.assign(this.sheet, {
      loading: true,
      start: { template: null, steps: [], people: [], forIds: [this.user?.id], busy: false, name: '', next: 1 },
    });
    try {
      // Start offline from the cached template, then create the run when Pocket reaches Vikunja.
      const t = await api('/tasks/' + id).catch(e => {
        const k = e instanceof NetError && saved.get('templates')?.[id];
        if (k) return k;
        throw e;
      });
      // Offer people who can access the project. If Vikunja refuses the search, only you are offered.
      let people = [];
      try {
        people = items(await api(`/projects/${t.project_id}/users/search`));
        // Exclude direct read-only shares because those people cannot tick steps. Keep team members.
        const shares = items(await api(`/projects/${t.project_id}/users`).catch(() => [])),
          ro = new Set(shares.filter(x => (x.permission ?? x.right) === 0).map(x => x.id));
        people = people.filter(u => !ro.has(u.id));
        saved.set('people.' + t.project_id, people);
      } catch (e) {
        if (e instanceof NetError) people = saved.get('people.' + t.project_id) || [];
      }
      if (this.sheet !== mine) return;
      const me = this.user;
      people = [
        me,
        ...people
          .filter(u => u.id !== me.id)
          .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username)),
      ];
      // Default to the template's assignees who can write, or to you when none remain.
      const forIds = (t.assignees || []).map(u => u.id).filter(id => people.some(u => u.id === id));
      Object.assign(this.sheet.start, {
        template: {
          id: t.id,
          title: templateName(t.title),
          project_id: t.project_id,
          labels: t.labels,
          done: t.done,
          due_date: t.due_date,
          repeat_after: t.repeat_after,
          repeat_mode: t.repeat_mode,
        },
        steps: stepsOf(t),
        people,
        forIds: forIds.length ? forIds : [me.id],
        next: (t.related_tasks?.copiedto || []).length + 1,
        who: {},
      });
      // Fetch step assignees separately because Vikunja omits them from related tasks.
      const ids = stepsOf(t).map(s => s.id);
      if (ids.length)
        allPages('/tasks?' + new URLSearchParams({ filter: `id in ${ids.join(', ')}` })).then(
          list => {
            if (this.sheet !== mine) return;
            this.sheet.start.who = Object.fromEntries(
              list.map(s => [
                s.id,
                andList((s.assignees || []).map(u => (u.id === me.id ? 'you' : u.name || u.username))),
              ]),
            );
          },
          () => {},
        );
    } catch (e) {
      if (this.sheet === mine) this.sheet.error = errText(e);
    } finally {
      if (this.sheet === mine) this.sheet.loading = false;
    }
  },
  // Choose who a checklist is for: any number of people, but at least one.
  toggleFor(st, u) {
    const on = st.forIds.includes(u.id);
    if (on && st.forIds.length === 1) {
      this.say(SAID.onePerson, { place: 'sheet:top', cls: 'failed' });
      return;
    }
    st.forIds = on ? st.forIds.filter(id => id !== u.id) : [...st.forIds, u.id];
  },
  /* Use today's due date when starting a repeating template, even before its due time. Starting an 8:00 checklist
     at 7:55 must not create another at 8:00. */
  tickOf(tpl) {
    return comesRound(tpl) && new Date(tpl.due_date) < addDays(startOfDay(), 1) ? tpl.due_date : null;
  },
  // The note under For in the Start sheet. It says what starting does to a template that repeats.
  get startNote() {
    const t = this.sheet.start?.template;
    if (!t || !comesRound(t)) return '';
    const due = new Date(t.due_date),
      today = +startOfDay(due) === +startOfDay();
    const at = d =>
      d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    if (!this.tickOf(t)) return `${t.title} is next due ${at(due)}. Starting this checklist doesn't change that date.`;
    const one = today ? `at ${due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : at(due);
    const next = vikunjaNext(t);
    if (next === null) return `This is the checklist due ${one}. ${startMarksDone(t.title)}`;
    return `This is the checklist due ${one}. Starting it moves ${t.title} to ${at(new Date(nextAfter(t, next)))}.`;
  },
  get startProgress() {
    const s = this.starting;
    return s ? `Setting up… ${Math.round((100 * s.done) / s.total)}%` : 'Setting up…';
  },
  /* Start a checklist as a startRun op, so a lost connection carries on where it stopped, and nothing is made twice.
     The first step is timed from the Start tap. Other timed steps get dates when the step they wait on is done. */
  async startRun() {
    const st = this.sheet.start;
    if (!st?.template || st.busy) return;
    this.unlockSound(); // unlock countdown audio during the tap
    const problems = stepProblems(st.steps.map(s => s.title));
    if (problems.length) {
      this.say(notDone('started', problemText(problems)), { place: 'sheet:top', cls: 'failed' });
      return;
    }
    const start = new Date(),
      steps = st.steps.map((s, i) => {
        const { title, offset } = parseStep(s.title);
        return {
          from: s.id,
          title,
          due: i === 0 && offset !== null ? new Date(serverTime(+start) + offset).toISOString() : null,
          timed: offset !== null,
          remind: offset >= 6e4,
          tpl: s.title,
        };
      });
    const who = st.people.filter(u => st.forIds.includes(u.id));
    // tick is the template's due date when this start ticks the template (tickOf). The new checklist is due then too.
    const f = {
      id: uuid7(),
      op: 'startRun',
      task: st.template.id,
      run: null,
      template: st.template,
      name: st.name.trim(),
      for: (who.length ? who : [this.user]).map(u => ({ id: u.id, username: u.username, name: u.name || '' })),
      steps,
      tick: this.tickOf(st.template),
    };
    st.busy = true;
    this.starting = { id: f.id, done: 0, total: stagesOf(f).length };
    const r = await this.actAll([f], true),
      runId = r.ids?.[0];
    this.starting = null;
    st.busy = false;
    if (r.status === 'sent' || r.status === 'gone') {
      this.closeSheet(true);
      if (runId) this.openRun(runId);
      // Keep the start's Undo at the top until work begins or the screen closes. A timer would move the step card
      // while someone reads it.
      this.say(SAID.started, {
        place: 'run',
        ms: null,
        action: runId && { label: UNDO, fn: () => this.unstart(f, runId) },
      });
      if (this.places.run) this.places.run.startOf = runId;
      else this.toast.startOf = runId;
    } else if (r.status === 'offline') {
      this.closeSheet(true);
      if (this.route.name === 'checklists') this.render();
      else this.go('#/checklists');
      // A start the phone couldn't keep is said where it was sent from (sendActs).
      if (r.kept && !r.behind) this.say(waitText(r), { place: 'checklists' });
    } else
      this.say(
        r.error.code === 'unknown'
          ? notKnown(r.error.what)
          : notSaved(r.error.what, r.error.message, { next: r.kept ? KEPT : '' }),
        { place: 'sheet:top', cls: 'failed', action: r.kept ? toOutbox(this) : null },
      );
  },
  /* Undo a start, as the op that takes it back: it deletes the checklist and its steps, and puts back the template's
     date if the start moved it and nobody has moved it since. */
  unstart(f, id) {
    this.undoOps([f], false);
    this.notify(SAID.checklistRemoved);
    if (this.route.name === 'run' && this.route.id === id) this.leaveRun();
    else this.render();
  },
  /* Edit the run's optional name and assignees in its menu. runParts supports both the current name order and
     older runs with the day last. */
  async openRunOptions() {
    const run = this.runTask;
    if (!run) return;
    this.openSheet('runopts');
    const p = runParts(run.title, run.created, true),
      name = p ? p.name : run.title;
    this.sheet.runEdit = {
      prefix: p ? p.template : '',
      day: p ? p.day : '',
      old: !!p?.old,
      name,
      was: name,
      forIds: (run.assignees || []).map(u => u.id),
      people: [],
    };
    const edit = this.sheet.runEdit;
    try {
      const people = items(await api(`/projects/${run.project_id}/users/search`)),
        me = this.user;
      edit.people = [
        me,
        ...people
          .filter(u => u.id !== me.id)
          .sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username)),
      ];
    } catch {
      edit.people = [this.user];
    }
  },
  /* Rename the checklist as an `edit` op, which its screen and rows show at once. Offline it waits in the Outbox. A
     refusal waits there too, the sender says so, and the box shows the name the checklist has again. */
  async saveRunName() {
    const e = this.sheet.runEdit,
      run = this.runTask,
      name = e?.name.trim();
    if (!run || !name) {
      if (e) e.name = e.was;
      return;
    }
    const title = !e.prefix ? name : (e.old ? [e.prefix, name, e.day] : [e.prefix, e.day, name]).join(' · ');
    if (title === run.title) return;
    e.was = name;
    const r = await this.act({ op: 'edit', task: run.id, set: { title }, was: { title: run.title } });
    if (r.status === 'error') {
      const now = this.runTask || run,
        p = runParts(now.title, now.created, true);
      e.name = e.was = p ? p.name : now.title;
      return;
    }
    this.saveRun(false);
    this.say(SAID.renamed, { place: 'sheet:top' });
  },
  /* Keep at least one assignee when changing who the run is for. The person is assigned or unassigned as an `assign`
     op, which changes the people Vikunja has by that one, so a step claimed meanwhile keeps its claim. Offline it
     waits in the Outbox. A refusal waits there too, and the sender says so. */
  async setRunFor(u) {
    const e = this.sheet.runEdit,
      run = this.runTask;
    if (!run) return;
    const was = e.forIds,
      on = was.includes(u.id);
    if (on && was.length === 1) {
      this.say(SAID.onePerson, { place: 'sheet:top', cls: 'failed' });
      return;
    }
    e.forIds = on ? was.filter(id => id !== u.id) : [...was, u.id];
    const who = e.people.filter(x => e.forIds.includes(x.id)),
      r = await (on ? this.removeAssignee(run, u.id) : this.addAssignee(run, u));
    if (r.status === 'error') {
      e.forIds = was;
      return;
    }
    this.saveRun(false);
    this.say(nowFor(this.forText({ assignees: who })), { place: 'sheet:top' });
  },
  // Delete a checklist from its ⋯ menu or its sheet. Its steps are deleted too, so none is left as a separate task.
  async confirmDeleteRun(run, steps) {
    const n = steps.length;
    if (!confirm(deleteRunAsk(run.title, n))) return;
    this.closeSheet(true);
    await this.deleteRun(run.id, { deleted: true });
  },
  /* Delete a checklist with its steps, as one delete op with no Restore. The steps are read first, as a task's
     subtasks are (taskTree). A refusal leaves the checklist where it is, and the sender says why. */
  async deleteRun(id, { deleted = false } = {}) {
    let tree;
    try {
      tree = await this.taskTree(id);
    } catch (e) {
      this.say(notDone('removed', e.message), { place: ['sheet:top', 'run'], cls: 'failed' });
      return;
    }
    if ((await this.deleteNow([tree])).status === 'error') return;
    if (this.sheet.id === id) Object.assign(this.sheet, { editingDesc: false, commentDraft: '' });
    this.notify(deleted ? SAID.checklistDeleted : SAID.checklistRemoved);
    if (this.route.name === 'run' && this.route.id === id) this.leaveRun();
    else this.render();
  },

  /* ---------- a run ---------- */
  // Load a checklist with each step's reactions (who did it), notes and photos.
  async loadRun(seq, id) {
    const at = started(),
      run = await allComments(
        await api(`/tasks/${id}?expand=comments`).catch(e => {
          if (e.status === 404) e.runGone = true;
          throw e;
        }),
      );
    this.change(w => w.read([run], TASK_COMMENTS, at));
    if (this.projects.length && !this.isRunTask(run))
      throw new ApiError(404, "This task isn't a started checklist. Open it from its project instead.");
    /* With nothing on screen yet, wait briefly for Last time's notes before showing the steps, or use the saved notes.
       Notes that arrive later would push the steps down while the user is touching the screen, so lateLast keeps them
       off the current card. A checklist already on screen, from its saved copy or an earlier load, never waits. */
    const kept = this.view.shownRun?.id === id ? this.view.shownRun : null;
    const reading = kept?.last && !kept.last.saved ? null : this.readLast(plainRun(run));
    const steps = await inBatches(stepsOf(run), 4, async s =>
      allComments(await api(`/tasks/${s.id}?expand=reactions&expand=comments`)),
    ).then(putting(TASK_REACTIONS_COMMENTS));
    const last =
      reading && !kept
        ? await Promise.race([reading, new Promise(ok => setTimeout(() => ok(undefined), LAST_WAIT))])
        : undefined;
    if (seq !== renderSeq) return;
    const keep = this.view.shownRun?.id === id ? this.view.shownRun : null; // reloading the open checklist keeps its step and drafts
    if (!keep) {
      this.runInsert = newBox();
      this.runBoxAt = null;
    }
    const asked = keep ? -1 : steps.findIndex(s => s.id === this.route.step); // index of the step opened from a list
    const before = !keep && last === undefined ? saved.get('run.' + id)?.shownRun?.last : null;
    this.runNow = Date.now(); // compute the newly opened run for the current time
    for (const t of [run, ...steps]) this.row(t); // the screen reads the checklist and its steps by id
    this.view.shownRun = {
      id,
      steps: steps.map(s => s.id),
      at: keep ? keep.at : asked >= 0 ? asked : null,
      last: keep?.last || last || (before?.notes ? { ...before, held: null } : null),
    };
    opened('run', id);
    this.saveRun();
    if (reading && last === undefined) reading.then(l => this.lateLast(id, l));
  },
  /* A checklist opened from its saved copy starts as one opened from Vikunja does: on the step the link names, with an
     empty add box, and with Last time's notes on the step's card. Its load keeps all of that, and reads Last time
     again because the saved notes may be old (`saved`). */
  savedRun(r, run) {
    this.runInsert = newBox();
    this.runBoxAt = null;
    this.runNow = Date.now();
    const at = run.steps.indexOf(r.step);
    return { ...run, at: at >= 0 ? at : null, last: run.last && { ...run.last, held: null, shown: null, saved: true } };
  },
  // Save the open checklist so it opens offline, as the ids of the checklist and its steps. A save that isn't a load
  // (`fresh` false), as a rename or Last time's notes, doesn't sweep the store.
  saveRun(fresh = true) {
    const r = this.view.shownRun;
    if (r) this.keepScreen('run.' + r.id, { shownRun: r, at: new Date().toISOString() }, fresh);
  },
  /* Load notes from the last finished checklist of this template, including step notes. Return {id, title, notes},
     or null when there is no readable checklist. */
  async readLast(run) {
    if (!run.from) return null;
    try {
      const prev = ((await api('/tasks/' + run.from)).related_tasks?.copiedto || [])
        .filter(x => x.id !== run.id && x.done)
        .sort((a, b) => new Date(b.done_at) - new Date(a.done_at))[0];
      if (!prev) return null;
      const full = await allComments(await api(`/tasks/${prev.id}?expand=comments`));
      const steps = await inBatches(stepsOf(full), 4, async s =>
        allComments(await api(`/tasks/${s.id}?expand=comments`)),
      );
      // Each note keeps the template step it was on (tpl), so it shows on that step's card in this checklist.
      const notes = [
        ...(full.comments || []).map(c => ({ ...noteOf(c), step: 'The checklist', tpl: null })),
        ...steps.flatMap(s =>
          (s.comments || []).map(c => ({
            ...noteOf(c),
            step:
              parseStep(s.title).title +
              (addedText(s.description) ? ` (${addedText(s.description).toLowerCase()})` : ''),
            tpl: addedText(s.description) ? null : plainStep(s).tpl,
          })),
        ),
      ];
      return { id: prev.id, title: prev.title, notes };
    } catch {
      return null;
    }
  },
  /* Show late notes below the steps immediately. The current card keeps the notes it shows (`shown`) until another
     step is selected, so the list under it stays still. */
  lateLast(id, last) {
    const r = this.view.shownRun;
    if (r?.id !== id || !last) return;
    const same =
      r.last &&
      JSON.stringify(r.last.notes.map(n => n.id)) === JSON.stringify(last.notes.map(n => n.id)) &&
      r.last.id === last.id;
    const step = this.runView?.step;
    r.last = same
      ? { ...last, held: r.last.held, shown: r.last.shown }
      : { ...last, held: step?.id ?? null, shown: this.lastNotes(step) };
    this.saveRun(false);
  },
  /* The checklist on its screen, from its steps as their rows show them, so a tick, a skip or a note waiting in the
     outbox shows through its op. Memoize once per input change, read runNow only when time changes visible text, and
     reuse unchanged step objects. */
  get runView() {
    return (this.runMemo ||= memo(function () {
      return this.workOutRun();
    })).call(this);
  },
  // Keep one row-options object so selecting a card step changes only `at`. Read it through raw to avoid making
  // these writes trigger another computation.
  get runRows() {
    const v = this.runView,
      g = raw(this.runG);
    if (!v) return this.runG;
    const locked = v.finished || !this.canWrite(this.runTask.project_id);
    if (g.at !== v.at) this.runG.at = v.at;
    if (g.locked !== locked) this.runG.locked = locked;
    return this.runG;
  },
  workOutRun() {
    const r = this.view.shownRun,
      run = this.runTask;
    if (!r || !run) return null;
    const me = this.user,
      note = c => noteOf(c, this.waitNote(c.id));
    // Place pending inserted or repeated steps before their original successor, or after their predecessor if that
    // successor is gone. Omit cancelled steps, and steps a waiting delete deletes. A step being inserted has no row, so
    // its ops are applied here.
    const base = r.steps
      .map(id => this.tasks[id])
      .filter(t => t && !this.beingDeleted(t.id))
      .map(plainStep);
    for (const e of stepsAdding(this.pending, r.id))
      if (!base.some(s => s.id === e.taskId)) {
        const k = base.findIndex(s => s.id === e.before),
          a = k < 0 ? base.findIndex(s => s.id === e.after) : -1,
          id = 'pending-' + e.id;
        base.splice(
          k >= 0 ? k : a >= 0 ? a + 1 : base.length,
          0,
          this.withOps(opsId(id), {
            id,
            title: e.title,
            done: false,
            done_at: null,
            due_date: ZERO,
            updated: e.at,
            description: '',
            assignees: [],
            attachments: [],
            reactions: {},
            comments: [],
            tpl: e.tpl ?? null,
            from: e.from,
            added: e.from || e.tpl != null ? 'Repeated' : 'Inserted',
            pending: e.id,
          }),
        );
      }
    const steps = base.map((s, i) => {
      const skipper = skippedBy(s),
        done = s.done,
        skipped = !!skipper,
        pct = Math.round((s.percent_done || 0) * 100);
      // The step waits while a tick, a skip or an untick of it is in the outbox. It looks waiting (slow) once the last
      // of them has waited long enough.
      const { tick, doneAt } = this.doneOf(s),
        waiting = !!tick,
        slow = !!tick && this.slow.includes(tick.id);
      const by = skipped ? [skipper] : s.reactions?.[DONE_MARK] || [];
      const doers = () => by.map(u => u.name || u.username);
      const notes = (s.comments || []).map(note);
      // The step's row shows the latest comment's first line. Answers to its asks show on the row already.
      const talk = (s.comments || [])
        .filter(c => !isAnswer(c.comment))
        .map(note)
        .at(-1);
      const said = talk
        ? {
            who: talk.author,
            text:
              htmlToText(talk.comment || '')
                .split('\n')
                .map(l => l.trim())
                .find(Boolean) || '',
          }
        : null;
      const people = s.pending ? [] : this.peopleOf(s.id, s.assignees);
      const slot = done
        ? this.doneSlot(by, people, slow ? 'wait' : skipped ? 'skip' : 'done')
        : s.pending
          ? null
          : this.claimSlot({ ...s, project_id: run.project_id }, people, run.done, r.id);
      // Show who completed or skipped the step, with their picture and reaction badge.
      const at =
        doneAt && isSet(doneAt)
          ? ' at ' +
            (+startOfDay(new Date(doneAt)) === +startOfDay()
              ? fmtTime(new Date(doneAt))
              : new Date(doneAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))
          : '';
      return {
        id: s.id,
        i,
        title: parseStep(s.title).title,
        description: notesOnly(s.description),
        ...stepAnswers(s, me),
        attachments: s.attachments,
        done,
        skipped,
        waiting,
        slow,
        notes,
        said,
        doneAt,
        slot,
        by,
        pct,
        added: s.added || '',
        pending: s.pending || null,
        slowAdd: !!s.pending && this.slow.includes(s.pending),
        from: s.from || null,
        tpl: s.tpl,
        whoText: !done
          ? ''
          : (skipped ? 'Skipped' : 'Done') +
            (slow ? ' · waiting to send' : (by.length ? ' by ' + andList(doers()) : '') + at),
      };
    });
    // When each step is due (stepTimes), with the phone's time for a tick still in the outbox.
    const now = serverTime(this.runNow),
      times = stepTimes(steps.map((s, i) => ({ ...s, due_date: base[i].due_date, updated: base[i].updated })));
    steps.forEach((s, i) => {
      const { time, from, due } = times[i],
        waitsOn =
          !from || from.done
            ? ''
            : time.offset
              ? `${durText(time.offset)} after “${from.title}”`
              : `when “${from.title}” is done`;
      const left = due ? due - now : 0,
        soon = Math.abs(left) < 864e5,
        lock = lockOf(s, times[i], now);
      s.late = !!due && (s.done ? new Date(s.doneAt) > due : left < 0);
      s.counting = !s.done && time?.offset != null && !!due && soon; // a countdown: pinned at the top while it runs
      s.dueAt = due ? +due : Infinity;
      s.countText = s.counting ? countText(left) : '';
      // A step with !T# can't be ticked yet. Its Done button says why, counting down to the second.
      s.lock = lock && { at: lock.at, from: lock.from?.title ?? null };
      s.lockText = !lock ? '' : lock.at === null ? waitingFor(lock.from.title) : waitingText(left);
      s.dueText = waitsOn
        ? 'Due ' + waitsOn
        : s.counting
          ? (left >= 0 ? 'Due ' : '') + s.countText
          : due
            ? 'Due ' + dueInfo(due.toISOString()).label
            : '';
    });
    // Choose the next open or due step unless a step was selected manually. Reuse each unchanged step object.
    steps.forEach((s, i) => {
      const all = JSON.stringify(s),
        was = lastSteps.get(s.id);
      if (was?.all === all) steps[i] = was.step;
      else lastSteps.set(s.id, { all, step: s });
    });
    if (lastSteps.size > steps.length) {
      const ids = new Set(steps.map(s => s.id));
      for (const id of lastSteps.keys()) if (!ids.has(id)) lastSteps.delete(id);
    }
    const total = steps.length,
      doneCount = steps.filter(s => s.done).length,
      next = whereNext(steps, now);
    const allDone = total > 0 && doneCount === total,
      at = r.at ?? (next >= 0 ? next : total - 1);
    // doneCount includes skipped steps, so a checklist with skips can finish. didCount leaves them out, for the summary.
    const skippedN = steps.filter(s => s.skipped).length,
      lateN = steps.filter(s => s.done && s.late).length,
      didCount = doneCount - skippedN;
    // Show who started the run in its summary and menu. The top row's slot shows who the run is for.
    const started = startedText(this.runStarter(run), run.created, { now: new Date(now) });
    const finished = !!run.done;
    // Show the finish card when the run is finished or every step is done. Tapping a listed step can still open
    // its card.
    const step = (allDone || finished) && r.at === null ? null : steps[at] || null;
    return {
      steps,
      total,
      doneCount,
      didCount,
      skippedN,
      allDone,
      at,
      step,
      finished,
      timers: steps.filter(s => s.counting && s !== step).sort((a, b) => a.dueAt - b.dueAt),
      summary: [
        started,
        `${didCount} of ${total} done`,
        skippedN && `${skippedN} skipped`,
        total - doneCount && `${total - doneCount} not done`,
        lateN && `${lateN} done late`,
      ]
        .filter(Boolean)
        .join(' · '),
      notes: (run.comments || []).map(note),
      ring: { ...workedOut(steps.map(s => ({ done: s.done, pct: s.pct }))), run: true },
    };
  },
  // Who started a checklist: "you" or their name. Null when Vikunja doesn't report it.
  runStarter(run) {
    const by = run?.created_by;
    return by ? (by.id === this.user?.id ? 'you' : by.name || by.username) : null;
  },
  // Show the starter and date at the top of the run's menu.
  get runStarted() {
    const run = this.runTask;
    return run ? startedText(this.runStarter(run), run.created, { day: true }) : '';
  },
  /* Build the run's top row with its name, assignees and ring, including pending ticks. Its ring or full right
     swipe finishes the run, asking first if steps remain open. A finished run reopens instead. */
  // Include a pending finish in the top row's done state, once the screen has loaded. The row gets only the checklist's
  // own fields (plainRun).
  get runOwn() {
    const run = this.runTask,
      v = this.route.name === 'run' && !this.view.loading && !this.view.error && this.runView;
    return v && run ? { ...plainRun(run), done: v.finished } : null;
  },
  get runRing() {
    const v = this.runView,
      run = this.runTask;
    if (!v || !run || !v.total) return null;
    const open = v.total - v.ring.done,
      title = `“${run.title}”`,
      n = open === 1 ? '1 step' : open + ' steps';
    return {
      ...v.ring,
      open,
      said: ringSaid(v.ring.done, v.total, 'step', v.ring.pct),
      tap: () => this.runRingTap(),
      label: v.finished
        ? 'Reopen ' + run.title
        : !open
          ? `Finish ${title}: all its steps are done`
          : `Finish ${title}, with ${n} not done`,
    };
  },
  runRingTap() {
    const run = this.runTask,
      v = this.runView;
    if (!run || !v || !this.canWrite(run.project_id)) return;
    if (v.finished) return this.reopenRun(run.id);
    if (v.allDone) return this.finishRun();
    const open = v.steps.filter(s => !s.done).map(s => s.title),
      title = runWithoutDay(run.title, run.created);
    this.openSheet('complete');
    this.sheet.complete = {
      id: run.id,
      task: run,
      run: true,
      screen: true,
      back: false,
      title,
      open,
      n: open.length,
      stay: 0,
      ask: completeAsk({ title, run: true, names: open }),
    };
  },
  // The notes made on this step in the last finished checklist of the same template.
  lastNotes(s) {
    const l = this.view.shownRun?.last;
    if (!s?.tpl || !l) return [];
    return s.id === l.held ? l.shown || [] : (l.notes || []).filter(n => n.tpl === s.tpl);
  },
  /* Open a run on its own screen, selecting the requested step if given. Back returns to the screen that opened
     it. */
  openRun(id, step = null) {
    this.closeSheet(true);
    this.go('#/run/' + id + (step ? '?step=' + step : ''));
  },
  leaveRun() {
    this.back(this.runFrom || '#/checklists');
  },
  // Leave a deleted run's screen and remove its offline copy.
  runGone(id) {
    store.del('saved.run.' + id);
    saved.set(
      'runs.recent',
      (saved.get('runs.recent') || []).filter(x => x !== id),
    );
    if (this.view.shownRun?.id === id) this.view.shownRun = null;
    this.leaveRun();
    this.notify(SAID.checklistGone);
  },
  // Where Back goes, by name: from a run, the screen before it; from a project, the list it was opened from.
  get backName() {
    if (this.route.name === 'run')
      return (
        { today: 'Today', project: 'the project', search: 'search' }[routeOf(this.runFrom || '').name] || 'checklists'
      );
    return (
      { today: 'Today', search: 'search', checklists: 'checklists' }[routeOf(this.projectFrom || '').name] || 'projects'
    );
  },
  // A checklist run, done or not.
  isRunTask(t) {
    return this.role(t) === 'run';
  },
  // Allow changes unless the project is known to be shared read-only.
  canWrite(pid) {
    const v = this.perms[pid];
    return v === undefined || v === null || v >= 1;
  },
  /* A template and its steps can be changed only by the person who made the template or a project admin. Vikunja
     lets anyone with write change them, so this guards against slips in Pocket only. */
  get canEdit() {
    const t = this.sheetTask,
      role = this.checklistRole;
    if (!t || !this.canWrite(t.project_id)) return false;
    return !['template', 'tplstep'].includes(role) || this.ownsTemplate(role === 'tplstep' ? this.parentTask : t);
  },
  // The line in a template's checklist card: what starting does, and what the user can do with the template.
  get templateNote() {
    const t = this.sheetTask;
    if (t && !this.canWrite(t.project_id))
      return "Read only. You can see this template, but not start a checklist from it. Ask the project's owner for write access.";
    return (
      'Every checklist you start from this template copies these steps. ' +
      (this.canEdit
        ? 'Tap to edit. Hold to reorder. Swipe left to delete.'
        : 'Only the person who made this template or a project admin can change it.')
    );
  },
  // Whether the user made template `t`, or is an admin of its project. Unknown access counts as admin, as it counts
  // as write in canWrite, until the project's access has loaded.
  ownsTemplate(t) {
    const full = t && (this.tasks[t.id] || copyOf(t.id) || t),
      p = full && this.perms[full.project_id];
    return !!full && (p == null || p >= 2 || full.created_by?.id === this.user?.id);
  },
  /* Load project permissions in small background batches because Vikunja's project list omits them. Cache each
     result, or reload all with force. */
  async loadPerms(force = false) {
    const todo = this.projects.filter(p => p.id > 0 && (force || !(p.id in this.perms)));
    if (!todo.length) return;
    try {
      await inBatches(todo, 4, async p => {
        const full = await api('/projects/' + p.id);
        this.perms[p.id] = full.max_permission ?? 1;
      });
      saved.set('perms', this.perms);
    } catch {}
  },
  // The run a task is a step of, or null.
  stepRun(t) {
    return this.role(t) === 'step' ? t.related_tasks.parenttask[0].id : null;
  },
  // A list row has a tick unless it is a template. A checklist has one only in its project's own list.
  canTick(t) {
    if (!this.canWrite(t.project_id)) return false;
    const role = this.role(t);
    return role !== 'template' && (role !== 'run' || this.route.name === 'project');
  },
  // Compute a parent's progress from its subtasks or run steps. Use stored progress for other tasks.
  shownPct(t) {
    const r = this.ringOf(t);
    return r ? r.pct : t.done ? 100 : pctOf(t);
  },
  /* Use square ticks for run steps wherever they appear. Steps go through the run's outbox and record who
     completed them, so they must look different from ordinary tasks. */
  isStepRow(t, g) {
    return !!g.run || (g.sheet ? this.checklistRole === 'run' : this.role(t) === 'step');
  },
  /* Whether step `t` can't be ticked yet, at server time `now`: a step with !T# before its time (lockOf). Returns null,
     or {at: when it can be ticked, or null while it waits on a step, from: that step's title}. On the checklist's screen
     this is the screen's own reading of the step. Elsewhere, as on Today's card, it is worked out the same way from the
     checklist's steps as the phone has them. */
  stepLock(t, now = serverTime(Date.now())) {
    if (!t || t.done || t.pending) return null;
    const v = this.route.name === 'run' && this.view.shownRun?.steps.includes(t.id) ? this.runView : null,
      lock = v ? v.steps.find(s => s.id === t.id)?.lock : this.storedLock(t, now);
    return lock && (lock.at === null || lock.at > now) ? lock : null;
  },
  storedLock(t, now) {
    const run = this.tasks[this.stepRun(this.tasks[t.id] || t)];
    if (!run || !parseStep(plainStep(this.tasks[t.id] || t).tpl || '').strict) return null;
    const steps = stepsOf(run)
      .map(x => this.tasks[x.id] || x)
      .filter(x => !this.beingDeleted(x.id))
      .map(x => {
        const s = plainStep(x),
          { tick, doneAt } = this.doneOf(s);
        return { ...s, title: parseStep(s.title).title, doneAt, waiting: !!tick };
      });
    const i = steps.findIndex(s => s.id === t.id),
      lock = i < 0 ? null : lockOf(steps[i], stepTimes(steps)[i], now);
    return lock && { at: lock.at, from: lock.from?.title ?? null };
  },
  // Whether a step's tick shows a padlock. Today checks once a minute (rowNow), a checklist's screen each second.
  rowLock(t, g) {
    return !!this.stepLock(t, serverTime(g.run ? this.runNow : this.rowNow()));
  },
  /* A tap on the tick of a step that can't be ticked yet says when it can, and ticks nothing. A list or a sheet says it
     on the step's row. A checklist's screen (`run`) has no messages on its rows, so it says it on the step card. */
  lockedTap(t, run = false) {
    const lock = this.stepLock(t);
    if (lock)
      this.say(tickableAt(t.title, lock.at, lock.from), {
        row: run ? null : { id: t.id, stays: true },
        place: ['sheet:top', 'step', 'run'],
      });
    return !!lock;
  },
  /* When step `s` (plainStep) was done, by this phone's clock for a tick made here (keptTicks), and the tick of it still
     in the outbox, if any. Whole seconds are compared because tick replies include nanoseconds but later task reads do
     not. */
  doneOf(s) {
    const kept = keptTicks()[s.id],
      here = s.done && kept && Math.floor(Date.parse(kept.there) / 1000) === Math.floor(Date.parse(s.done_at) / 1000);
    return { tick: lastTick(this.opsOf(opsId(s.id))), doneAt: here ? kept.here : s.done_at };
  },
  goProject(id) {
    this.closeSheet(true);
    this.go('#/project/' + id);
  },
  // Open a checklist or one of its steps on the checklist screen, an open template in Start, and other tasks in a sheet.
  openRow(t) {
    if (this.isRunTask(t)) return this.openRun(t.id);
    if (this.role(t) === 'template' && comesRound(t)) return this.openStart(t.id);
    const run = this.stepRun(t);
    if (run) return this.openRun(run, t.id);
    this.openTask(t.id);
  },
  showStep(i, scroll) {
    const r = this.view.shownRun;
    if (!r) return;
    r.at = i;
    if (r.last) r.last.held = null; // Last time's notes now show on the step's card
    if (scroll) scrollTo({ top: 0, behavior: motion() ? 'smooth' : 'auto' });
  },
  // Complete, skip or reopen the step, then advance the card. Return false if confirmation was declined. Give tap
  // feedback unless a swipe already gave it.
  async tickStep(s, op, felt = false) {
    const r = this.view.shownRun;
    if (!r) return;
    if (op === 'done' && this.stepLock(s)) return false; // the Done button of a step that can't be ticked yet does nothing
    const current = this.runView?.step?.id === s.id;
    let html = '';
    // Send this step's draft as a Skip reason or a Done note. Each step keeps its own draft.
    if (op !== 'undone') this.unlockSound();
    // Vikunja lets each person remove only their own ✅, so another person's ✅ stays.
    const others = op === 'undone' ? (s.by || []).filter(u => u.id !== this.user?.id).map(u => this.nameOf(u)) : [];
    if (others.length && !confirm(othersDoneAsk(others, s.title))) return false;
    const typed = op === 'undone' ? '' : (this.runDrafts[s.id] || '').trim();
    if (typed) this.runDrafts[s.id] = '';
    // Done also sends what is typed or picked in the step's fields, as its own comment, before the tick.
    const answers = op === 'done' ? this.takeAnswers(s) : '';
    if (op === 'skip') html = textToHtml('Skipped' + (typed ? ': ' + typed : ''));
    if (op === 'done' && typed) {
      op = 'doneNote';
      html = textToHtml(typed);
    }
    if (current && op !== 'undone') {
      r.at = this.nextStep(s);
      if (r.last) r.last.held = null;
    }
    if (!felt) haptic(tickFeel(op === 'undone'));
    if (answers) await this.act({ op: 'answer', task: s.id, html: answers });
    await this.act({ op, task: s.id, ...(html && { html }) });
  },
  /* Advance to the next open step, or an earlier timed step that is due, wrapping to the first open step. Return
     null when only the completed step remained. */
  nextStep(s) {
    const i = this.runView ? whereNext(this.runView.steps, serverTime(this.clock), s) : -1;
    return i < 0 ? null : i;
  },
  async addNote(task) {
    const text = this.runDrafts[task]?.trim();
    if (!text) return;
    this.runDrafts[task] = '';
    await this.act({ op: 'note', task, html: textToHtml(text) });
  },
  async finishRun() {
    const run = this.runTask;
    if (!run) return;
    const r = await this.act({ op: 'finish', task: run.id });
    if (r.status === 'error') return;
    // Show the message as a toast, because the previous screen that Back returns to has no place for it.
    if (!r.behind)
      this.notify(r.status === 'offline' ? finishedText('', r) : finishedText(run.title), {
        label: UNDO,
        fn: () => this.reopenRun(run.id),
      });
    this.leaveRun();
  },
  // Reopen a finished checklist. Called from Undo after finishing, or from Reopen in the checklist's ⋯ menu.
  async reopenRun(id) {
    this.closeSheet(true);
    const r = await this.act({ op: 'reopen', task: id, run: id });
    if (r.status === 'error') return;
    if (this.route.name === 'run' && this.route.id === id) this.render();
    else this.openRun(id);
  },

  /* ---------- steps added during a run ---------- */
  /* Insert or repeat a step through the outbox. Show it in place and allow ticks while it waits offline. */
  /* Describe where the run's add box inserts steps. Return the step above the box, which Repeat copies, plus the
     predecessor and successor at the box's position. Above a box at the bottom is the last step. Hide the box on
     finished or read-only runs. */
  get runAim() {
    const v = this.runView;
    if (!v || v.finished || !v.steps.length || !this.canWrite(this.runTask.project_id)) return null;
    const same = x => String(this.actTask({ task: x }));
    const above =
      (this.runBoxAt != null && v.steps.find(s => same(s.id) === same(this.runBoxAt))) || v.steps[v.total - 1];
    return { above, after: above.id, before: v.steps[above.i + 1]?.id ?? null };
  },
  /* Queue each step in list order between after and before. With follow, move the box under the last queued step
     before sending, so the next entry follows it. Return the entry ids. */
  async addSteps(list, { after, before, follow = false }) {
    if (!list.length) return [];
    const ids = list.map(f => f.id || uuid7());
    if (follow && this.runBoxAt != null) {
      this.runBoxAt = 'pending-' + ids.at(-1);
      this.seatFoot('run');
    }
    for (const [i, f] of list.entries()) {
      await this.addStep({ ...f, id: ids[i], before, after });
      after = 'pending-' + ids[i];
    }
    return ids;
  },
  // Parse each line as a step with assignees, labels and priority. Step dates come from template timing.
  async insertStep() {
    const lines = this.boxParsedLines('ins').filter(p => p.title);
    const a = this.runAim;
    if (!lines.length || !a) return;
    this.runInsert = { ...newBox(), focus: this.runInsert.focus };
    await this.addSteps(
      lines.map(p => ({ title: p.title, p: packParsed(p) })),
      { after: a.after, before: a.before, follow: true },
    );
  },
  /* Repeat the step above the add box, whichever step is on the card. The copy goes right after that step, and the
     box stays where it is, with Undo beside it. A pending step has no saved task to copy yet. */
  async repeatAbove() {
    const s = this.runAim?.above;
    if (!s || s.pending) return;
    const id = uuid7();
    this.say(repeatedStep(s.title), {
      place: 'cap',
      action: { label: UNDO, fn: () => this.undoAdded(id, s.title) },
    });
    await this.repeatStep(s, id);
  },
  // Add a copy of step `s` right after it, as entry `id`. A step from a template is copied from that template step. An
  // inserted step is copied from its title.
  async repeatStep(s, id) {
    await this.addSteps([{ title: s.title, from: s.from, tpl: s.tpl ?? null, id }], {
      after: s.id,
      before: this.runView.steps[s.i + 1]?.id ?? null,
    });
  },
  // Undo a step just added. Cancel it if it is still waiting to be sent, otherwise delete it.
  async undoAdded(id, title) {
    if (await this.cancelMade(id, true)) {
      const tid = sync.taskOf(id);
      if (tid)
        await this.deleteAddedStep(
          this.runView?.steps.find(x => x.id === tid) || { id: tid, title, added: 'Repeated', done: false },
          true,
        );
    }
    this.said = notRepeated(title);
  },
  /* Queue step progress like a tick. At 100%, mark it done with its completion reaction. Reopen a done step before
     lowering its progress. undoing restores the previous progress. */
  async stepProgress(s, pct, undoing = false) {
    if (s.done && pct < 100 && !undoing && (await this.tickStep(s, 'undone', true)) === false) return;
    if (pct >= 100 && !undoing) {
      if ((await this.tickStep(s, 'done', true)) === false) return;
      this.said = tickSaid(true, s.title);
      return;
    } // a swipe leaves no focused box to announce it
    // Below 100%, show progress on the tick so a reverse swipe can undo it without a message covering the row.
    const r = await this.act({ op: 'progress', task: s.id, pct });
    if (r.status !== 'error' && !undoing) this.said = progressSaid(pct, s.title);
  },
  /* Add a step to the checklist on screen as an addStep op. It shows in place at once, and can be ticked while it
     waits to be sent. */
  async addStep({ id, title, p, from = null, tpl = null, before, after }) {
    const r = this.view.shownRun,
      run = this.runTask;
    if (!r || !run) return;
    // If the step to insert before is itself waiting to be sent, use the step that one goes before.
    if (typeof before === 'string') before = this.pending.find(e => 'pending-' + e.id === before)?.before ?? null;
    await this.act({
      id,
      op: 'addStep',
      task: r.id,
      run: r.id,
      title,
      from,
      tpl,
      before,
      after,
      under: r.id,
      pid: run.project_id,
      runTitle: run.title,
      ...(!from && { p: p ?? packParsed({ title, labels: [], assignees: [] }) }),
    });
    return id;
  },
  // Ask whether to delete a step added during a checklist. Used by the step's × and its row's Delete.
  askDeleteStep(s) {
    return !!s?.added && !s.done && confirm(deleteStepAsk(s.title));
  },
  /* Delete an open inserted or repeated step, as a delete op with no Restore, which writes the checklist's progress
     last. Template steps must be skipped instead. undo skips confirmation and messages for Repeat's Undo, and asked
     records confirmation before a swipe. Return whether the step was removed. A refusal keeps the step, and the
     sender says why. A step still being added is cancelled instead. */
  async deleteAddedStep(s, undo = false, asked = false) {
    if (!s?.added || s.done || (!undo && !asked && !this.askDeleteStep(s))) return false;
    if (s.pending) {
      await this.cancelMade(s.pending, undo);
      return true;
    }
    if ((await this.deleteNow([[s.id]])).status === 'error') return false;
    if (!undo) this.say(SAID.stepDeleted, { place: ['sheet:top', 'step'] });
    this.render();
    return true;
  },
  async refreshRunTask(id) {
    try {
      const at = started(),
        t = await allComments(await api(`/tasks/${id}?expand=reactions&expand=comments`));
      this.change(w => w.read([t], TASK_REACTIONS_COMMENTS, at));
      this.saveRun();
    } catch {}
  },
};
