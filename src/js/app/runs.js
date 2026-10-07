// Starting a run, and working through one.
import {andList, cache, store, taskDrafts, ZERO} from '../util.js';
import {allPages, api, ApiError, errText, items, NetError, passing, patchTask, serverTime, triedSince} from '../api.js';
import {addDays, dueInfo, fmtTime, isSet, startOfDay} from '../dates.js';
import {pctOf} from '../progress.js';
import {htmlToText, textToHtml} from '../html.js';
import {addedText, allComments, comesRound, DONE_MARK, durText, hasTemplateLabel, inBatches, isRunDesc, isRunStepTask, isTemplate, nextAfter, noteOf, notesOnly, parseStep, patiently, plainRun, plainStep, problemText, SKIP_MARK, skippedBy, stepFrom, stepProblems, stepsOf, templateName, vikunjaNext} from '../checklists.js';
import {routeOf} from '../routing.js';
import {ACT_STEPS, ACTS, heldTasks, INSERT_STEPS, KEPT, NO_ROOM, NOT_KEPT, packParsed, randomId, RUN_STEPS, runProgress, sync} from '../sync.js';
import {saved} from '../lists.js';
import {newBox, shared} from './core.js';
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
    Object.assign(this.sheet, {loading: true, start: {template: null, steps: [], people: [], forIds: [this.user?.id], busy: false, name: '', next: 1}});
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
      // For the template's assignees, to start with, if it has any (and they can tick a step); else for you.
      const forIds = (t.assignees || []).map(u => u.id).filter(id => people.some(u => u.id === id));
      Object.assign(this.sheet.start, {template: {id: t.id, title: templateName(t.title), project_id: t.project_id, labels: t.labels, done: t.done,
        due_date: t.due_date, repeat_after: t.repeat_after, repeat_mode: t.repeat_mode}, steps: stepsOf(t), people, forIds: forIds.length ? forIds : [me.id],
        next: (t.related_tasks?.copiedto || []).length + 1, who: {}});
      // Who each step is for: Vikunja leaves a task's subtasks' assignees out, so they're asked for (not offline).
      const ids = stepsOf(t).map(s => s.id);
      if (ids.length) allPages('/tasks?' + new URLSearchParams({filter: `id in ${ids.join(', ')}`})).then(list => {
        if (this.sheet !== mine) return;
        this.sheet.start.who = Object.fromEntries(list.map(s => [s.id, andList((s.assignees || []).map(u => u.id === me.id ? 'you' : u.name || u.username))]));
      }, () => {});
    } catch (e) { if (this.sheet === mine) this.sheet.error = errText(e); }
    finally { if (this.sheet === mine) this.sheet.loading = false; }
  },
  // Who a run is for: any number of people, at least one.
  toggleFor(st, u){
    const on = st.forIds.includes(u.id);
    if (on && st.forIds.length === 1) { this.notify('A run is for at least one person: tap someone else first.'); return; }
    st.forIds = on ? st.forIds.filter(id => id !== u.id) : [...st.forIds, u.id];
  },
  /* The due date a start ticks: a template that comes round and is due by the end of today. Started at 7:55, it's the
     8:00 one, so the 8:00 doesn't make a second run. Null for any other. */
  tickOf(tpl){ return comesRound(tpl) && new Date(tpl.due_date) < addDays(startOfDay(), 1) ? tpl.due_date : null; },
  // Under For in the Start sheet: what starting does to a template that comes round.
  get startNote(){
    const t = this.sheet.start?.template;
    if (!t || !comesRound(t)) return '';
    const due = new Date(t.due_date), today = +startOfDay(due) === +startOfDay();
    const at = d => d.toLocaleString([], {weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
    if (!this.tickOf(t)) return `${t.title} is next due ${at(due)}: this run doesn't move it on.`;
    const one = today ? `the ${due.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})} one` : `the one due ${at(due)}`;
    const next = vikunjaNext(t);
    if (next === null) return `This is ${one}: starting it marks ${t.title} done, and it doesn't come round again.`;
    return `This is ${one}: starting it moves ${t.title} on to ${at(new Date(nextAfter(t, next)))}.`;
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
    const who = st.people.filter(u => st.forIds.includes(u.id));
    // tick: the template's due date, if this start ticks it (tickOf); the run is due then too.
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
      this.notify('Started ' + (r.title || st.template.title), r.runId && {label: 'Undo', fn: async () => { await this.deleteRun(r.runId); if (r.ticked) await this.untick(r.ticked); }});
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
      return {...none, status: 'sent', runId: j.runId, title: j.title, ticked: j.ticked?.to ? {id: j.template.id, ...j.ticked} : null, changed: 1};
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
  /* A start undone: the template it ticked back at the time it was due, unless it's been changed since (started again,
     say). */
  async untick({id, from, to, done}){
    try {
      const t = await api('/tasks/' + id);
      if (t.done === done && Date.parse(t.due_date) === Date.parse(to)) await patiently(() => patchTask(id, {due_date: from, done: false}));
    } catch {}
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
      forIds: (run.assignees || []).map(u => u.id), people: []};
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
  // Someone added to or taken off who the run is for: at least one stays.
  async setRunFor(u){
    const e = this.sheet.runEdit, run = this.view.run?.run;
    if (!run) return;
    const was = e.forIds, on = was.includes(u.id);
    if (on && was.length === 1) { this.notify('A run is for at least one person: tap someone else first.'); return; }
    e.forIds = on ? was.filter(id => id !== u.id) : [...was, u.id];
    const who = e.people.filter(x => e.forIds.includes(x.id));
    try {
      // After any save still going (a new name, say), so Vikunja doesn't save over it with the old assignees.
      const put = shared.saveChain.then(() => api(`/tasks/${run.id}/assignees/bulk`, {method: 'PUT', body: {assignees: e.forIds.map(id => ({id}))}}));
      shared.saveChain = put.catch(() => {});
      await put;
      run.assignees = who; this.saveRun();
      this.notify(this.forText({assignees: who}).replace(/^For/, 'Now for'));
    } catch (err) { e.forIds = was; this.notify(err instanceof NetError ? 'Offline — not saved' : 'Not saved: ' + err.message); }
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
    if (!keep) this.runInsert = {...newBox(), repeat: null, after: null};
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
      // Each with the template step it was on (tpl), so it shows on that step's card this time too.
      const notes = [...(full.comments || []).map(c => ({...noteOf(c), step: 'The run', tpl: null})),
        ...steps.flatMap(s => (s.comments || []).map(c => ({...noteOf(c), step: parseStep(s.title).title + (addedText(s.description) ? ` (${addedText(s.description).toLowerCase()})` : ''),
          tpl: addedText(s.description) ? null : plainStep(s).tpl})))];
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
    // Steps inserted or repeated that are still waiting to be sent, in their place: before the step they were inserted at,
    // or after the one they were inserted under if that one's gone. Not one called off.
    const base = [...r.steps];
    for (const e of this.pending) if (e.kind === 'step' && !e.cancelled && e.run === r.run.id && !base.some(s => s.id === e.taskId)) {
      const k = base.findIndex(s => s.id === e.before), a = k < 0 ? base.findIndex(s => s.id === e.after) : -1;
      base.splice(k >= 0 ? k : a >= 0 ? a + 1 : base.length, 0, {id: 'pending-' + e.id, title: e.title, done: false, done_at: null, due_date: ZERO, updated: e.at, description: '',
        assignees: [], attachments: [], reactions: {}, comments: [], tpl: e.tpl ?? null, from: e.from, added: e.from || e.tpl != null ? 'Repeated' : 'Inserted', pending: e.id});
    }
    const steps = base.map((s, i) => {
      const skipper = skippedBy(s);
      let done = s.done, skipped = !!skipper, waiting = false, doneAt = s.done_at, pct = Math.round((s.percent_done || 0) * 100);
      const kept = keptTicks()[s.id];
      // To the second: Vikunja's reply to the tick has its done time to the nanosecond, its copy since then whole seconds.
      if (done && kept && Math.floor(Date.parse(kept.there) / 1000) === Math.floor(Date.parse(s.done_at) / 1000)) doneAt = kept.here;
      let by = skipped ? [skipper] : s.reactions?.[DONE_MARK] || [];
      const doers = () => by.map(u => u.name || u.username);
      const notes = (s.comments || []).map(noteOf);
      for (const a of acts) if (this.actTask(a) === s.id) {
        if (a.op === 'note' || a.op === 'skip' || a.op === 'doneNote') notes.push(waitingNote(a));
        if (a.op === 'progress') { pct = a.pct; continue; }
        if (a.op === 'note' || a.op === 'claim' || a.op === 'unclaim') continue;
        waiting = true; done = a.op !== 'undone'; skipped = a.op === 'skip'; doneAt = a.at; by = me ? [me] : [];
      }
      const people = s.pending ? [] : this.peopleOf(s.id, s.assignees);
      const slot = done ? this.doneSlot(by, people, waiting ? 'wait' : skipped ? 'skip' : 'done')
        : s.pending ? null : this.claimSlot({...s, project_id: r.run.project_id}, people, r.run.done);
      // by: who did it or skipped it, shown in the list as a reaction is, ✅ or ⏭️ with their picture.
      // "Done by Priya at 4:46 PM" (and the day, if it wasn't today).
      const at = doneAt && isSet(doneAt) ? ' at ' + (+startOfDay(new Date(doneAt)) === +startOfDay() ? fmtTime(new Date(doneAt))
        : new Date(doneAt).toLocaleString([], {weekday: 'short', hour: 'numeric', minute: '2-digit'})) : '';
      return {id: s.id, i, title: parseStep(s.title).title, description: notesOnly(s.description), attachments: s.attachments, done, skipped, waiting, notes, doneAt, slot, by, pct,
        added: s.added || '', pending: s.pending || null, from: s.from || null, tpl: s.tpl,
        whoText: !done ? '' : (skipped ? 'Skipped' : 'Done') + (waiting ? ' · waiting to send' : (by.length ? ' by ' + andList(doers()) : '') + at)};
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
      s.waitsFor = from && !from.done && t.offset ? from.id : null;    // a time after a step not done yet: its id
      s.dueAt = due ? +due : Infinity;
      s.countText = !s.counting ? '' : left >= 0 ? 'in ' + durText(left < 6e4 ? Math.ceil(left / 1e3) * 1e3 : Math.ceil(left / 6e4) * 6e4) : durText(-left < 6e4 ? -left : Math.floor(-left / 6e4) * 6e4) + ' late';
      s.dueText = waitsOn ? 'Due ' + waitsOn : s.counting ? (left >= 0 ? 'Due ' : '') + s.countText : due ? 'Due ' + dueInfo(due.toISOString()).label : '';
    });
    const total = steps.length, doneCount = steps.filter(s => s.done).length, first = steps.findIndex(s => !s.done);
    const allDone = total > 0 && doneCount === total, at = r.at ?? (first >= 0 ? first : total - 1);
    // Skipped steps are out of the way (doneCount, for the bar), but not done (didCount, in words).
    const skippedN = steps.filter(s => s.skipped).length, lateN = steps.filter(s => s.done && s.late).length, didCount = doneCount - skippedN;
    const by = r.run.created_by, starter = by && (by.id === me?.id ? 'you' : by.name || by.username);
    const forText = [this.forText(r.run), starter && 'started by ' + starter].filter(Boolean).join(' · ');
    const finished = (acts.filter(a => a.op === 'finish' || a.op === 'reopen').pop()?.op ?? (r.run.done ? 'finish' : '')) === 'finish';
    // Finished, or every step done, no step is on screen until one is tapped.
    const step = (allDone || finished) && r.at === null ? null : steps[at] || null;
    /* Where the insert box is open: under the step whose › was tapped (`after`), so what's added goes before the step
       after it, or at the end after the last. That step can be repeated there, done or not, once it's been sent. */
    const k = steps.findIndex(s => s.id === this.runInsert.after), under = k >= 0 ? steps[k] : null;
    const insert = !under ? null : {at: k, after: under, before: steps[k + 1]?.id ?? null, repeatable: under.pending ? null : under};
    return {steps, total, doneCount, didCount, skippedN, allDone, at, step, insert, finished, timers: steps.filter(s => s.counting && s !== step).sort((a, b) => a.dueAt - b.dueAt),
      countText: `${didCount} of ${total} done` + (skippedN ? ` · ${skippedN} skipped` : ''),
      summary: [`${didCount} of ${total} done`, skippedN && `${skippedN} skipped`, total - doneCount && `${total - doneCount} not done`, lateN && `${lateN} done late`].filter(Boolean).join(' · '),
      notes: [...(r.run.comments || []).map(noteOf), ...acts.filter(a => a.op === 'note' && a.task === r.run.id).map(waitingNote)],
      forText: forText && forText[0].toUpperCase() + forText.slice(1)};
  },
  // What was noted on this step last time, from the last finished run of the same template.
  lastNotes(s){ return s?.tpl ? (this.view.run?.last?.notes || []).filter(n => n.tpl === s.tpl) : []; },
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
    if (!this.isRunTask(t)) return t.done ? 100 : pctOf(t);
    const steps = t.related_tasks?.subtask || [];
    return steps.length ? Math.round(100 * steps.filter(x => this.stepDone(x.id, x.done)).length / steps.length) : 0;
  },
  // A run's steps done (waiting ticks too), and the next one: {steps: [{id, done, title}]}.
  runCount(r){
    const done = r.steps.map(x => this.stepDone(x.id, x.done));
    return {done: done.filter(Boolean).length, total: r.steps.length, next: r.steps.find((x, i) => !done[i])?.title || ''};
  },
  goProject(id){ this.closeSheet(true); this.go('#/project/' + id); },
  // A row in a list: a checklist run, or a step of one, opens the run; a template that comes round, its Start sheet;
  // any other task opens its sheet.
  openRow(t){
    if (this.isRunTask(t)) return this.openRun(t.id);
    if (this.checklistIds.has(t.project_id) && isTemplate(t) && !t.done) return this.openStart(t.id);
    const run = this.stepRun(t);
    if (run) return this.openRun(run, t.id);
    this.openTask(t.id);
  },
  showStep(i, scroll){
    if (!this.view.run) return;
    this.view.run.at = i;
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
    // Someone else's ✅ can't be taken off: Vikunja lets each person take back only their own.
    const others = op === 'undone' ? (s.by || []).filter(u => u.id !== this.user?.id).map(u => this.nameOf(u)) : [];
    if (others.length && !confirm(`${others.join(' and ')} marked “${s.title}” done. Their ✅ stays on it in Vikunja, as only they can take it off. Mark it not done?`)) return;
    const typed = op === 'undone' ? '' : (this.runDrafts[s.id] || '').trim();
    if (typed) this.runDrafts[s.id] = '';
    if (op === 'skip') html = textToHtml('Skipped' + (typed ? ': ' + typed : ''));
    if (op === 'done' && typed) { op = 'doneNote'; html = textToHtml(typed); }
    if (current && op !== 'undone') r.at = this.nextStep(s);
    navigator.vibrate?.(10);
    await this.act({op, task: s.id, html});
  },
  /* Where the run goes after a step is done or skipped on screen: the next step after it that can be done now, not one
     still counting down, nor one that starts counting down with this tick; then one before it; then any not done. Null
     once every other step is done: the finish card. */
  nextStep(s){
    const v = this.runView, open = v ? v.steps.filter(x => !x.done && x.id !== s.id) : [];
    if (!open.length) return null;
    const ready = x => !(x.counting && x.dueAt > serverTime(this.clock)) && x.waitsFor !== s.id;
    return (open.find(x => x.i > s.i && ready(x)) || open.find(ready) || open[0]).i;
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
        if (last.status === 'error') this.notify(`${last.error.what || 'It'} couldn't be saved${last.error.saved ? ` in full (${last.error.saved})` : ''}: ${last.error.message}.` + (last.kept ? KEPT : this.wordsBack(last.error)));
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
      // "Not done" made offline on a step of a run someone finished meanwhile: not sent, so the run stays as they left it.
      if (a.op === 'undone' && a.run && a.task !== a.run && !a.stage && (await api('/tasks/' + a.run)).done)
        throw Object.assign(new ApiError(409, 'the run was finished meanwhile, so the step stays done'), {drop: true});
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
      // Turned down for good, with nothing kept to try again: the screen shows how it is now.
      if (error.drop) {
        await sync.remove(a.id);
        if (this.view.run?.run.id === a.run) this.refreshRunTask(a.task);
        if (this.sheet.task && this.sheet.kind === 'task') this.loadSubPeople(this.sheet.task);
        return {...none, status: 'error', error};
      }
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
      done: 'A tick' + on, undone: 'An untick' + on, progress: 'Progress' + on, finish: 'Finishing the run', reopen: 'Reopening the run',
      claim: 'Saying you’ll do' + (title ? ` “${parseStep(title).title}”` : ' it'), unclaim: 'Letting go of' + (title ? ` “${parseStep(title).title}”` : ' it')}[a.op] || 'Something done offline';
  },
  /* An action on a run, or a comment, that won't be sent: its words go back where they were written, and `error.back`
     says so. If what they were written on is gone (a run deleted meanwhile, say), there's nowhere to put them back:
     `error.words` has them, for the message (wordsBack). */
  giveBack(a, error){
    const text = a.html ? htmlToText(a.html).replace(/^Skipped:?\s*/, '').trim() : '';
    if (!text) return;
    if (error.status === 404) { error.words = text; return; }
    const add = (was = '') => [was.trim(), text].filter(Boolean).join('\n');
    if (!a.run) {
      taskDrafts.set('comment:' + a.task, add(taskDrafts.get('comment:' + a.task)));
      if (this.sheet.task?.id === a.task) this.sheet.commentDraft = add(this.sheet.commentDraft);
    } else this.runDrafts[a.task] = add(this.runDrafts[a.task]);
    error.back = true;
  },
  wordsBack(e){ return e.back ? ' Its words are back in the box.' : e.words ? ` It said: “${e.words}”` : ''; },
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
    if (s && a.op === 'progress') { s.percent_done = a.pct / 100; return; }
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
  /* Insert a step after any step, or repeat that step there (repeatStep). Through the outbox, as a tick is: offline it
     waits, shown in its place, and can be ticked meanwhile. The run's screen then shows the new step. */
  /* The box opens under a step from the › at its left (openInsert), one at a time, out of the way otherwise. It's quick
     add's 'ins' box, so it reads labels, people and priority as the subtask box does (not dates: a step's time is its
     template's), and each line of a pasted list is a step, in order. 🔁 puts the step it's under in the box (armRepeat):
     left as it is, + repeats that step; changed, it's a new step; tapped again, it puts back what was typed before.
     What's typed stays in the box when it's closed or moved under another step, until it's inserted (keep: false). */
  openInsert(s){
    const open = this.runInsert.after === s?.id ? null : s?.id ?? null, text = this.insertKept();
    this.runInsert = {...newBox(), text, repeat: null, after: open};
    if (open) this.$nextTick(() => document.getElementById('step-insert-in')?.focus());
  },
  insertKept(){ const b = this.runInsert; return b.repeat ? b.typed || '' : b.text; },
  closeInsert(keep = true){ this.runInsert = {...newBox(), text: keep ? this.insertKept() : '', repeat: null, after: null}; },
  armRepeat(s){
    const b = this.runInsert;
    if (b.repeat) { this.runInsert = {...b, text: b.typed || '', repeat: null, typed: ''}; return; }
    this.runInsert = {...newBox(), text: s.title, repeat: s, after: b.after, typed: b.text};
  },
  async insertStep(){
    const v = this.runView, b = this.runInsert;
    if (!v?.insert || b.busy) return;
    // Each goes before the step after the box; if that one's deleted meanwhile, after the one before it.
    const before = v.insert.before, under = v.insert.after.id;
    if (b.repeat && b.text.trim() === b.repeat.title) {
      this.closeInsert(false);
      await this.repeatStep(b.repeat, before, under);
      return;
    }
    const lines = this.boxParsedLines('ins').filter(p => p.title);
    if (!lines.length) return;
    this.closeInsert(false);
    let after = under;
    for (const p of lines) after = 'pending-' + await this.addStep({title: p.title, p: packParsed(p), before, after});
  },
  async repeatStep(s, before, after = null){
    if (!s) return;
    await this.addStep({title: s.title, before, after, from: s.from, tpl: s.tpl ?? null});
  },
  /* A step's progress, held and slid on its row as on a task's: through the outbox, as a tick is. 100% is done, with its
     ✅, as Done is. `undoing`: putting back what it was. */
  async stepProgress(s, pct, undoing = false){
    if (pct >= 100 && !undoing) {
      await this.tickStep(s, 'done');
      this.notify(`Done: ${s.title}`, {label: 'Undo', fn: () => this.tickStep(s, 'undone')});
      return;
    }
    const was = s.pct, r = await this.act({op: 'progress', task: s.id, pct});
    if (r.status !== 'error' && !undoing) this.notify(`Progress set to ${pct}%`, {label: 'Undo', fn: () => this.stepProgress(s, was, true)});
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
      // Turned down for good (the run deleted meanwhile, say): what it made goes again, a step made but not put under the
      // run too.
      const made = j.taskId || j.job?.taskId;
      if (made) await api('/tasks/' + made, {method: 'DELETE'}).catch(() => {});
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
  /* Don't send a step waiting to be inserted, nor what was done on it. One that may have reached Vikunja already (tried
     when the connection went) is called off: whatever reached it is deleted once Pocket reaches it again (unsendStep). */
  async dropStep(id){
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
    this.notify(gone ? 'It was sent already: delete it on the run if it isn\'t needed.'
      : tried && this.pending.some(e => e.id === id) ? 'Not inserted. What reached Vikunja of it is taken out once Pocket reaches it.' : 'Not sent.');
    if (this.route.name === 'run') this.render();
  },
  // A step called off that may have reached Vikunja: found, if it got there, and deleted.
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
      error.what = `Taking out “${j.title}”`;
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
