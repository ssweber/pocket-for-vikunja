// Start checklists and compute their steps, progress, countdowns and pending changes.
import {andList, cache, memo, motion, raw, store, ZERO} from '../util.js';
import {allPages, api, ApiError, errText, items, NetError, passing, patchTask, serverTime, triedSince} from '../api.js';
import {addDays, dueInfo, fmtTime, isSet, startOfDay} from '../dates.js';
import {pctOf, tickFeel, workedOut} from '../progress.js';
import {haptic} from '../haptics.js';
import {htmlToText, textToHtml} from '../html.js';
import {addedText, allComments, commentShown, comesRound, isAnswer, countText, DONE_MARK, durText, inBatches, nextAfter, noteOf, notesOnly, parseStep, patiently, plainRun, runParts, plainStep, problemText, runWithoutDay, skippedBy, stepFrom, stepProblems, stepsOf, templateName, vikunjaNext, whereNext} from '../checklists.js';
import {routeOf} from '../routing.js';
import {stepAnswers} from '../asks.js';
import {INSERT_STEPS, NO_ROOM, NOT_KEPT, packParsed, randomId, RUN_STEPS, runProgress, sync} from '../sync.js';
import {saved} from '../lists.js';
import {completeAsk, sentLater, startedText} from '../messages.js';
import {newBox, shared} from './core.js';
import {renderSeq} from './views.js';
import {keptTicks, nextN} from './acts.js';

const LAST_WAIT = 600;                           // ms loadRun waits for Last time's notes after the steps have loaded
/* Cache each computed step by id and serialized content. Reuse unchanged step objects so their rows do not redraw
   when another step or countdown changes. */
const lastSteps = new Map();

