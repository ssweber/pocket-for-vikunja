// Sending what was added to Vikunja, through the outbox, and the "Waiting to send" rows.
import {cache, userCache, ZERO} from '../util.js';
import {api, ApiError, items, passing, seenToken, sharedToken, TRANSIENT, triedSince} from '../api.js';
import {addDays, dueInfo, isSet, startOfDay} from '../dates.js';
import {parseCapture} from '../quickadd.js';
import {entryDone, fileEntry, isChild, itemDone, LINE_STEPS, NO_ROOM, NOT_KEPT, packParsed, randomId, sync, unpackParsed} from '../sync.js';
import {nestSubtasks, saved, todayGroups, viewKey} from '../lists.js';

let freshTimer;

export default {
  /* Create one task from a parsed line; labels are created when missing. */
  /* Create a task from a parsed line, by LINE_STEPS. `job` keeps each step's progress and `save` keeps the job: for a
     line in the outbox, job is its item. `made` hears of the task as soon as it exists, and `parent` makes it a
     subtask of that task. Returns the task (just {id, project_id} if an earlier try made it), with `problems`: what
     couldn't be done, like an @username who can't see the project. A lost connection or a busy Vikunja is thrown. */
  async createTask(parsed, pid, {job = {}, save = async () => {}, made, at, skip, parent} = {}){
    job.problems ||= [];
    job.key ||= randomId();                      // this line, for the record of which task was added for it
    const c = {parsed, pid, save, made, at, skip, parent};
    if (!itemDone(job, !!parent)) {
      for (const step of LINE_STEPS) while (!step.done(job, c)) { await step.run(job, c); await save(); }
      job.done = true; await save();
    }
    return Object.assign(c.task || {id: job.taskId, project_id: job.projectId}, {problems: job.problems});
  },
  async findUser(name){
    const key = name.toLowerCase();
    if (userCache.has(key)) return userCache.get(key);
    const u = items(await api('/users?q=' + encodeURIComponent(name))).find(x => x.username.toLowerCase() === key) || null;
    if (u) userCache.set(key, u);
    return u;
  },
  linkSubtask(parentId, childId){
    return api(`/tasks/${parentId}/relations`, {method:'POST', body:{other_task_id: childId, relation_kind: 'subtask'}});
  },
  /* Create a task per line, in order. With parent, each becomes its subtask and lands in the parent's project
     unless the line names one. Returns the ids created and how many lines were used; stops at the first error. */
  async createLines(lines, {pid, parent, ignore = {}} = {}){
    const ids = [], problems = []; let used = 0;
    try {
      for (const line of lines) {
        const parsed = parseCapture(line, this.projects, {...this.parseOpts, ignore});
        if (parsed.title) {
          const t = await this.createTask(parsed, parent ? parent.project_id : pid, {parent: parent?.id});
          ids.push(t.id); problems.push(...t.problems);
        }
        used++;
      }
      return {ids, used, problems, error: null};
    } catch (error) { return {ids, used, problems, error}; }
  },
  async deleteTasks(ids){
    for (const id of [...ids].reverse()) await api('/tasks/' + id, {method:'DELETE'}).catch(() => {});
    this.render();
  },
  /* Every capture goes through the outbox: online it's sent straight away, offline it waits. */
  async submitCapture(){
    const lines = this.capLines, parsed = this.parsed;
    if (!parsed.title || this.cap.busy) return;
    // A single task can go to the project picked for its @usernames; a pasted list goes where it always does.
    const pid = lines.length === 1 ? this.boxPid('cap') : this.defaultProjectId();
    const first = parsed.project?.id || pid;
    if (!first) { this.notify('Create a project in Vikunja first'); return; }
    if (!this.canWrite(first)) { this.notify(`${this.projById.get(first)?.title || 'That project'} is shared with you to read only: pick another with +project.`); return; }
    const nest = this.cap.nest && lines.length > 1;
    // Parse every line now, so dates mean what they meant when typed.
    const list = this.parseList(lines, parsed);
    const items = lines.map((raw, i) => ({raw, p: list.parsed[i]}))
      .filter(x => x.p.title).map(x => ({raw: x.raw, p: packParsed({...x.p, remind: this.remindOn('cap', lines)}), taskId: null, done: false, linked: false}));
    const photos = this.capPhotos.map(f => Alpine.raw(f));
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), nest, pid, items, files: photos.map(fileEntry)};
    this.cap.busy = true; this.cap.text = ''; this.cap.nest = false; this.capPhotos = [];
    if (this.cap.focus) this.$nextTick(() => this.$refs.capture.focus());   // to type the next one
    try {
      // Saved first, with its photos, but only shown as waiting if sending doesn't finish.
      const {kept, full} = await sync.add(entry, photos);
      const slow = setTimeout(() => this.refreshPending(), 400);           // on a slow connection, shown as waiting meanwhile
      const r = await sync.lock(() => this.sendEntry(entry.id));
      clearTimeout(slow);
      if (r.ids?.length) { this.fresh = r.ids; clearTimeout(freshTimer); freshTimer = setTimeout(() => this.fresh = [], 2000); }
      this.placeSent(r.tasks || []);
      const n = items.length, np = photos.length;
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      if (r.status === 'offline') {
        // It shows up in the list, tinted, unless this list wouldn't include it (say, a task due next month on Today).
        this.refreshPending();
        sync.keep();
        if (!kept) this.notify(full ? NO_ROOM : NOT_KEPT);
        else if (np && r.ids.length === n)            // the task got there; its photos are still to go
          this.notify(`Added to ${this.projById.get(r.projectId)?.title || 'project'}. ${np === 1 ? 'The photo uploads' : 'The photos upload'} when the connection's back.`, {label: 'Open', fn: () => this.openTask(r.ids[0])});
        else if (np) this.notify(`Saved offline, with ${np === 1 ? 'the photo' : np + ' photos'}. ${n === 1 && np === 1 ? 'Both go' : 'They all go'} to Vikunja when you're back online.`);
        else if (!this.pendingTasks.some(t => t.entry === entry.id && this.pendingPlace(t)))
          this.notify(`Saved offline. ${n === 1 ? 'It goes' : 'They go'} to Vikunja when you're back online.`);
      } else if (r.status === 'error') {
        this.cap.text = r.unsent.join('\n');                                // keep what wasn't added
        this.capPhotos = r.photos;
        const undo = r.ids.length ? {label: 'Undo', fn: () => this.deleteTasks(r.ids)} : null;
        this.notify(r.ids.length ? `Added ${r.ids.length} of ${n}${but}. Stopped: ${r.error.message}` : 'Not added: ' + r.error.message, undo);
      } else if (r.status === 'gone') {
        this.notify('Added');                                              // another tab sent it first
      } else if (n === 1) {
        // A date past next week keeps it off Today, so say which, in case quick add read it wrong.
        const due = items[0].p.due, later = due && new Date(due) >= addDays(startOfDay(), 8) ? ', due ' + dueInfo(due).label : '';
        const withPhotos = r.uploaded ? (r.uploaded === 1 ? ', with the photo' : `, with ${r.uploaded} photos`) : '';
        const where = 'Added to ' + (this.projById.get(r.projectId)?.title || 'project') + later + withPhotos;
        this.notify(where + but, {label: 'Undo', fn: () => this.deleteTasks(r.ids)}, {label: 'Open', fn: () => this.openTask(r.ids[0])});
      } else {
        this.notify((nest ? `Added 1 task with ${n - 1} subtask${n === 2 ? '' : 's'}` : `Added ${n} tasks`) + but, {label: 'Undo', fn: () => this.deleteTasks(r.ids)},
          {label: 'Open', fn: () => this.openTask(r.ids[0])});
      }
    } finally {
      this.cap.busy = false;
      this.refreshPending();
      this.render();
    }
  },
  /* Send one outbox entry, carrying on where an earlier try stopped. Returns {status: sent|offline|error|gone, ...},
     with the ids of its tasks, the tasks created this time, and how many files were uploaded. `offline` means it's
     kept to try again; `reached` that Vikunja answered, only not usefully yet (busy, or a server error on a file). */
  async sendEntry(id){
    const entry = await sync.fresh(id);
    if (!entry) return {status: 'gone', ids: [], tasks: []};                // another tab sent it
    if (entry.kind === 'run') return this.sendRun(entry);
    if (entry.kind === 'act') return this.sendAct(entry);
    const ids = [], tasks = [], problems = entry.problems ||= [], save = () => sync.save(entry);
    const all = () => [...entry.items.flatMap(x => x.problems || []), ...problems];
    const taken = new Set(entry.items.map(x => x.taskId).filter(Boolean));  // a pasted list can have a line twice
    let uploaded = 0;
    try {
      for (const [i, item] of entry.items.entries()) {
        const child = isChild(entry, i), under = entry.parent?.id ?? (child ? entry.items[0].taskId : null);
        await this.createTask(unpackParsed(item.p), entry.parent ? entry.parent.project_id : child ? entry.parentProject : entry.pid, {
          job: item, save, at: entry.at, skip: taken, parent: under,
          made: t => { taken.add(t.id); tasks.push({...t, child, parent: under}); if (i === 0) entry.parentProject = t.project_id; }});
        ids.push(item.taskId);
      }
      // Then the photos and files, to the task they were added to.
      const target = entry.taskId || entry.items[0]?.taskId, files = (entry.files || []).filter(f => !f.sent);
      if (files.length) { this.placeSent(tasks); this.refreshPending(); }    // the task shows while its photos upload
      for (const f of files) if (await this.sendFile(entry, target, f)) uploaded++;
      await sync.remove(entry.id);
      if (files.length) {
        this.refreshPending();
        // The task with its new attachments, for its row and its sheet.
        const t = await api('/tasks/' + target).catch(() => null);
        if (t) {
          cache.set(t.id, t); this.syncTask(t);
          for (const x of tasks) if (x.id === t.id) Object.assign(x, t);
          if (this.sheet.task?.id === t.id) { this.showTask(t); this.sheet.dirty = true; }
          const step = this.view.run?.steps.find(s => s.id === t.id);           // a photo of a run's step
          if (step) step.attachments = t.attachments || [];
        }
      }
      return {status: 'sent', ids, tasks, problems: all(), uploaded, projectId: entry.parentProject};
    } catch (error) {
      // No connection, Vikunja busy, or signed out: keep it for later.
      if (passing(error) || error.again || (error instanceof ApiError && error.status === 401))
        return {status: 'offline', reached: error instanceof ApiError && error.status !== 401, ids, tasks, problems: all(), uploaded, projectId: entry.parentProject};
      // Photos added with a task that couldn't be added go back to the add box with it.
      const photos = (await Promise.all((entry.files || []).filter(f => !f.sent).map(f => sync.file(f.key)))).filter(Boolean);
      await sync.remove(entry.id);
      return {status: 'error', ids, tasks, problems: all(), error, photos, unsent: entry.items.filter(x => !x.taskId).map(x => x.raw), parent: entry.parent || null};
    }
  },
  // Upload one waiting file, unless an earlier try that was cut off got it there already. A file Vikunja turns down
  // (too big, say, or the task is gone) is reported and dropped; after a server error it's kept, to try again, and its
  // row says so (`trouble`). `sent` marks it as dealt with. Returns whether it's on the task.
  async sendFile(entry, taskId, f){
    const problems = entry.problems ||= [];
    let ok = false;
    try {
      if (f.tried && await this.hasAttachment(taskId, f, entry.at)) ok = true;
      else {
        const file = await sync.file(f.key);
        if (!file) problems.push(`${f.name} was lost on this device before it uploaded`);
        else {
          f.tried = true; f.triedAt = Date.now(); await sync.save(entry);
          const form = new FormData(); form.append('files', file, f.name);
          const r = await api(`/tasks/${taskId}/attachments`, {method: 'POST', body: form});
          // Vikunja answers OK even when it turns a file down, with the reasons in `errors`.
          if (r?.errors?.length) problems.push(`${f.name} didn't upload: ${r.errors.map(e => e.message).join('; ')}`); else ok = true;
        }
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status >= 500 || TRANSIENT.has(e.status))) { f.trouble = true; await sync.save(entry); e.again = true; }
      if (passing(e) || e.again || e.status === 401) throw e;
      problems.push(`${f.name} didn't upload: ${e.message}`);
    }
    f.sent = true; await sync.save(entry, [f.key]);
    return ok;
  },
  // Whether this file is on the task already, uploaded since it was added.
  async hasAttachment(taskId, f, at){
    const t = await api('/tasks/' + taskId), since = triedSince(f.triedAt, at);
    return (t?.attachments || []).some(a => a.file?.name === f.name && a.file?.size === f.size && new Date(a.created).getTime() >= since);
  },
  // Put tasks that just reached Vikunja in the list on screen, where they belong, without waiting for it to reload. On
  // a patchy connection the reload can fail, and the list on screen is then kept as it was: without them.
  placeSent(tasks){
    if (this.view.loading || this.view.route !== location.hash) return;
    let placed = false;
    for (const {child, problems, ...t} of tasks) {
      const key = this.pendingPlace({...t, child});
      if (!key || this.view.groups.some(g => g.tasks.some(x => x.id === t.id))) continue;
      const g = this.view.groups.find(g => g.key === key);
      if (g) g.tasks.push(t);
      else this.view.groups.push({...(this.route.name === 'today' ? todayGroups().find(x => x.key === key) : {key, cls: '', title: 'Open'}), tasks: [t]});
      placed = true;
    }
    // And in the copy kept for opening offline.
    const k = viewKey(this.route), s = saved.get(k);
    if (placed && s) saved.set(k, {...s, groups: this.view.groups});
  },
  // The task a cut-off try added, if it got there: this title, in this project, added by you since that try, and not
  // one of the capture's other tasks or one Pocket added for another line.
  async findSent(title, project, triedAt, at, skip = new Set(), key){
    const list = items(await api('/tasks?q=' + encodeURIComponent(title)));
    const since = triedSince(triedAt, at);
    return list.find(t => t.title === title && t.project_id === project && t.created_by?.id === this.user?.id && !skip.has(t.id) && !sync.claimedByOther(t.id, key)
      && new Date(t.created).getTime() >= since) || null;
  },
  // Send whatever is waiting. Called when Pocket opens, comes back to the front, reconnects, and every 30 seconds.
  async flush(){
    // In a shared session, nothing is sent until Pocket knows the session is still this person's.
    if (this.signedIn && this.user && this.mode === 'session' && sharedToken.get() !== seenToken) { this.sessionChanged(); return; }
    if (this.flushing || !this.signedIn || !this.user || !sync.all(this.user.id).length) return;
    this.flushing = true;
    let sent = 0; const failed = [], other = [], tasks = [], problems = [];
    try {
      await sync.lock(async () => {
        let actsWait = false;                                                 // an act kept: the later ones wait behind it
        for (const e of sync.all(this.user?.id)) {
          if (e.kind === 'act' && actsWait) continue;
          const r = await this.sendEntry(e.id);
          if (e.kind === 'act' && r.status === 'offline') actsWait = true;
          tasks.push(...(r.tasks || [])); problems.push(...(r.problems || []));
          if (r.status === 'offline' && !r.reached) break;                    // no connection: the rest can wait too
          if (r.status === 'sent') sent += r.ids.length + r.uploaded + (r.changed || 0);
          if (r.status === 'error') (r.unsent ? failed : other).push(r);
        }
      });
    } finally { this.flushing = false; this.refreshPending(); }
    this.placeSent(tasks);
    // Subtasks that were waiting, of the task whose sheet is open: shown there now.
    const open = this.sheet.task?.id;
    if (open && tasks.some(t => t.parent === open)) api('/tasks/' + open).then(t => {
      cache.set(t.id, t);
      if (this.sheet.task?.id === t.id) { this.showTask(t); this.sheet.dirty = true; }
    }).catch(() => {});
    // What couldn't be added goes back in its box: quick add, or the subtask box if its task's sheet is open. Subtasks of a
    // task that isn't open are named in the message instead, so they aren't lost.
    const subs = failed.filter(f => f.parent), lost = subs.filter(f => this.sheet.task?.id !== f.parent.id), back = failed.filter(f => !f.parent);
    for (const f of subs) if (!lost.includes(f)) this.sheet.sub.text = [this.sheet.sub.text, ...f.unsent].filter(Boolean).join('\n');
    if (back.length) {
      this.cap.text = [this.cap.text, ...back.flatMap(f => f.unsent)].filter(Boolean).join('\n');
      this.capPhotos = [...this.capPhotos, ...back.flatMap(f => f.photos)];
    }
    if (lost.length) {
      const f = lost[0], loose = (f.tasks || []).map(t => `“${t.title}”`);
      this.notify(`Subtasks of “${f.parent.title}” added offline couldn't be put under it: ${f.error.message}.`
        + (loose.length ? ` ${loose.join(', ')} ${loose.length === 1 ? 'was' : 'were'} added as tasks of their own.` : '')
        + (f.unsent.length ? ` Not added: ${f.unsent.join('; ')}.` : ''));
    } else if (failed.length) {
      this.notify(`${subs.length ? 'A subtask' : 'A task'} added offline couldn't be added: ${failed[0].error.message}. It's back in the box.`);
    } else if (other.length) this.notify(`${other[0].error.what || 'Something done offline'} couldn't be sent: ${other[0].error.message}.` + (other[0].error.back ? ' Its words are back in the box.' : ''));
    else if (problems.length) this.notify('Sent what was waiting, but ' + problems.join('; '));
    if (sent || failed.length || other.length) this.render();
  },

  /* ---------- what's waiting to be sent ---------- */
  refreshPending(){ this.pending = this.user ? sync.all(this.user.id) : []; },
  pendingNested(entryId){ const e = this.pending.find(x => x.id === entryId); return !!e?.nest && e.items.length > 1; },
  // Tasks still in the outbox, shaped like tasks so they can sit in the lists where they'll land once sent.
  get pendingTasks(){
    const out = [];
    for (const e of this.pending) {
      const parentProject = e.parent?.project_id || e.items[0]?.p.project?.id || e.pid;
      e.items.forEach((x, i) => {
        if (x.taskId) return;
        const p = x.p;
        const child = isChild(e, i);
        out.push({id: `pending-${e.id}-${i}`, pending: true, entry: e.id, index: i, child, parent: e.parent?.id ?? (child ? e.items[0].taskId || `pending-${e.id}-0` : null), title: p.title, done: false, priority: p.priority || 0,
          due_date: p.due || ZERO, project_id: p.project?.id || (child ? parentProject : e.pid),
          labels: [], assignees: [], repeat_after: p.repeat?.after || 0, repeat_mode: p.repeat?.mode || 0,
          waiting: i === 0 ? (e.files || []).filter(f => !f.sent).length : 0});
      });
    }
    return out;
  },
  // Photos and files on their way to tasks already in Vikunja: task id -> [{entry, key, name, ...}].
  get waitingByTask(){
    const m = new Map();
    for (const e of this.pending) {
      const id = e.taskId || e.items[0]?.taskId;
      if (id) for (const f of e.files || []) if (!f.sent && !this.dropping.includes(f.key)) m.set(id, [...(m.get(id) || []), {...f, entry: e.id}]);
    }
    return m;
  },
  // Which group of the current list a waiting task belongs in, by the same rules as the lists from Vikunja; null if none.
  pendingPlace(t){
    const r = this.route;
    if (r.name === 'project') return !r.showDone && t.project_id === r.id ? 'open' : null;
    if (r.name !== 'today') return null;
    if (!isSet(t.due_date)) return t.child ? null : 'nodate';
    const d = new Date(t.due_date), t0 = startOfDay();
    return d >= addDays(t0, 8) ? null : d < t0 ? 'overdue' : d < addDays(t0, 1) ? 'today' : 'week';
  },
  // The current list, with waiting tasks added where they belong, and subtasks under their parents.
  get listGroups(){
    return this.listBase.map(g => ({...g, ...nestSubtasks(g.tasks)}));
  },
  get listBase(){
    const extra = this.pendingTasks.map(t => [this.pendingPlace(t), t]).filter(([k]) => k);
    let base = this.view.groups;
    if (this.route.name === 'today') {
      // Every group, even in a list saved offline before "Added today, no date" existed, and in one saved yesterday only today's additions.
      const t0 = startOfDay();
      base = todayGroups().map(g => {
        const b = base.find(x => x.key === g.key) || g;
        return g.key === 'nodate' ? {...b, tasks: b.tasks.filter(t => new Date(t.created) >= t0)} : b;
      });
    } else if (!extra.length) return base;
    if (!base.length && this.route.name === 'project' && this.view.project) base = [{key:'open', cls:'', title:'Open', tasks:[]}];
    return base.map(g => ({...g, tasks: [...g.tasks, ...extra.filter(([k]) => k === g.key).map(([, t]) => t)]}));
  },
  /* Cancel one waiting task. Its words go back in the box it was added from, to change or add again. Cancelling the
     first line of a pasted list with a parent leaves the rest as tasks of their own, and says so. The photos added with
     it go too. */
  async cancelPending(entryId, index){
    let raw = '', rest = 0, parent = null, sent = false;
    await sync.lock(async () => {
      const e = await sync.fresh(entryId);
      if (!e || !e.items[index] || e.items[index].taskId) { sent = true; return; }   // sent while this waited
      raw = e.items[index].raw.trim(); parent = e.parent || null;
      e.items.splice(index, 1);
      let drop = [];
      if (index === 0) { rest = e.nest ? e.items.filter(x => !x.taskId).length : 0; e.nest = false; drop = (e.files || []).map(f => f.key); e.files = []; }
      await sync.save(e, drop);
      if (entryDone(e)) await sync.remove(e.id);
    });
    this.refreshPending();
    if (sent) { this.notify('It was sent before it could be cancelled.'); this.render(); return; }
    const box = parent ? (this.sheet.task?.id === parent.id ? this.sheet.sub : null) : this.cap;
    if (raw && box) box.text = [box.text.trim(), raw].filter(Boolean).join('\n');
    this.notify(['Cancelled.', raw && box && 'It\'s back in the box.', rest && `The ${rest} line${rest === 1 ? '' : 's'} under it ${rest === 1 ? 'is' : 'are'} now ${rest === 1 ? 'a task' : 'tasks'} of ${rest === 1 ? 'its' : 'their'} own.`].filter(Boolean).join(' '));
  },
  // Don't upload a waiting photo or file after all. Its row goes at once; one already uploading finishes first.
  async cancelFile(entryId, key){
    this.dropping.push(key);
    await sync.lock(async () => {
      const e = await sync.fresh(entryId); if (!e) return;
      const was = e.files.length;
      e.files = e.files.filter(f => f.key !== key || f.sent);
      if (e.files.length === was) return;                                    // uploaded meanwhile
      await sync.save(e, [key]);
      if (entryDone(e)) await sync.remove(e.id);
    });
    this.refreshPending();
    this.dropping = this.dropping.filter(k => k !== key);
  },
};
