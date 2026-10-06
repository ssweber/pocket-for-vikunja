// Starting a run, and working through one.
import {cache, store, taskDrafts, ZERO} from '../util.js';
import {api, ApiError, errText, items, NetError, passing, serverTime, triedSince} from '../api.js';
import {dueInfo, isSet} from '../dates.js';
import {pctOf} from '../progress.js';
import {htmlToText, textToHtml} from '../html.js';
import {addedText, allComments, DONE_MARK, durText, hasTemplateLabel, inBatches, isRunDesc, isRunStepTask, noteOf, notesOnly, parseStep, patiently, plainRun, plainStep, problemText, SKIP_MARK, skippedBy, stepFrom, stepProblems, stepsOf} from '../checklists.js';
import {routeOf} from '../routing.js';
import {ACT_STEPS, ACTS, heldTasks, INSERT_STEPS, KEPT, NO_ROOM, NOT_KEPT, randomId, RUN_STEPS, runProgress, sync} from '../sync.js';
import {saved} from '../lists.js';
import {shared} from './core.js';
import {renderSeq} from './views.js';

let actCount = 0;                                // orders things done in the same millisecond
/* Ticks that waited to be sent (offline): Vikunja has a step done when the tick arrived, but its countdowns go on
   counting from when it was ticked here, as they did while it waited, so they don't jump, nor chime again. By step:
   {here, there: Vikunja's done time, while it's that tick's, kept: when}. Kept a day. */
let ticks = null;
const keptTicks = () => ticks ||= saved.get('ticks') || {};