export default {
  async openStart(id){
    this.openSheet('start');
    const mine = this.sheet;
    Object.assign(this.sheet, {loading: true, start: {template: null, steps: [], people: [], forIds: [this.user?.id], busy: false, name: '', next: 1}});
    try {
      // Start offline from the cached template, then create the run when Pocket reaches Vikunja.
      const t = await api('/tasks/' + id).catch(e => { const k = e instanceof NetError && saved.get('templates')?.[id]; if (k) return k; throw e; });
      // Offer people who can access the project. If Vikunja refuses the search, only you are offered.
      let people = [];
      try {
        people = items(await api(`/projects/${t.project_id}/users/search`));
        // Exclude direct read-only shares because those people cannot tick steps. Keep team members.
        const shares = items(await api(`/projects/${t.project_id}/users`).catch(() => [])), ro = new Set(shares.filter(x => (x.permission ?? x.right) === 0).map(x => x.id));
        people = people.filter(u => !ro.has(u.id));
        saved.set('people.' + t.project_id, people);
      } catch (e) { if (e instanceof NetError) people = saved.get('people.' + t.project_id) || []; }
      if (this.sheet !== mine) return;
      const me = this.user;
      people = [me, ...people.filter(u => u.id !== me.id).sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username))];
      // Default to the template's assignees who can write, or to you when none remain.
      const forIds = (t.assignees || []).map(u => u.id).filter(id => people.some(u => u.id === id));
      Object.assign(this.sheet.start, {template: {id: t.id, title: templateName(t.title), project_id: t.project_id, labels: t.labels, done: t.done,
        due_date: t.due_date, repeat_after: t.repeat_after, repeat_mode: t.repeat_mode}, steps: stepsOf(t), people, forIds: forIds.length ? forIds : [me.id],
        next: (t.related_tasks?.copiedto || []).length + 1, who: {}});
      // Fetch step assignees separately because Vikunja omits them from related tasks.
      const ids = stepsOf(t).map(s => s.id);
      if (ids.length) allPages('/tasks?' + new URLSearchParams({filter: `id in ${ids.join(', ')}`})).then(list => {
        if (this.sheet !== mine) return;
        this.sheet.start.who = Object.fromEntries(list.map(s => [s.id, andList((s.assignees || []).map(u => u.id === me.id ? 'you' : u.name || u.username))]));
      }, () => {});
    } catch (e) { if (this.sheet === mine) this.sheet.error = errText(e); }
    finally { if (this.sheet === mine) this.sheet.loading = false; }
  },
  // Choose who a checklist is for: any number of people, but at least one.
  toggleFor(st, u){
    const on = st.forIds.includes(u.id);
    if (on && st.forIds.length === 1) { this.say('A checklist needs at least one person. Tap someone else first.', {place: 'sheet:top', cls: 'failed'}); return; }
    st.forIds = on ? st.forIds.filter(id => id !== u.id) : [...st.forIds, u.id];
  },
  /* Use today's due date when starting a repeating template, even before its due time. Starting an 8:00 checklist
     at 7:55 must not create another at 8:00. */
  tickOf(tpl){ return comesRound(tpl) && new Date(tpl.due_date) < addDays(startOfDay(), 1) ? tpl.due_date : null; },
  // The note under For in the Start sheet. It says what starting does to a template that repeats.
  get startNote(){
    const t = this.sheet.start?.template;
    if (!t || !comesRound(t)) return '';
    const due = new Date(t.due_date), today = +startOfDay(due) === +startOfDay();
    const at = d => d.toLocaleString([], {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
    if (!this.tickOf(t)) return `${t.title} is next due ${at(due)}. Starting this checklist doesn't change that date.`;
    const one = today ? `at ${due.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}` : at(due);
    const next = vikunjaNext(t);
    if (next === null) return `This is the checklist due ${one}. Starting it marks ${t.title} done. ${t.title} doesn't repeat.`;
    return `This is the checklist due ${one}. Starting it moves ${t.title} to ${at(new Date(nextAfter(t, next)))}.`;
  },
  get startProgress(){ const s = this.starting; return s ? `Setting up… ${Math.round(100 * s.done / s.total)}%` : 'Setting up…'; },
  /* Queue the start so a lost connection resumes creation where it stopped. Time the first step from the Start
     tap. Other timed steps receive dates when the step they depend on is completed. */
  async startRun(){
    const st = this.sheet.start;
    if (!st?.template || st.busy) return;
    this.unlockSound();                                                      // unlock countdown audio during the tap
    const problems = stepProblems(st.steps.map(s => s.title));
    if (problems.length) { this.say('Not started: ' + problemText(problems), {place: 'sheet:top', cls: 'failed'}); return; }
    const start = new Date(), steps = st.steps.map((s, i) => {
      const {title, offset} = parseStep(s.title);
      return {from: s.id, title, due: i === 0 && offset !== null ? new Date(serverTime(+start) + offset).toISOString() : null, timed: offset !== null, remind: offset >= 6e4, tpl: s.title,
        taskId: null, tried: false, linked: false, ready: false};
    });
    const who = st.people.filter(u => st.forIds.includes(u.id));
    // tick is the template's due date when this start ticks the template (tickOf). The new checklist is due then too.
    const entry = {id: randomId(), kind: 'run', user: this.user?.id, at: start.toISOString(), items: [], files: [], template: st.template, name: st.name.trim(),
      for: (who.length ? who : [this.user]).map(u => ({id: u.id, username: u.username, name: u.name || ''})), steps, tick: this.tickOf(st.template), fails: 0};
    st.busy = true;
    this.starting = {id: entry.id, done: 0, total: 6 + steps.length * 3};
    const {kept, full} = await sync.add(entry, []);
    const r = await sync.lock(() => this.sendEntry(entry.id));
    this.starting = null; st.busy = false;
    this.refreshPending();
    if (r.status === 'sent' || r.status === 'gone') {
      this.closeSheet(true);
      if (r.runId) this.openRun(r.runId);
      // Keep the start's Undo at the top until work begins or the screen closes. A timer would move the step card
      // while someone reads it.
      this.say('Started', {place: 'run', ms: null, action: r.runId && {label: 'Undo', fn: async () => { await this.deleteRun(r.runId); if (r.ticked) await this.untick(r.ticked); }}});
      if (this.places.run) this.places.run.startOf = r.runId; else this.toast.startOf = r.runId;
    } else if (r.status === 'offline') {
      sync.keep();
      this.closeSheet(true);
      if (this.route.name === 'checklists') this.render(); else this.go('#/checklists');
      this.say(!kept ? (full ? NO_ROOM : NOT_KEPT) : `${st.template.title} starts as soon as Pocket reaches Vikunja.`, {place: 'checklists', cls: kept ? '' : 'failed'});
    } else this.say('Not started: ' + r.error.message, {place: 'sheet:top', cls: 'failed'});
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
      return {...none, status: 'sent', runId: j.runId, title: j.title, ticked: j.ticked?.to ? {id: j.template.id, ...j.ticked} : null, changed: 1};
    } catch (error) {
      // Keep the start after connection or session loss, and allow a few retries for persistent server errors.
      if (passing(error) || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++j.fails < 5)))) {
        await save();
        return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401};
      }
      // Keep the cancelled start until its partial copies are deleted.
      error.what = 'Starting ' + j.template.title;
      j.cancelled = true; await save();
      await this.unstart(j, c, none);
      return {...none, status: 'error', error};
    }
  },
  /* Delete partial copies from a cancelled or permanently failed start, steps first. Find copies whose replies
     were lost, and keep offline cleanup queued. */
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
        this.forget(id);
      }
      await sync.remove(j.id);
      return {...none, status: 'sent', changed: 0};
    } catch (error) {
      if (passing(error) || error.status === 401 || error.status >= 500) { await sync.save(j); return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401}; }
      await sync.remove(j.id);
      error.what = 'Cleaning up a cancelled start';
      return {...none, status: 'error', error};
    }
  },
  /* Undo the template's advanced due date only if no one changed it after this start. */
  async untick({id, from, to, done}){
    try {
      const t = await api('/tasks/' + id);
      if (t.done === done && Date.parse(t.due_date) === Date.parse(to)) await patiently(() => patchTask(id, {due_date: from, done: false}));
    } catch {}
  },
  /* Find a copy made by this interrupted duplicate attempt. Match the user, attempt time, unused id, unchanged
     title and lack of subtasks or another parent. Leave copies from other people or devices alone. */
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
  /* Edit the run's optional name and assignees in its menu. runParts supports both the current name order and
     older runs with the day last. */
  async openRunOptions(){
    const run = this.view.run?.run;
    if (!run) return;
    this.openSheet('runopts');
    const p = runParts(run.title, run.created, true), name = p ? p.name : run.title;
    this.sheet.runEdit = {prefix: p ? p.template : '', day: p ? p.day : '', old: !!p?.old, name, was: name,
      forIds: (run.assignees || []).map(u => u.id), people: []};
    const edit = this.sheet.runEdit;
    try {
      const people = items(await api(`/projects/${run.project_id}/users/search`)), me = this.user;
      edit.people = [me, ...people.filter(u => u.id !== me.id).sort((a, b) => (a.name || a.username).localeCompare(b.name || b.username))];
    } catch { edit.people = [this.user]; }
  },
  async saveRunName(){
    const e = this.sheet.runEdit, run = this.view.run?.run, name = e?.name.trim();
    if (!run || !name) { if (e) e.name = e.was; return; }
    const title = !e.prefix ? name : (e.old ? [e.prefix, name, e.day] : [e.prefix, e.day, name]).join(' · ');
    if (title === run.title) return;
    try { const t = await this.saveTask(run.id, {title}); run.title = t.title; e.was = name; this.saveRun(); this.say('Renamed', {place: 'sheet:top'}); }
    catch (err) { this.say(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message, {place: 'sheet:top', cls: 'failed'}); }
  },
  // Keep at least one assignee when changing who the run is for.
  async setRunFor(u){
    const e = this.sheet.runEdit, run = this.view.run?.run;
    if (!run) return;
    const was = e.forIds, on = was.includes(u.id);
    if (on && was.length === 1) { this.say('A checklist needs at least one person. Tap someone else first.', {place: 'sheet:top', cls: 'failed'}); return; }
    e.forIds = on ? was.filter(id => id !== u.id) : [...was, u.id];
    const who = e.people.filter(x => e.forIds.includes(x.id));
    try {
      // Wait for an earlier save so changing assignees does not overwrite a new name.
      const put = shared.saveChain.then(() => api(`/tasks/${run.id}/assignees/bulk`, {method: 'PUT', body: {assignees: e.forIds.map(id => ({id}))}}));
      shared.saveChain = put.catch(() => {});
      await put;
      run.assignees = who; this.saveRun();
      this.say(this.forText({assignees: who}).replace(/^For/, 'Now for'), {place: 'sheet:top'});
    } catch (err) { e.forIds = was; this.say(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message, {place: 'sheet:top', cls: 'failed'}); }
  },
  // Delete a checklist from its ⋯ menu or its sheet. Its steps are deleted too, so none is left as a separate task.
  async confirmDeleteRun(run){
    const n = run.steps.length;
    if (!confirm(`Delete “${run.title}” and its ${n} step${n === 1 ? '' : 's'} for everyone? Their comments and photos are deleted too. This can't be undone.`)) return;
    this.closeSheet(true);
    await this.deleteRun(run.id, {deleted: true});
  },
  // Delete the run's steps before the run, and drop its pending actions.
  async deleteRun(id, {quiet = false, also = [], deleted = false} = {}){
    try {
      const t = await api('/tasks/' + id);
      for (const sid of new Set([...(t.related_tasks?.subtask || []).map(s => s.id), ...also]))
        await patiently(() => api('/tasks/' + sid, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
      await patiently(() => api('/tasks/' + id, {method: 'DELETE'}));
      this.forget(id);
      if (this.sheet.task?.id === id) Object.assign(this.sheet, {editingDesc: false, commentDraft: ''});
      if (!quiet) {
        const ids = new Set([id, ...(t.related_tasks?.subtask || []).map(s => s.id)]);
        await sync.lock(async () => { for (const e of sync.all(this.user?.id)) if (e.kind === 'act' && (e.run === id || ids.has(e.task))) await sync.remove(e.id); });
        this.refreshPending();
        this.notify(deleted ? 'Checklist deleted' : 'Checklist removed');
      }
      if (this.route.name === 'run' && this.route.id === id) this.leaveRun(); else if (!quiet) this.render();
    } catch (e) { if (!quiet) this.say('Not removed: ' + e.message, {place: ['sheet:top', 'run'], cls: 'failed'}); }
  },

  /* ---------- a run ---------- */
  // Load a checklist with each step's reactions (who did it), notes and photos.
  async loadRun(seq, id){
    const run = await allComments(await api(`/tasks/${id}?expand=comments`).catch(e => { if (e.status === 404) e.runGone = true; throw e; }));
    if (this.projects.length && !this.isRunTask(run)) throw new ApiError(404, 'This task isn\'t a started checklist. Open it from its project instead.');
    /* Wait briefly for Last time's notes before showing the steps, or use cached notes. Notes that arrive later would
       push the steps down while the user is touching the screen, so lateLast keeps them off the current card. */
    const kept = this.view.run?.run.id === id ? this.view.run : null;
    const reading = kept?.last ? null : this.readLast(plainRun(run));
    const steps = await inBatches(stepsOf(run), 4, async s => allComments(await api(`/tasks/${s.id}?expand=reactions&expand=comments`)));
    const last = reading && await Promise.race([reading, new Promise(ok => setTimeout(() => ok(undefined), LAST_WAIT))]);
    if (seq !== renderSeq) return;
    for (const t of [run, ...steps]) cache.set(t.id, t);
    const keep = this.view.run?.run.id === id ? this.view.run : null;      // reloading the open checklist keeps its step and drafts
    if (!keep) { this.runInsert = newBox(); this.runBoxAt = null; }
    const asked = keep ? -1 : steps.findIndex(s => s.id === this.route.step);   // index of the step opened from a list
    const before = last === undefined ? saved.get('run.' + id)?.run?.last : null;
    this.runNow = Date.now();                                                // compute the newly opened run for the current time
    this.view.run = {run: plainRun(run), steps: steps.map(plainStep), at: keep ? keep.at : asked >= 0 ? asked : null,
      last: keep?.last || last || (before?.notes ? {...before, held: null} : null)};
    this.saveRun();
    if (last === undefined) reading.then(l => this.lateLast(id, l));
  },
  // Save the open checklist so it opens offline. Pocket keeps the last 8 checklists opened.
  saveRun(){
    const r = this.view.run;
    if (!r) return;
    const ids = [r.run.id, ...(saved.get('runs.recent') || []).filter(id => id !== r.run.id)];
    for (const id of ids.slice(8)) store.del('saved.run.' + id);
    saved.set('runs.recent', ids.slice(0, 8));
    saved.set('run.' + r.run.id, {run: r, at: new Date().toISOString()});
  },
  /* Load notes from the last finished checklist of this template, including step notes. Return {id, title, notes},
     or null when there is no readable checklist. */
  async readLast(run){
    if (!run.from) return null;
    try {
      const prev = ((await api('/tasks/' + run.from)).related_tasks?.copiedto || []).filter(x => x.id !== run.id && x.done)
        .sort((a, b) => new Date(b.done_at) - new Date(a.done_at))[0];
      if (!prev) return null;
      const full = await allComments(await api(`/tasks/${prev.id}?expand=comments`));
      const steps = await inBatches(stepsOf(full), 4, async s => allComments(await api(`/tasks/${s.id}?expand=comments`)));
      // Each note keeps the template step it was on (tpl), so it shows on that step's card in this checklist.
      const notes = [...(full.comments || []).map(c => ({...noteOf(c), step: 'The checklist', tpl: null})),
        ...steps.flatMap(s => (s.comments || []).map(c => ({...noteOf(c), step: parseStep(s.title).title + (addedText(s.description) ? ` (${addedText(s.description).toLowerCase()})` : ''),
          tpl: addedText(s.description) ? null : plainStep(s).tpl})))];
      return {id: prev.id, title: prev.title, notes};
    } catch { return null; }
  },
  /* Show late notes below the steps immediately, but hold card notes until another step is selected so the list
     stays still. */
  lateLast(id, last){
    const r = this.view.run;
    if (r?.run.id !== id || !last) return;
    const same = r.last && JSON.stringify(r.last.notes.map(n => n.id)) === JSON.stringify(last.notes.map(n => n.id)) && r.last.id === last.id;
    r.last = same ? {...last, held: r.last.held} : {...last, held: this.runView?.step?.id ?? null};
    this.saveRun();
  },
  /* Apply pending changes to the visible run so ticks, skips and notes show immediately. Memoize once per input
     change, read runNow only when time changes visible text, and reuse unchanged step objects. */
  get runView(){ return (this.runMemo ||= memo(function(){ return this.workOutRun(); })).call(this); },
  // Keep one row-options object so selecting a card step changes only `at`. Read it through raw to avoid making
  // these writes trigger another computation.
  get runRows(){
    const v = this.runView, g = raw(this.runG);
    if (!v) return this.runG;
    const locked = v.finished || !this.canWrite(this.view.run.run.project_id);
    if (g.at !== v.at) this.runG.at = v.at;
    if (g.locked !== locked) this.runG.locked = locked;
    return this.runG;
  },
  workOutRun(){
    const r = this.view.run;
    if (!r) return null;
    const me = this.user, myName = me?.name || me?.username || 'You';
    const acts = this.pending.filter(e => e.kind === 'act' && e.run === r.run.id);
    const waitingNote = a => ({id: a.id, comment: commentShown(a.html), author: myName, when: 'Waiting to send'});
    // Place pending inserted or repeated steps before their original successor, or after their predecessor if that
    // successor is gone. Omit cancelled steps.
    const base = [...r.steps];
    for (const e of this.pending) if (e.kind === 'step' && !e.cancelled && e.run === r.run.id && !base.some(s => s.id === e.taskId)) {
      const k = base.findIndex(s => s.id === e.before), a = k < 0 ? base.findIndex(s => s.id === e.after) : -1;
      base.splice(k >= 0 ? k : a >= 0 ? a + 1 : base.length, 0, {id: 'pending-' + e.id, title: e.title, done: false, done_at: null, due_date: ZERO, updated: e.at, description: '',
        assignees: [], attachments: [], reactions: {}, comments: [], tpl: e.tpl ?? null, from: e.from, added: e.from || e.tpl != null ? 'Repeated' : 'Inserted', pending: e.id});
    }
    const steps = base.map((s, i) => {
      const skipper = skippedBy(s);
      // waiting includes unsent ticks, skips and unticks. slow marks those that have waited long enough to look
      // pending.
      let done = s.done, skipped = !!skipper, waiting = false, slow = false, doneAt = s.done_at, pct = Math.round((s.percent_done || 0) * 100);
      const kept = keptTicks()[s.id];
      // Compare whole seconds because tick replies include nanoseconds but later task reads do not.
      if (done && kept && Math.floor(Date.parse(kept.there) / 1000) === Math.floor(Date.parse(s.done_at) / 1000)) doneAt = kept.here;
      let by = skipped ? [skipper] : s.reactions?.[DONE_MARK] || [];
      const doers = () => by.map(u => u.name || u.username);
      const notes = (s.comments || []).map(noteOf);
      for (const a of acts) if (this.actTask(a) === s.id) {
        if (a.op === 'note' || a.op === 'skip' || a.op === 'doneNote' || a.op === 'answer') notes.push(waitingNote(a));
        if (a.op === 'progress') { pct = a.pct; continue; }
        if (a.op === 'note' || a.op === 'answer' || a.op === 'claim' || a.op === 'unclaim') continue;
        waiting = true; slow = this.slow.includes(a.id); done = a.op !== 'undone'; skipped = a.op === 'skip'; doneAt = a.at; by = me ? [me] : [];
      }
      // The step's row shows the latest comment's first line. Answers to its asks show on the row already.
      const talk = [...(s.comments || []).filter(c => !isAnswer(c.comment)).map(noteOf), ...acts.filter(a => this.actTask(a) === s.id && ['note', 'skip', 'doneNote'].includes(a.op)).map(waitingNote)].at(-1);
      const said = talk ? {who: talk.author, text: htmlToText(talk.comment || '').split('\n').map(l => l.trim()).find(Boolean) || ''} : null;
      const people = s.pending ? [] : this.peopleOf(s.id, s.assignees);
      const slot = done ? this.doneSlot(by, people, slow ? 'wait' : skipped ? 'skip' : 'done')
        : s.pending ? null : this.claimSlot({...s, project_id: r.run.project_id}, people, r.run.done, r.run.id);
      // Show who completed or skipped the step, with their picture and reaction badge.
      const at = doneAt && isSet(doneAt) ? ' at ' + (+startOfDay(new Date(doneAt)) === +startOfDay() ? fmtTime(new Date(doneAt))
        : new Date(doneAt).toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'})) : '';
      return {id: s.id, i, title: parseStep(s.title).title, description: notesOnly(s.description), ...stepAnswers(s, acts.filter(a => a.op === 'answer' && this.actTask(a) === s.id), me), attachments: s.attachments, done, skipped, waiting, slow, notes, said, doneAt, slot, by, pct,
        added: s.added || '', pending: s.pending || null, slowAdd: !!s.pending && this.slow.includes(s.pending), from: s.from || null, tpl: s.tpl,
        whoText: !done ? '' : (skipped ? 'Skipped' : 'Done') + (slow ? ' · waiting to send' : (by.length ? ' by ' + andList(doers()) : '') + at)};
    });
    /* Time template steps from the completion of the step they depend on, using local times for pending ticks.
       Honor a due date edited after that completion, but ignore dates the plugin sets without changing updated.
       Compare whole seconds because offline actions can reach Vikunja within the same second. Inserted steps have
       no template timing. Repeated steps stand in for their originals, and dependents count from the latest
       completion. */
    const group = [], timing = [], place = [], now = serverTime(this.runNow);
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
      s.countText = s.counting ? countText(left) : '';
      s.dueText = waitsOn ? 'Due ' + waitsOn : s.counting ? (left >= 0 ? 'Due ' : '') + s.countText : due ? 'Due ' + dueInfo(due.toISOString()).label : '';
    });
    // Choose the next open or due step unless a step was selected manually. Reuse each unchanged step object.
    steps.forEach((s, i) => { const all = JSON.stringify(s), was = lastSteps.get(s.id); if (was?.all === all) steps[i] = was.step; else lastSteps.set(s.id, {all, step: s}); });
    if (lastSteps.size > steps.length) { const ids = new Set(steps.map(s => s.id)); for (const id of lastSteps.keys()) if (!ids.has(id)) lastSteps.delete(id); }
    const total = steps.length, doneCount = steps.filter(s => s.done).length, next = whereNext(steps, now);
    const allDone = total > 0 && doneCount === total, at = r.at ?? (next >= 0 ? next : total - 1);
    // doneCount includes skipped steps, so a checklist with skips can finish. didCount leaves them out, for the summary.
    const skippedN = steps.filter(s => s.skipped).length, lateN = steps.filter(s => s.done && s.late).length, didCount = doneCount - skippedN;
    // Show who started the run in its summary and menu. The top row's slot shows who the run is for.
    const started = startedText(this.runStarter(r.run), r.run.created, {now: new Date(now)});
    const finished = (acts.filter(a => a.op === 'finish' || a.op === 'reopen').pop()?.op ?? (r.run.done ? 'finish' : '')) === 'finish';
    // Show the finish card when the run is finished or every step is done. Tapping a listed step can still open
    // its card.
    const step = (allDone || finished) && r.at === null ? null : steps[at] || null;
    return {steps, total, doneCount, didCount, skippedN, allDone, at, step, finished, timers: steps.filter(s => s.counting && s !== step).sort((a, b) => a.dueAt - b.dueAt),
      summary: [started, `${didCount} of ${total} done`, skippedN && `${skippedN} skipped`, total - doneCount && `${total - doneCount} not done`, lateN && `${lateN} done late`].filter(Boolean).join(' · '),
      notes: [...(r.run.comments || []).map(noteOf), ...acts.filter(a => a.op === 'note' && a.task === r.run.id).map(waitingNote)],
      ring: {...workedOut(steps.map(s => ({done: s.done, pct: s.pct}))), run: true}};
  },
  // Who started a checklist: "you" or their name. Null when Vikunja doesn't report it.
  runStarter(run){ const by = run?.created_by; return by ? (by.id === this.user?.id ? 'you' : by.name || by.username) : null; },
  // Show the starter and date at the top of the run's menu.
  get runStarted(){ const run = this.view.run?.run; return run ? startedText(this.runStarter(run), run.created, {day: true}) : ''; },
  /* Build the run's top row with its name, assignees and ring, including pending ticks. Its ring or full right
     swipe finishes the run, asking first if steps remain open. A finished run reopens instead. */
  // Include a pending finish in the top row's done state, once the screen has loaded.
  get runOwn(){
    const run = this.view.run?.run, v = this.route.name === 'run' && !this.view.loading && !this.view.error && this.runView;
    return v && run ? {...run, done: v.finished} : null;
  },
  get runRing(){
    const v = this.runView, run = this.view.run?.run;
    if (!v || !run || !v.total) return null;
    const open = v.total - v.ring.done, title = `“${run.title}”`, n = open === 1 ? '1 step' : open + ' steps';
    return {...v.ring, open, said: `${v.ring.done} of ${v.total} ${v.total === 1 ? 'step' : 'steps'} done, ${v.ring.pct}%`, tap: () => this.runRingTap(),
      label: v.finished ? 'Reopen ' + run.title : !open ? `Finish ${title}: all its steps are done` : `Finish ${title}, with ${n} not done`};
  },
  runRingTap(){
    const run = this.view.run?.run, v = this.runView;
    if (!run || !v || !this.canWrite(run.project_id)) return;
    if (v.finished) return this.reopenRun(run.id);
    if (v.allDone) return this.finishRun();
    const open = v.steps.filter(s => !s.done).map(s => s.title), title = runWithoutDay(run.title, run.created);
    this.openSheet('complete');
    this.sheet.complete = {id: run.id, task: run, run: true, screen: true, back: false, title, open, n: open.length, stay: 0, ask: completeAsk({title, run: true, names: open})};
  },
  // The notes made on this step in the last finished checklist of the same template.
  lastNotes(s){ const l = this.view.run?.last; return s?.tpl && s.id !== l?.held ? (l?.notes || []).filter(n => n.tpl === s.tpl) : []; },
  /* Open a run on its own screen, selecting the requested step if given. Back returns to the screen that opened
     it. */
  openRun(id, step = null){
    this.closeSheet(true);
    this.go('#/run/' + id + (step ? '?step=' + step : ''));
  },
  leaveRun(){ this.back(this.runFrom || '#/checklists'); },
  // Leave a deleted run's screen and remove its offline copy.
  runGone(id){
    store.del('saved.run.' + id); saved.set('runs.recent', (saved.get('runs.recent') || []).filter(x => x !== id));
    if (this.view.run?.run.id === id) this.view.run = null;
    this.leaveRun();
    this.notify('That checklist no longer exists.');
  },
  // Where Back goes, by name: from a run, the screen before it; from a project, the list it was opened from.
  get backName(){
    if (this.route.name === 'run') return {today: 'Today', project: 'the project', search: 'search'}[routeOf(this.runFrom || '').name] || 'checklists';
    return {today: 'Today', search: 'search', checklists: 'checklists'}[routeOf(this.projectFrom || '').name] || 'projects';
  },
  // A checklist run, done or not.
  isRunTask(t){ return this.role(t) === 'run'; },
  // Allow changes unless the project is known to be shared read-only.
  canWrite(pid){ const v = this.perms[pid]; return v === undefined || v === null || v >= 1; },
  /* A template and its steps can be changed only by the person who made the template or a project admin. Vikunja
     lets anyone with write change them, so this guards against slips in Pocket only. */
  get canEdit(){
    const t = this.sheet.task, role = this.checklistRole;
    if (!t || !this.canWrite(t.project_id)) return false;
    return !['template', 'tplstep'].includes(role) || this.ownsTemplate(role === 'tplstep' ? this.parentTask : t);
  },
  // The line in a template's checklist card: what starting does, and what the user can do with the template.
  get templateNote(){
    const t = this.sheet.task;
    if (t && !this.canWrite(t.project_id)) return 'Read only. You can see this template, but not start a checklist from it. Ask the project\'s owner for write access.';
    return 'Every checklist you start from this template copies these steps. ' + (this.canEdit ? 'Tap to edit. Hold to reorder. Swipe left to delete.' : 'Only the person who made this template or a project admin can change it.');
  },
  // Whether the user made template `t`, or is an admin of its project. Unknown access counts as admin, as it counts
  // as write in canWrite, until the project's access has loaded.
  ownsTemplate(t){
    const full = t && (this.tasks[t.id] || cache.get(t.id) || t), p = full && this.perms[full.project_id];
    return !!full && (p == null || p >= 2 || full.created_by?.id === this.user?.id);
  },
  /* Load project permissions in small background batches because Vikunja's project list omits them. Cache each
     result, or reload all with force. */
  async loadPerms(force = false){
    const todo = this.projects.filter(p => p.id > 0 && (force || !(p.id in this.perms)));
    if (!todo.length) return;
    try {
      await inBatches(todo, 4, async p => { const full = await api('/projects/' + p.id); this.perms[p.id] = full.max_permission ?? 1; });
      saved.set('perms', this.perms);
    } catch {}
  },
  // The run a task is a step of, or null.
  stepRun(t){ return this.role(t) === 'step' ? t.related_tasks.parenttask[0].id : null; },
  // A list row has a tick unless it is a template. A checklist has one only in its project's own list.
  canTick(t){
    if (!this.canWrite(t.project_id)) return false;
    const role = this.role(t);
    return role !== 'template' && (role !== 'run' || this.route.name === 'project');
  },
  // A step as done or not, counting ticks still waiting to be sent (keyWaiting).
  stepDone(id, done){ return this.waiting.ticks[id] ?? done; },
  // A step's progress, counting progress still waiting to be sent (keyWaiting).
  stepPct(s){ return this.waiting.pcts[s.id] ?? pctOf(s); },
  // Compute a parent's progress from its subtasks or run steps. Use stored progress for other tasks.
  shownPct(t){
    const r = this.ringOf(t);
    return r ? r.pct : t.done ? 100 : pctOf(t);
  },
  /* Use square ticks for run steps wherever they appear. Steps go through the run's outbox and record who
     completed them, so they must look different from ordinary tasks. */
  isStepRow(t, g){ return !!g.run || (g.sheet ? this.checklistRole === 'run' : this.role(t) === 'step'); },
  goProject(id){ this.closeSheet(true); this.go('#/project/' + id); },
  // Open a checklist or one of its steps on the checklist screen, an open template in Start, and other tasks in a sheet.
  openRow(t){
    if (this.isRunTask(t)) return this.openRun(t.id);
    if (this.role(t) === 'template' && comesRound(t)) return this.openStart(t.id);
    const run = this.stepRun(t);
    if (run) return this.openRun(run, t.id);
    this.openTask(t.id);
  },
  showStep(i, scroll){
    if (!this.view.run) return;
    this.view.run.at = i;
    if (this.view.run.last) this.view.run.last.held = null;                // Last time's notes now show on the step's card
    if (scroll) scrollTo({top: 0, behavior: motion() ? 'smooth' : 'auto'});
  },
  // Complete, skip or reopen the step, then advance the card. Return false if confirmation was declined. Give tap
  // feedback unless a swipe already gave it.
  async tickStep(s, op, felt = false){
    const r = this.view.run;
    if (!r) return;
    const current = this.runView?.step?.id === s.id;
    let html = '';
    // Send this step's draft as a Skip reason or a Done note. Each step keeps its own draft.
    if (op !== 'undone') this.unlockSound();
    // Vikunja lets each person remove only their own ✅, so another person's ✅ stays.
    const others = op === 'undone' ? (s.by || []).filter(u => u.id !== this.user?.id).map(u => this.nameOf(u)) : [];
    if (others.length && !confirm(`${others.join(' and ')} marked “${s.title}” done. Only they can remove their ✅ in Vikunja, so it stays. Mark the step not done anyway?`)) return false;
    const typed = op === 'undone' ? '' : (this.runDrafts[s.id] || '').trim();
    if (typed) this.runDrafts[s.id] = '';
    // Done also sends what is typed or picked in the step's fields, as its own comment, before the tick.
    const answers = op === 'done' ? this.takeAnswers(s) : '';
    if (op === 'skip') html = textToHtml('Skipped' + (typed ? ': ' + typed : ''));
    if (op === 'done' && typed) { op = 'doneNote'; html = textToHtml(typed); }
    if (current && op !== 'undone') { r.at = this.nextStep(s); if (r.last) r.last.held = null; }
    if (!felt) haptic(tickFeel(op === 'undone'));
    if (answers) await this.act({op: 'answer', task: s.id, html: answers});
    await this.act({op, task: s.id, html});
  },
  /* Advance to the next open step, or an earlier timed step that is due, wrapping to the first open step. Return
     null when only the completed step remained. */
  nextStep(s){
    const i = this.runView ? whereNext(this.runView.steps, serverTime(this.clock), s) : -1;
    return i < 0 ? null : i;
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
    // Show the message as a toast, because the previous screen that Back returns to has no place for it.
    this.notify(r.status === 'offline' ? sentLater('Finished') : 'Finished ' + run.title, {label: 'Undo', fn: () => this.reopenRun(run.id)});
    this.leaveRun();
  },
  // Reopen a finished checklist. Called from Undo after finishing, or from Reopen in the checklist's ⋯ menu.
  async reopenRun(id){
    this.closeSheet(true);
    const r = await this.act({op: 'reopen', task: id, run: id});
    if (r.status === 'error') return;
    if (this.route.name === 'run' && this.route.id === id) this.render(); else this.openRun(id);
  },

  /* ---------- steps added during a run ---------- */
  /* Insert or repeat a step through the outbox. Show it in place and allow ticks while it waits offline. */
  /* Describe where the run's add box inserts steps. Return the step above the box, which Repeat copies, plus the
     predecessor and successor at the box's position. Above a box at the bottom is the last step. Hide the box on
     finished or read-only runs. */
  get runAim(){
    const r = this.view.run, v = this.runView;
    if (!v || v.finished || !v.steps.length || !this.canWrite(r.run.project_id)) return null;
    const same = x => String(this.actTask({task: x}));
    const above = (this.runBoxAt != null && v.steps.find(s => same(s.id) === same(this.runBoxAt))) || v.steps[v.total - 1];
    return {above, after: above.id, before: v.steps[above.i + 1]?.id ?? null};
  },
  /* Queue each step in list order between after and before. With follow, move the box under the last queued step
     before sending, so the next entry follows it. Return the entry ids. */
  async addSteps(list, {after, before, follow = false}){
    if (!list.length) return [];
    const ids = list.map(f => f.id || randomId());
    if (follow && this.runBoxAt != null) { this.runBoxAt = 'pending-' + ids.at(-1); this.seatFoot('run'); }
    for (const [i, f] of list.entries()) { await this.addStep({...f, id: ids[i], before, after}); after = 'pending-' + ids[i]; }
    return ids;
  },
  // Parse each line as a step with assignees, labels and priority. Step dates come from template timing.
  async insertStep(){
    const lines = this.boxParsedLines('ins').filter(p => p.title);
    const a = this.runAim;
    if (!lines.length || !a) return;
    this.runInsert = {...newBox(), focus: this.runInsert.focus};
    await this.addSteps(lines.map(p => ({title: p.title, p: packParsed(p)})), {after: a.after, before: a.before, follow: true});
  },
  /* Repeat the step above the add box, whichever step is on the card. The copy goes right after that step, and the
     box stays where it is, with Undo beside it. A pending step has no saved task to copy yet. */
  async repeatAbove(){
    const s = this.runAim?.above;
    if (!s || s.pending) return;
    const id = randomId();
    this.say(`Repeated “${s.title}”`, {place: 'cap', action: {label: 'Undo', fn: () => this.undoAdded(id, s.title)}});
    await this.repeatStep(s, id);
  },
  // Add a copy of step `s` right after it, as entry `id`. A step from a template is copied from that template step. An
  // inserted step is copied from its title.
  async repeatStep(s, id){ await this.addSteps([{title: s.title, from: s.from, tpl: s.tpl ?? null, id}], {after: s.id, before: this.runView.steps[s.i + 1]?.id ?? null}); },
  // Undo a step just added. Cancel it if it is still waiting to be sent, otherwise delete it.
  async undoAdded(id, title){
    if (await this.dropStep(id, true)) {
      const tid = sync.taskOf(id);
      if (tid) await this.deleteAddedStep(this.runView?.steps.find(x => x.id === tid) || {id: tid, title, added: 'Repeated', done: false}, true);
    }
    this.said = `Not repeated: ${title}`;
  },
  /* Queue step progress like a tick. At 100%, mark it done with its completion reaction. Reopen a done step before
     lowering its progress. undoing restores the previous progress. */
  async stepProgress(s, pct, undoing = false){
    if (s.done && pct < 100 && !undoing && await this.tickStep(s, 'undone', true) === false) return;
    if (pct >= 100 && !undoing) { await this.tickStep(s, 'done', true); this.said = `Done: ${s.title}`; return; }   // a swipe leaves no focused box to announce it
    // Below 100%, show progress on the tick so a reverse swipe can undo it without a message covering the row.
    const r = await this.act({op: 'progress', task: s.id, pct});
    if (r.status !== 'error' && !undoing) this.said = `Progress of ${s.title} set to ${pct}%`;
  },
  async addStep(fields){
    const r = this.view.run;
    if (!r) return;
    // If the step to insert before is itself waiting to be sent, use the step that one goes before.
    if (typeof fields.before === 'string') fields.before = this.pending.find(e => 'pending-' + e.id === fields.before)?.before ?? null;
    const entry = {id: randomId(), kind: 'step', user: this.user?.id, at: new Date().toISOString(), n: nextN(), items: [], files: [], fails: 0,
      run: r.run.id, runTitle: r.run.title, project: r.run.project_id, from: null, tpl: null, ...fields};
    const {kept, full} = await sync.add(entry, []);
    this.refreshPending();
    const res = await sync.lock(() => this.sendEntry(entry.id));
    this.refreshPending();
    // Show errors beside the box the step was added from.
    if (res.status === 'offline') { sync.keep(); if (!kept) this.say(full ? NO_ROOM : NOT_KEPT, {place: ['cap', 'step'], cls: 'failed'}); }
    if (res.status === 'error') this.say(`${res.error.what} couldn't be done: ${res.error.message}.`, {place: ['cap', 'step'], cls: 'failed'});
    if (res.status === 'sent' && this.view.run?.run.id === entry.run) this.render();
    return entry.id;
  },
  async sendStep(j){
    const save = () => sync.save(j), c = {save, taken: new Set()}, none = {ids: [], tasks: [], problems: [], uploaded: 0};
    if (j.cancelled) return this.unsendStep(j, c, none);
    try {
      for (const step of INSERT_STEPS) while (!step.done(j)) { await patiently(() => step.run(j, c)); await save(); }
      await sync.remove(j.id);
      return {...none, status: 'sent', changed: 1};
    } catch (error) {
      if (passing(error) || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++j.fails < 5)))) {
        await save();
        return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401};
      }
      // Delete any partial copy after permanent rejection, including a step that was created but never attached to
      // the run.
      const made = j.taskId || j.job?.taskId;
      if (made) await api('/tasks/' + made, {method: 'DELETE'}).catch(() => {});
      await sync.remove(j.id);
      error.what = (j.from || j.tpl != null ? 'Repeating' : 'Inserting') + ` “${j.title}”`;
      return {...none, status: 'error', error};
    }
  },
  // Ask whether to delete a step added during a checklist. Used by the step's × and its row's Delete.
  askDeleteStep(s){ return !!s?.added && !s.done && confirm(`Delete “${s.title}”? This step was added to this checklist only. The template doesn't change.`); },
  /* Delete an open inserted or repeated step and its pending actions. Template steps must be skipped instead. undo
     skips confirmation and messages for Repeat's Undo, and asked records confirmation before a swipe. Return
     whether the step was removed. */
  async deleteAddedStep(s, undo = false, asked = false){
    if (!s?.added || s.done || (!undo && !asked && !this.askDeleteStep(s))) return false;
    if (s.pending) { await this.dropStep(s.pending, undo); return true; }
    const run = this.view.run?.run.id;
    try {
      await patiently(() => api('/tasks/' + s.id, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
      cache.delete(s.id);
      if (run) this.writeFigure(run).catch(() => {});                      // recompute the checklist's stored progress without this step
      await sync.lock(async () => { for (const e of sync.all(this.user?.id)) if (e.kind === 'act' && e.task === s.id) await sync.remove(e.id); });
      this.refreshPending();
      if (!undo) this.say('Step deleted', {place: ['sheet:top', 'step']});
      this.render();
      return true;
    } catch (e) { this.say(e instanceof NetError ? 'Deleting a step needs a connection.' : 'Not deleted: ' + e.message, {place: ['sheet:top', 'step'], cls: 'failed'}); return false; }
  },
  /* Cancel a pending step and its actions. If creation may have reached Vikunja, keep cleanup queued until the
     copy can be found and deleted. quiet suppresses the Undo message. Return whether insertion had already
     finished. */
  async dropStep(id, quiet = false){
    let tried = false, gone = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) { gone = true; return; }
      tried = !!(e.taskId || e.tried || e.job?.tried);
      if (tried) await sync.save({...e, cancelled: true}); else await sync.remove(id);
      for (const a of sync.all(this.user?.id)) if (a.kind === 'act' && a.task === 'pending-' + id) await sync.remove(a.id);
    });
    if (tried) await sync.lock(() => this.sendEntry(id));
    this.refreshPending();
    if (!quiet) this.say(gone ? 'It was already sent. Delete it from the checklist if you don\'t need it.'
      : tried && this.pending.some(e => e.id === id) ? 'Not inserted. Pocket removes the part that reached Vikunja once it is back online.' : 'Not sent.', {place: ['sheet:top', 'step']});
    if (this.route.name === 'run') this.render();
    return gone;
  },
  // Delete a cancelled step that may have reached Vikunja. Find it first if its id is unknown.
  async unsendStep(j, c, none){
    try {
      let id = j.taskId || j.job?.taskId || null;
      if (!id && j.from && j.tried) id = (await this.findCopy(j.from, j, j.at, c.taken, j.id, j.run))?.id ?? null;
      if (!id && j.job?.tried && j.job.body) id = (await this.findSent(j.job.body.title, j.job.to, j.job.triedAt, j.at, new Set(), j.job.key))?.id ?? null;
      if (id) await patiently(() => api('/tasks/' + id, {method: 'DELETE'})).catch(e => { if (e.status !== 404) throw e; });
      await sync.remove(j.id);
      return {...none, status: 'sent', changed: 0};
    } catch (error) {
      if (passing(error) || error.status === 401 || error.status >= 500) { await sync.save(j); return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401}; }
      await sync.remove(j.id);
      error.what = `Removing “${j.title}”`;
      return {...none, status: 'error', error};
    }
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