export default {
  async openStart(id){
    this.openSheet('start');
    const mine = this.sheet;
    Object.assign(this.sheet, {loading: true, start: {template: null, steps: [], people: [], forId: this.user?.id, busy: false, name: '', next: 1}});
    try {
      // Without a connection, the template as it was last loaded under Checklists: the run is set up once Pocket
      // reaches Vikunja.
      const t = await api('/tasks/' + id).catch(e => { const k = e instanceof NetError && saved.get('templates')?.[id]; if (k) return k; throw e; });
      // Who it can be for: everyone the project is shared with. A token without Projects → Users search: just you.
      let people = [];
      try {
        people = items(await api(`/projects/${t.project_id}/users/search`));
        // Not someone it's shared with to read only: they couldn't tick a step. (Someone in a team is kept.)
        const shares = items(await api(`/projects/${t.project_id}/users`).catch(() => [])), ro = new Set(shares.filter(x => (x.permission ?? x.right) === 0).map(x => x.id));
        people = people.filter(u => !ro.has(u.id));
        saved.set('people.' + t.project_id, people);
      } catch (e) { if (e instanceof NetError) people = saved.get('people.' + t.project_id) || []; }
      if (this.sheet !== mine) return;
      const me = this.user;
      people = [me, ...people.filter(u => u.id !== me.id).sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username))];
      Object.assign(this.sheet.start, {template: {id: t.id, title: t.title, project_id: t.project_id}, steps: stepsOf(t), people,
        next: (t.related_tasks?.copiedto || []).length + 1});
    } catch (e) { if (this.sheet === mine) this.sheet.error = errText(e); }
    finally { if (this.sheet === mine) this.sheet.loading = false; }
  },
  get startProgress(){ const s = this.starting; return s ? `Setting up… ${Math.round(100 * s.done / s.total)}%` : 'Setting up…'; },
  /* A run is set up through the outbox, so a start that's cut off carries on where it stopped once Pocket reaches
     Vikunja again. Only a timed first step is due from the start, counted from the tap on Start: every other timed step
     counts from a step being done, and gets its due date then. */
  async startRun(){
    const st = this.sheet.start;
    if (!st?.template || st.busy) return;
    this.unlockSound();                                                      // a tap: so a countdown can chime later
    const problems = stepProblems(st.steps.map(s => s.title));
    if (problems.length) { this.notify('Not started: ' + problemText(problems)); return; }
    const start = new Date(), steps = st.steps.map((s, i) => {
      const {title, offset} = parseStep(s.title);
      return {from: s.id, title, due: i === 0 && offset !== null ? new Date(serverTime(+start) + offset).toISOString() : null, timed: offset !== null, remind: offset >= 6e4, tpl: s.title,
        taskId: null, tried: false, linked: false, ready: false};
    });
    const who = st.people.find(u => u.id === st.forId) || this.user;
    const entry = {id: randomId(), kind: 'run', user: this.user?.id, at: start.toISOString(), items: [], files: [], template: st.template, name: st.name.trim(),
      for: {id: who.id, username: who.username, name: who.name || ''}, steps, fails: 0};
    st.busy = true;
    this.starting = {id: entry.id, done: 0, total: 5 + steps.length * 3};
    const {kept, full} = await sync.add(entry, []);
    const r = await sync.lock(() => this.sendEntry(entry.id));
    this.starting = null; st.busy = false;
    this.refreshPending();
    if (r.status === 'sent' || r.status === 'gone') {
      this.closeSheet(true);
      if (r.runId) this.openRun(r.runId);
      this.notify('Started ' + st.template.title, r.runId && {label: 'Undo', fn: () => this.deleteRun(r.runId)});
      this.toast.startOf = r.runId;                                          // gone once anything's done in the run (act)
    } else if (r.status === 'offline') {
      sync.keep();
      this.closeSheet(true);
      this.notify(!kept ? (full ? NO_ROOM : NOT_KEPT) : `${st.template.title} starts as soon as Pocket reaches Vikunja.`);
      if (this.route.name === 'checklists') this.render(); else this.go('#/checklists');
    } else this.notify('Not started: ' + r.error.message);
  },
  async sendRun(j){
    const save = () => sync.save(j), c = {save, taken: new Set([j.runId, ...j.steps.map(s => s.taskId)].filter(Boolean))};
    const none = {ids: [], tasks: [], problems: [], uploaded: 0};
    if (j.cancelled) return this.unstart(j, c, none);
    try {
      for (const step of RUN_STEPS) while (!step.done(j)) {
        await patiently(() => step.run(j, c));
        await save();
        if (this.starting?.id === j.id) this.starting.done = runProgress(j);
      }
      await sync.remove(j.id);
      return {...none, status: 'sent', runId: j.runId, changed: 1};
    } catch (error) {
      // No connection or signed out: kept for later. Vikunja still answering 500 after a few tries: kept too, a few times.
      if (passing(error) || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++j.fails < 5)))) {
        await save();
        return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401};
      }
      // What was set up so far is deleted: kept as a start called off until it is.
      error.what = 'Starting ' + j.template.title;
      j.cancelled = true; await save();
      await this.unstart(j, c, none);
      return {...none, status: 'error', error};
    }
  },
  /* A start called off, or failed for good: each copy it made is deleted, steps first, a copy whose reply was lost
     found first. Without a connection it stays in the outbox, to finish later. */
  async unstart(j, c, none){
    try {
      if (!j.runId && j.tried) { const t = await this.findCopy(j.template.id, j, j.at, c.taken, j.id, null); if (t) { j.runId = t.id; c.taken.add(t.id); } }
      for (const s of j.steps) if (!s.taskId && s.tried) {
        const t = await this.findCopy(s.from, s, j.at, c.taken, j.id, j.runId);
        if (t) { s.taskId = t.id; c.taken.add(t.id); }
      }
      await sync.save(j);
      const kids = j.runId ? await api('/tasks/' + j.runId).then(t => (t.related_tasks?.subtask || []).map(s => s.id), e => { if (e.status === 404) return []; throw e; }) : [];
      for (const id of [...new Set([...j.steps.map(s => s.taskId).filter(Boolean), ...kids]), j.runId].filter(Boolean)) {
        await patiently(() => api('/tasks/' + id, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
        cache.delete(id); this.removeRow(id);
      }
      await sync.remove(j.id);
      return {...none, status: 'sent', changed: 0};
    } catch (error) {
      if (passing(error) || error.status === 401 || error.status >= 500) { await sync.save(j); return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401}; }
      await sync.remove(j.id);
      error.what = 'Clearing up a start called off';
      return {...none, status: 'error', error};
    }
  },
  /* The copy a cut-off duplicate made, if it got there: copied from this task during that try (rec: triedAt, and
     triedUntil once it failed), by you, not one already used, still as it was copied (no steps of its own, and for a
     run, the template's title then or now, not a run's name), and under no other run than `run`. A copy someone else
     made, or you on another device, is theirs. */
  async findCopy(from, rec, at, taken, key, run){
    const src = await api('/tasks/' + from), since = triedSince(rec.triedAt, at);
    const until = rec.triedUntil ? serverTime(rec.triedUntil) + 3000 : Infinity;
    const near = (src.related_tasks?.copiedto || []).filter(t => !taken.has(t.id) && !sync.claimedByOther(t.id, key)
      && new Date(t.created).getTime() >= since && new Date(t.created).getTime() <= until);
    for (const c of near) {
      const t = await api('/tasks/' + c.id), r = t.related_tasks || {};
      const asCopied = run !== null || t.title === src.title || t.title === rec.triedTitle;
      if (t.created_by?.id === this.user?.id && asCopied && !r.subtask?.length && (r.parenttask || []).every(p => p.id === run)) return t;
    }
    return null;
  },
  /* A run's ⋯: its name, the part between the template's name and the day ("Startup · Night shift · Oct 5"), and who
     it's for, picked as when it was started. */
  async openRunOptions(){
    const run = this.view.run?.run;
    if (!run) return;
    this.openSheet('runopts');
    const parts = run.title.split(' · '), named = parts.length >= 3;
    this.sheet.runEdit = {prefix: named ? parts[0] : '', day: named ? parts[parts.length - 1] : '', name: named ? parts.slice(1, -1).join(' · ') : run.title,
      forId: run.assignees?.[0]?.id ?? null, people: []};
    const edit = this.sheet.runEdit;
    try {
      const people = items(await api(`/projects/${run.project_id}/users/search`)), me = this.user;
      edit.people = [me, ...people.filter(u => u.id !== me.id).sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username))];
    } catch { edit.people = [this.user]; }
  },
  async saveRunName(){
    const e = this.sheet.runEdit, run = this.view.run?.run, name = e?.name.trim();
    if (!run || !name) { if (e) e.name = run.title.split(' · ').slice(1, -1).join(' · ') || run.title; return; }
    const title = e.prefix ? [e.prefix, name, e.day].join(' · ') : name;
    if (title === run.title) return;
    try { const t = await this.saveTask(run.id, {title}); run.title = t.title; this.saveRun(); this.notify('Renamed'); }
    catch (err) { this.notify(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message); }
  },
  async setRunFor(u){
    const e = this.sheet.runEdit, run = this.view.run?.run;
    if (!run || e.forId === u.id) return;
    const was = e.forId;
    e.forId = u.id;
    try {
      // After any save still going (a new name, say), so Vikunja doesn't save over it with the old assignee.
      const put = shared.saveChain.then(() => api(`/tasks/${run.id}/assignees/bulk`, {method: 'PUT', body: {assignees: [{id: u.id}]}}));
      shared.saveChain = put.catch(() => {});
      await put;
      run.assignees = [u]; this.saveRun();
      this.notify('Now for ' + (u.id === this.user?.id ? 'you' : u.name || u.username));
    } catch (err) { e.forId = was; this.notify(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message); }
  },
  // Delete a run, from its ⋯ or its sheet: its steps go too, so none is left behind as a task of its own.
  async confirmDeleteRun(run){
    const n = run.steps.length;
    if (!confirm(`Delete “${run.title}” and its ${n} step${n === 1 ? '' : 's'}? Their notes and photos go too, for everyone. This can't be undone.`)) return;
    this.closeSheet(true);
    await this.deleteRun(run.id, {deleted: true});
  },
  // Undo a start, or clear up one that failed half way: the run's steps, then the run. Anything done on it that's still
  // waiting to be sent goes too.
  async deleteRun(id, {quiet = false, also = [], deleted = false} = {}){
    try {
      const t = await api('/tasks/' + id);
      for (const sid of new Set([...(t.related_tasks?.subtask || []).map(s => s.id), ...also]))
        await patiently(() => api('/tasks/' + sid, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
      await patiently(() => api('/tasks/' + id, {method: 'DELETE'}));
      cache.delete(id); this.removeRow(id);
      if (this.sheet.task?.id === id) Object.assign(this.sheet, {editingDesc: false, commentDraft: ''});
      if (!quiet) {
        const ids = new Set([id, ...(t.related_tasks?.subtask || []).map(s => s.id)]);
        await sync.lock(async () => { for (const e of sync.all(this.user?.id)) if (e.kind === 'act' && (e.run === id || ids.has(e.task))) await sync.remove(e.id); });
        this.refreshPending();
        this.notify(deleted ? 'Run deleted' : 'Run removed');
      }
      if (this.route.name === 'run' && this.route.id === id) this.leaveRun(); else if (!quiet) this.render();
    } catch (e) { if (!quiet) this.notify('Not removed: ' + e.message); }
  },

  /* ---------- a run ---------- */
  // A run, with each step's reactions (who did it), notes and photos.
  async loadRun(seq, id){
    const run = await allComments(await api(`/tasks/${id}?expand=comments`).catch(e => { if (e.status === 404) e.runGone = true; throw e; }));
    if (this.projects.length && !this.isRunTask(run)) throw new ApiError(404, 'This task isn\'t a checklist run. Open it from its project instead.');
    const steps = await inBatches(stepsOf(run), 4, async s => allComments(await api(`/tasks/${s.id}?expand=reactions&expand=comments`)));
    if (seq !== renderSeq) return;
    for (const t of [run, ...steps]) cache.set(t.id, t);
    const keep = this.view.run?.run.id === id ? this.view.run : null;      // the same run, refreshed: same step, same drafts
    if (!keep) this.runInsert = null;
    const asked = keep ? -1 : steps.findIndex(s => s.id === this.route.step);   // opened on a step, from a list
    this.view.run = {run: plainRun(run), steps: steps.map(plainStep), at: keep ? keep.at : asked >= 0 ? asked : null, last: keep?.last || null};
    this.saveRun();
    if (!keep?.last) this.loadLast(this.view.run.run);
  },
  // Kept for opening offline: the last few runs opened.
  saveRun(){
    const r = this.view.run;
    if (!r) return;
    const ids = [r.run.id, ...(saved.get('runs.recent') || []).filter(id => id !== r.run.id)];
    for (const id of ids.slice(8)) store.del('saved.run.' + id);
    saved.set('runs.recent', ids.slice(0, 8));
    saved.set('run.' + r.run.id, {run: r, at: new Date().toISOString()});
  },
  // The handover: notes left on the last finished run of the same template, on the run and on its steps.
  async loadLast(run){
    if (!run.from) return;
    const here = () => this.view.run?.run.id === run.id;
    try {
      const prev = ((await api('/tasks/' + run.from)).related_tasks?.copiedto || []).filter(x => x.id !== run.id && x.done)
        .sort((a, b) => new Date(b.done_at) - new Date(a.done_at))[0];
      if (!prev || !here()) return;
      this.view.run.last = {id: prev.id, title: prev.title, notes: null};
      const full = await allComments(await api(`/tasks/${prev.id}?expand=comments`));
      const steps = await inBatches(stepsOf(full), 4, async s => allComments(await api(`/tasks/${s.id}?expand=comments`)));
      const notes = [...(full.comments || []).map(c => ({...noteOf(c), step: 'The run'})),
        ...steps.flatMap(s => (s.comments || []).map(c => ({...noteOf(c), step: parseStep(s.title).title + (addedText(s.description) ? ` (${addedText(s.description).toLowerCase()})` : '')})))];
      if (here()) { this.view.run.last = {id: prev.id, title: prev.title, notes}; this.saveRun(); }
    } catch { if (here() && !this.view.run.last?.notes) this.view.run.last = null; }
  },
  /* The run on screen, with what's waiting to be sent laid over it, so ticks, skips and notes show straight away. */
  get runView(){
    const r = this.view.run;
    if (!r) return null;
    const me = this.user, myName = me?.name || me?.username || 'You';
    const acts = this.pending.filter(e => e.kind === 'act' && e.run === r.run.id);
    const waitingNote = a => ({id: a.id, comment: a.html, author: myName, when: 'Waiting to send'});
    // Steps inserted or repeated that are still waiting to be sent, in their place: before the step they were inserted at.
    const base = [...r.steps];
    for (const e of this.pending) if (e.kind === 'step' && e.run === r.run.id && !base.some(s => s.id === e.taskId)) {
      const k = base.findIndex(s => s.id === e.before);
      base.splice(k < 0 ? base.length : k, 0, {id: 'pending-' + e.id, title: e.title, done: false, done_at: null, due_date: ZERO, updated: e.at, description: '',
        assignees: [], attachments: [], reactions: {}, comments: [], tpl: e.tpl ?? null, from: e.from, added: e.from || e.tpl != null ? 'Repeated' : 'Inserted', pending: e.id});
    }
    const steps = base.map((s, i) => {
      const skipper = skippedBy(s);
      let done = s.done, skipped = !!skipper, waiting = false, doneAt = s.done_at;
      const kept = keptTicks()[s.id];
      if (done && kept && Date.parse(kept.there) === Date.parse(s.done_at)) doneAt = kept.here;
      let by = skipped ? [skipper] : s.reactions?.[DONE_MARK] || [];
      const doers = () => by.map(u => u.name || u.username);
      const notes = (s.comments || []).map(noteOf);
      for (const a of acts) if (this.actTask(a) === s.id) {
        if (a.op === 'note' || a.op === 'skip' || a.op === 'doneNote') notes.push(waitingNote(a));
        if (a.op === 'note' || a.op === 'claim' || a.op === 'unclaim') continue;
        waiting = true; done = a.op !== 'undone'; skipped = a.op === 'skip'; doneAt = a.at; by = me ? [me] : [];
      }
      const slot = s.pending ? null : this.claimSlot({...s, project_id: r.run.project_id}, this.peopleOf(s.id, s.assignees), done || r.run.done);
      // by: who did it or skipped it, shown in the list as a reaction is, ✅ or ⏭️ with their picture.
      return {id: s.id, i, title: parseStep(s.title).title, description: notesOnly(s.description), attachments: s.attachments, done, skipped, waiting, notes, doneAt, slot, by,
        added: s.added || '', pending: s.pending || null, from: s.from || null, tpl: s.tpl,
        whoText: !done ? '' : (skipped ? 'Skipped' : 'Done') + (waiting ? ' · waiting to send' : by.length ? ' by ' + doers().join(', ') : '')};
    });
    /* When each step is due. A timed step (T# in its template step) counts from the step it waits on being done: from
       Vikunja's done time of it, or, while that tick waits to be sent, from when it was ticked here. Vikunja's due date
       counts instead if someone changed the step after that tick: Pocket's plugin sets due dates without touching
       "updated", so one it set (maybe from an earlier tick) doesn't. "updated" has whole seconds, and things done
       offline reach Vikunja within one, so a change in the same second as the tick counts as before it. Until that
       step is done it says what it waits on, not a time.
       "The step before" and names are read among the template's steps only, as the plugin does: an inserted step has no
       time and isn't seen. A repeated one has no time of its own, but stands in for the one it repeats: a step timed from
       that counts from whichever of them was done last. */
    const group = [], timing = [], place = [], now = serverTime(this.clock);
    base.forEach((s, i) => {
      group[i] = -1;
      if (!s.added) { group[i] = timing.length; timing.push(parseStep(s.tpl || '')); place.push(i); }
      else if (s.tpl != null) for (let j = i - 1; j >= 0; j--) if (group[j] >= 0 && base[j].tpl === s.tpl) { group[i] = group[j]; break; }
    });
    const lastOf = g => steps.filter((s, i) => group[i] === g && s.done).sort((a, b) => new Date(a.doneAt) - new Date(b.doneAt)).pop() || steps[place[g]];
    steps.forEach((s, i) => {
      const own = !s.added && group[i] >= 0, t = own ? timing[group[i]] : {offset: null}, j = own ? stepFrom(timing, group[i]) : null, from = j >= 0 ? lastOf(j) : null;
      let due = isSet(base[i].due_date) ? new Date(base[i].due_date) : null, waitsOn = '';
      if (from) {
        if (!from.done) { due = null; waitsOn = t.offset ? `${durText(t.offset)} after “${from.title}”` : `when “${from.title}” is done`; }
        else if (from.waiting || !due || !(Math.floor(+new Date(base[i].updated) / 1000) > Math.floor(+new Date(from.doneAt) / 1000)))
          due = new Date((from.waiting ? serverTime(+new Date(from.doneAt)) : +new Date(from.doneAt)) + t.offset);
      }
      const left = due ? due - now : 0, soon = Math.abs(left) < 864e5;
      s.late = !!due && (s.done ? new Date(s.doneAt) > due : left < 0);
      s.counting = !s.done && t.offset !== null && !!due && soon;      // a countdown: pinned at the top while it runs
      s.dueAt = due ? +due : Infinity;
      s.countText = !s.counting ? '' : left >= 0 ? 'in ' + durText(left < 6e4 ? Math.ceil(left / 1e3) * 1e3 : Math.ceil(left / 6e4) * 6e4) : durText(-left < 6e4 ? -left : Math.floor(-left / 6e4) * 6e4) + ' late';
      s.dueText = waitsOn ? 'Due ' + waitsOn : s.counting ? (left >= 0 ? 'Due ' : '') + s.countText : due ? 'Due ' + dueInfo(due.toISOString()).label : '';
    });
    const total = steps.length, doneCount = steps.filter(s => s.done).length, first = steps.findIndex(s => !s.done);
    const allDone = total > 0 && doneCount === total, at = r.at ?? (first >= 0 ? first : total - 1);
    const skippedN = steps.filter(s => s.skipped).length, lateN = steps.filter(s => s.done && s.late).length;
    const by = r.run.created_by, starter = by && (by.id === me?.id ? 'you' : by.name || by.username);
    const forText = [this.forText(r.run), starter && 'started by ' + starter].filter(Boolean).join(' · ');
    const step = allDone && r.at === null ? null : steps[at] || null;
    // The step before the one on screen, done, can be repeated: a fresh copy goes before the one on screen.
    const before = step && steps[at - 1], repeatable = before?.done && !before.pending ? before : null;
    return {steps, total, doneCount, allDone, at, step, repeatable, timers: steps.filter(s => s.counting && s !== step).sort((a, b) => a.dueAt - b.dueAt),
      finished: (acts.filter(a => a.op === 'finish' || a.op === 'reopen').pop()?.op ?? (r.run.done ? 'finish' : '')) === 'finish',
      summary: [`${total} step${total === 1 ? '' : 's'}`, skippedN && `${skippedN} skipped`, lateN && `${lateN} done late`].filter(Boolean).join(' · '),
      notes: [...(r.run.comments || []).map(noteOf), ...acts.filter(a => a.op === 'note' && a.task === r.run.id).map(waitingNote)],
      forText: forText && forText[0].toUpperCase() + forText.slice(1)};
  },
  /* A run opens on its own screen, a step of one on that step. Back goes to the screen before: Today, a project, search
     or Checklists (runFrom, kept by render). */
  openRun(id, step = null){
    this.closeSheet(true);
    this.go('#/run/' + id + (step ? '?step=' + step : ''));
  },
  leaveRun(){ this.back(this.runFrom || '#/checklists'); },
  // The run on screen was deleted (on another phone, say): off its screen, and no longer kept for opening offline.
  runGone(id){
    store.del('saved.run.' + id); saved.set('runs.recent', (saved.get('runs.recent') || []).filter(x => x !== id));
    if (this.view.run?.run.id === id) this.view.run = null;
    this.leaveRun();
    this.notify('That run isn\'t there any more.');
  },
  // Where Back goes, by name: from a run, the screen before it; from a project, the list it was opened from.
  get backName(){
    if (this.route.name === 'run') return {today: 'Today', project: 'the project', search: 'search'}[routeOf(this.runFrom || '').name] || 'checklists';
    return {today: 'Today', search: 'search', checklists: 'checklists'}[routeOf(this.projectFrom || '').name] || 'projects';
  },
  // A checklist run, done or not: a copy of a template, in a checklist project, not under another task.
  isRunTask(t){
    const r = t?.related_tasks || {};
    return !!t && this.checklistIds.has(t.project_id) && (!!r.copiedfrom?.length || isRunDesc(t.description)) && !r.parenttask?.length && !hasTemplateLabel(t);
  },
  // Whether you can change things in a project: not when it's shared with you to read only. (Not known yet: yes.)
  canWrite(pid){ const v = this.perms[pid]; return v === undefined || v === null || v >= 1; },
  get canEdit(){ return !!this.sheet.task && this.canWrite(this.sheet.task.project_id); },
  /* Your access to each project, asked of Vikunja once per project and kept: its list of projects doesn't say. In the
     background, a few at a time; `force` asks again for all. */
  async loadPerms(force = false){
    const todo = this.projects.filter(p => p.id > 0 && (force || !(p.id in this.perms)));
    if (!todo.length) return;
    try {
      await inBatches(todo, 4, async p => { const full = await api('/projects/' + p.id); this.perms[p.id] = full.max_permission ?? 1; });
      saved.set('perms', this.perms);
    } catch {}
  },
  // The run a task is a step of, or null.
  stepRun(t){
    const r = t?.related_tasks || {};
    return this.checklistIds.has(t?.project_id) && isRunStepTask(t) && !hasTemplateLabel(t) ? r.parenttask[0].id : null;
  },
  // Whether a list row has a tick: not a template, and not a run, except in its project's own list.
  canTick(t){
    if (!this.canWrite(t.project_id)) return false;
    if (this.checklistIds.has(t.project_id) && hasTemplateLabel(t)) return false;
    return !this.isRunTask(t) || this.route.name === 'project';
  },
  // A step as done or not, counting ticks still waiting to be sent.
  stepDone(id, done){
    const last = this.pending.filter(e => e.kind === 'act' && e.task === id && ['done', 'doneNote', 'skip', 'undone'].includes(e.op)).pop();
    return last ? last.op !== 'undone' : done;
  },
  // Progress as shown: a run's steps done (ticks waiting to be sent too), any other task's as set.
  shownPct(t){
    if (!this.isRunTask(t)) return pctOf(t);
    const steps = t.related_tasks?.subtask || [];
    return steps.length ? Math.round(100 * steps.filter(x => this.stepDone(x.id, x.done)).length / steps.length) : 0;
  },
  // A run's row under Checklists: steps done (waiting ticks too), and the next one.
  runCount(r){
    if (!r.steps) return {done: r.done, total: r.total, next: r.next};          // saved offline by an older Pocket
    const done = r.steps.map(x => this.stepDone(x.id, x.done));
    return {done: done.filter(Boolean).length, total: r.steps.length, next: r.steps.find((x, i) => !done[i])?.title || ''};
  },
  goProject(id){ this.closeSheet(true); this.go('#/project/' + id); },
  // A row in a list: a checklist run, or a step of one, opens the run; any other task opens its sheet.
  openRow(t){
    if (this.isRunTask(t)) return this.openRun(t.id);
    const run = this.stepRun(t);
    if (run) return this.openRun(run, t.id);
    this.openTask(t.id);
  },
  showStep(i, scroll){
    if (!this.view.run) return;
    this.view.run.at = i;
    this.closeInsert();                                                     // a step being inserted was for the step left
    if (scroll) scrollTo({top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  },
  // Done, skipped (with the note being written as the reason, if any) or not done after all. On to the next step.
  async tickStep(s, op){
    const r = this.view.run;
    if (!r) return;
    const current = this.runView?.step?.id === s.id;
    let html = '';
    // The note being written on this step goes with it: for Skip as the reason, for Done as a note. (Each step keeps
    // its own note being written.)
    if (op !== 'undone') this.unlockSound();
    const typed = op === 'undone' ? '' : (this.runDrafts[s.id] || '').trim();
    if (typed) this.runDrafts[s.id] = '';
    if (op === 'skip') html = textToHtml('Skipped' + (typed ? ': ' + typed : ''));
    if (op === 'done' && typed) { op = 'doneNote'; html = textToHtml(typed); }
    if (current && op !== 'undone') r.at = null;
    navigator.vibrate?.(10);
    await this.act({op, task: s.id, html});
  },
  async addNote(task){
    const text = this.runDrafts[task]?.trim();
    if (!text) return;
    this.runDrafts[task] = '';
    await this.act({op: 'note', task, html: textToHtml(text)});
  },
  async finishRun(){
    const run = this.view.run?.run;
    if (!run) return;
    const r = await this.act({op: 'finish', task: run.id});
    if (r.status === 'error') return;
    this.notify(r.status === 'offline' ? `Finished. It's sent once Pocket reaches Vikunja.` : 'Finished ' + run.title,
      {label: 'Undo', fn: () => this.reopenRun(run.id)});
    this.leaveRun();
  },
  // A finished run back in progress: from Finish run's Undo, or Reopen run in its ⋯.
  async reopenRun(id){
    this.closeSheet(true);
    const r = await this.act({op: 'reopen', task: id, run: id});
    if (r.status === 'error') return;
    if (this.route.name === 'run' && this.route.id === id) this.render(); else this.openRun(id);
  },
  /* Everything done on a run goes through the outbox. Anything done before it that's still waiting goes first, so it
     all reaches Vikunja in the order it was done. */
  async act(fields){
    if (this.toast.show && this.toast.startOf && this.toast.startOf === (fields.run ?? this.view.run?.run.id)) this.toast.show = false;
    // Its task's title, so Waiting to send can say what it is after a reload too.
    const entry = {id: randomId(), kind: 'act', user: this.user?.id, at: new Date().toISOString(), n: ++actCount, items: [], files: [], stage: 0, fails: 0,
      run: this.view.run?.run.id, label: this.actTitle(fields.task), ...fields};
    const {kept, full} = await sync.add(entry, []);
    this.refreshPending();
    let last = {status: 'gone'};
    await sync.lock(async () => {
      const all = sync.all(this.user?.id).filter(e => e.kind === 'act'), held = heldTasks(all);
      for (const e of all) {
        if (e.failed || held.has(e.task)) {                                  // waits behind one turned down
          if (e.id !== entry.id) continue;
          this.notify(`Waiting: something done before it on “${parseStep(entry.label || 'it').title}” was turned down. Tap the warning sign at the top to try that again.`);
          last = {status: 'offline', reached: true};
          break;
        }
        last = await this.sendEntry(e.id);
        if (last.kept) held.add(e.task);
        if (last.status === 'error') this.notify(`${last.error.what || 'It'} couldn't be saved${last.error.saved ? ` in full (${last.error.saved})` : ''}: ${last.error.message}.` + (last.kept ? KEPT : last.error.back ? ' Its words are back in the box.' : ''));
        if (last.status === 'offline' || e.id === entry.id) break;
      }
    });
    this.refreshPending();
    if (last.status === 'offline') { sync.keep(); if (!kept) this.notify(full ? NO_ROOM : NOT_KEPT); }
    return last;
  },
  async sendAct(a){
    const save = () => sync.save(a), stages = ACTS[a.op] || [], none = {ids: [], tasks: [], problems: [], uploaded: 0};
    let comment = null;
    try {
      // On a step inserted offline: its id once it's in Vikunja. Until then it waits; if it never got there, it's turned down.
      if (typeof a.task === 'string') {
        const key = a.task.replace(/^pending-/, ''), id = sync.taskOf(key);
        if (!id && sync.entries.has(key)) return {...none, status: 'offline', reached: true};
        if (!id) throw new ApiError(404, 'the step it was for couldn\'t be added');
        a.task = id; await save();
      }
      while (a.stage < stages.length) {
        const out = await patiently(() => ACT_STEPS[stages[a.stage]](a, save));
        if (stages[a.stage] === 'note' && out?.id) comment = out;
        if (stages[a.stage] === 'done' && out?.done_at) this.keepTick(a, a.doneAt = out.done_at);
        a.stage++;
        await save();
      }
      this.applyAct(a, comment);
      await sync.remove(a.id);
      if (!a.run && a.op === 'note' && this.sheet.task?.id === a.task) this.loadComments(a.task);   // a comment from a task's sheet
      if (a.op !== 'finish' && a.op !== 'reopen' && this.view.run?.run.id === a.run) this.refreshRunTask(a.task);
      return {...none, status: 'sent', changed: 1};
    } catch (error) {
      if (passing(error) || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++a.fails < 5)))) {
        await save();
        return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401};
      }
      if (error.status === 403 && /mark/i.test(stages[a.stage] || '') && this.mode === 'token')
        error.message = 'your API token can\'t record who did a step: make one with Reactions ticked, as the guide says';
      // Its first part went through (the tick, say, before the ✅ was refused): that much is in Vikunja, so it's said, and
      // the step is shown as Vikunja has it.
      if (a.stage > 0 && ['done', 'undone'].includes(stages[0])) error.saved = stages[0] === 'done' ? 'it\'s marked done' : 'it\'s marked not done';
      if (a.stage > 0 && this.view.run?.run.id === a.run) this.refreshRunTask(a.task);
      error.what = this.actWhat(a);
      // A note's words go back where they were written. Anything else is kept, under Waiting to send, to try again or
      // drop: a tick has no words to give back, and a toast is easily missed.
      if (a.op === 'note') { await sync.remove(a.id); this.giveBack(a, error); return {...none, status: 'error', error}; }
      a.failed = {message: error.message, at: new Date().toISOString()}; a.fails = 0;
      await save();
      return {...none, status: 'error', error, kept: true};
    }
  },
  // What an act was, for a message: "A tick on “Check the milk fridge”".
  actWhat(a){
    const title = a.label || this.actTitle(a.task), on = title ? ` on “${parseStep(title).title}”` : '';
    return {note: a.run ? 'A note' + on : 'A comment' + on, doneNote: 'A tick and its note' + on, skip: 'A skip' + on,
      done: 'A tick' + on, undone: 'An untick' + on, finish: 'Finishing the run', reopen: 'Reopening the run',
      claim: 'Saying you’ll do' + (title ? ` “${parseStep(title).title}”` : ' it'), unclaim: 'Letting go of' + (title ? ` “${parseStep(title).title}”` : ' it')}[a.op] || 'Something done offline';
  },
  /* An action on a run, or a comment, that won't be sent: its words go back where they were written, and `error.back`
     says so. */
  giveBack(a, error){
    const text = a.html ? htmlToText(a.html).replace(/^Skipped:?\s*/, '').trim() : '';
    if (!text) return;
    const add = (was = '') => [was.trim(), text].filter(Boolean).join('\n');
    if (!a.run) {
      taskDrafts.set('comment:' + a.task, add(taskDrafts.get('comment:' + a.task)));
      if (this.sheet.task?.id === a.task) this.sheet.commentDraft = add(this.sheet.commentDraft);
    } else this.runDrafts[a.task] = add(this.runDrafts[a.task]);
    error.back = true;
  },
  // A note whose reply was lost, if it got there: the same text, by you, since that try.
  async findNote(task, html, triedAt, at){
    const since = triedSince(triedAt, at), text = htmlToText(html);
    for (let page = 1; page <= 40; page++) {                                // newest first, back to the try
      const data = await api(`/tasks/${task}/comments?order_by=desc&per_page=50&page=${page}`), list = items(data);
      if (list.some(c => c.author?.id === this.user?.id && htmlToText(c.comment) === text && new Date(c.created).getTime() >= since)) return true;
      if (!list.length || page >= (data?.total_pages || 1) || new Date(list[list.length - 1].created).getTime() < since) return false;
    }
    return false;
  },
  keepTick(a, there){
    const here = serverTime(+new Date(a.at));
    if (Date.parse(there) - here < 5000) return;                           // sent as it was done
    ticks = Object.fromEntries(Object.entries(keptTicks()).filter(([, x]) => Date.now() - x.kept < 864e5));
    ticks[a.task] = {here: new Date(here).toISOString(), there, kept: Date.now()};
    saved.set('ticks', ticks);
  },
  // What a sent act changed, on the run on screen at once, so it doesn't flicker back until Vikunja's copy arrives.
  applyAct(a, comment){
    if (a.op === 'claim' || a.op === 'unclaim') { this.claimSent(a); return; }
    const r = this.view.run;
    if (!r || r.run.id !== a.run) return;
    if (a.op === 'finish' || a.op === 'reopen') { r.run.done = a.op === 'finish'; return; }
    const s = r.steps.find(x => x.id === a.task), me = this.user;
    if (s && a.op !== 'note') {
      const rs = {...s.reactions}, without = m => (rs[m] || []).filter(u => u.id !== me?.id);
      rs[DONE_MARK] = without(DONE_MARK); rs[SKIP_MARK] = without(SKIP_MARK);
      if (a.op !== 'undone') rs[a.op === 'skip' ? SKIP_MARK : DONE_MARK].push(me);
      Object.assign(s, {done: a.op !== 'undone', done_at: a.doneAt || new Date(serverTime(Date.now())).toISOString(), reactions: rs});
    }
    if (comment) { const on = s || r.run; on.comments = [...(on.comments || []), comment]; }
  },
  // The task an act is for: a step inserted offline is known by its entry until it's in Vikunja.
  actTask(a){ return typeof a.task === 'string' ? sync.taskOf(a.task.replace(/^pending-/, '')) ?? a.task : a.task; },

  /* ---------- steps inserted during a run ---------- */
  /* Insert a step before the one on screen, or repeat the one before it (repeatStep). Through the outbox, as a tick is:
     offline it waits, shown in its place, and can be ticked meanwhile. The run's screen then shows the new step. */
  /* The box for a step to insert opens in its place in Steps, with a history entry of its own, as a sheet has, so the
     phone's Back closes it; so do its ×, Escape, Enter or leaving it empty, and showing another step. */
  openInsert(){
    this.runInsert = {text: ''};
    if (!history.state?.insert) history.pushState({...(history.state || {}), insert: true}, '');
  },
  closeInsert(){
    if (!this.runInsert) return;
    this.runInsert = null;
    if (history.state?.insert) { shared.skipPop = true; history.back(); }
  },
  async insertStep(){
    const v = this.runView, title = this.runInsert?.text.trim();
    if (!v?.step || !title) return;
    this.closeInsert();
    await this.addStep({title, before: v.step.id});
  },
  async repeatStep(s){
    const v = this.runView;
    if (!v?.step || !s) return;
    await this.addStep({title: s.title, before: v.step.id, from: s.from, tpl: s.tpl ?? null});
  },
  async addStep(fields){
    const r = this.view.run;
    if (!r) return;
    // Before a step that's itself still waiting: where that one goes.
    if (typeof fields.before === 'string') fields.before = this.pending.find(e => 'pending-' + e.id === fields.before)?.before ?? null;
    const entry = {id: randomId(), kind: 'step', user: this.user?.id, at: new Date().toISOString(), n: ++actCount, items: [], files: [], fails: 0,
      run: r.run.id, runTitle: r.run.title, project: r.run.project_id, from: null, tpl: null, ...fields};
    const {kept, full} = await sync.add(entry, []);
    this.refreshPending();
    const res = await sync.lock(() => this.sendEntry(entry.id));
    this.refreshPending();
    if (res.status === 'offline') { sync.keep(); if (!kept) this.notify(full ? NO_ROOM : NOT_KEPT); }
    if (res.status === 'error') this.notify(`${res.error.what} couldn't be done: ${res.error.message}.`);
    if (res.status === 'sent' && this.view.run?.run.id === entry.run) this.render();
  },
  async sendStep(j){
    const save = () => sync.save(j), c = {save, taken: new Set()}, none = {ids: [], tasks: [], problems: [], uploaded: 0};
    try {
      for (const step of INSERT_STEPS) while (!step.done(j)) { await patiently(() => step.run(j, c)); await save(); }
      await sync.remove(j.id);
      return {...none, status: 'sent', changed: 1};
    } catch (error) {
      if (passing(error) || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++j.fails < 5)))) {
        await save();
        return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401};
      }
      // Turned down for good (the run deleted meanwhile, say): what it made goes again.
      if (j.taskId) await api('/tasks/' + j.taskId, {method: 'DELETE'}).catch(() => {});
      await sync.remove(j.id);
      error.what = (j.from || j.tpl != null ? 'Repeating' : 'Inserting') + ` “${j.title}”`;
      return {...none, status: 'error', error};
    }
  },
  /* Delete a step inserted or repeated during the run, until it's done: it was likely a mistake. One still waiting to
     be sent isn't sent, nor is anything done on it. A step from the template can't be taken out: it's skipped. */
  async deleteAddedStep(s){
    if (!s?.added || s.done || !confirm(`Delete “${s.title}”? It was added during this run: the template's steps stay as they are.`)) return;
    if (s.pending) { await this.dropStep(s.pending); return; }
    try {
      await patiently(() => api('/tasks/' + s.id, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
      cache.delete(s.id);
      await sync.lock(async () => { for (const e of sync.all(this.user?.id)) if (e.kind === 'act' && e.task === s.id) await sync.remove(e.id); });
      this.refreshPending();
      this.notify('Step deleted');
      this.render();
    } catch (e) { this.notify(e instanceof NetError ? 'Deleting a step needs a connection.' : 'Not deleted: ' + e.message); }
  },
  // Don't send a step waiting to be inserted, nor what was done on it; one being sent already can't be stopped.
  async dropStep(id){
    let started = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) return;
      if (e.taskId || e.tried || e.job?.tried) { started = true; return; }
      await sync.remove(id);
      for (const a of sync.all(this.user?.id)) if (a.kind === 'act' && a.task === 'pending-' + id) await sync.remove(a.id);
    });
    this.refreshPending();
    this.notify(started ? 'It\'s being sent: delete it once it\'s there.' : 'Not sent.');
  },
  async refreshRunTask(id){
    try {
      const t = await allComments(await api(`/tasks/${id}?expand=reactions&expand=comments`));
      cache.set(id, t);
      const r = this.view.run;
      if (!r) return;
      if (r.run.id === id) Object.assign(r.run, plainRun(t));
      else { const i = r.steps.findIndex(s => s.id === id); if (i >= 0) r.steps[i] = plainStep(t); }
      this.saveRun();
    } catch {}
  },
};
