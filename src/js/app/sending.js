// Sending what was added to Vikunja, through the outbox, and the "Waiting to send" rows.
import {cache, userCache, ZERO} from '../util.js';
import {api, ApiError, items, passing, seenToken, sharedToken, TRANSIENT, triedSince} from '../api.js';
import {addDays, isLate, isSet, startOfDay} from '../dates.js';
import {addedWhere} from '../messages.js';
import {patiently} from '../checklists.js';
import {parseCapture} from '../quickadd.js';
import {entryDone, fileEntry, held, heldTasks, isChild, itemDone, KEPT, LINE_STEPS, NO_ROOM, NOT_KEPT, packParsed, randomId, slowness, sync, unpackParsed} from '../sync.js';
import {listItems, nestSubtasks, saved, screenRows, todayAt, todayGroups, todayOrder, viewKey} from '../lists.js';
import {positionOrder, SPACING} from '../order.js';

let waitTimer;
// What createLines keeps of each line: an earlier try's, for a line that's the same, or a new one.
export const jobsFor = (kept, lines) => lines.map((line, k) => kept[k]?.line === line ? kept[k] : {line, at: new Date().toISOString()});

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
      // A busy Vikunja (on SQLite, "database is locked") is tried again a few times at once: each step keeps how far it got.
      for (const step of LINE_STEPS) while (!step.done(job, c)) { await patiently(() => step.run(job, c)); await save(); }
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
     unless the line names one. Returns the ids created and how many lines were used; stops at the first error.
     `jobs` (from jobsFor) keeps how far each line got, so trying again carries on: a task whose reply was lost is found
     rather than added twice. `ignores`: each line's chips tapped off, on top of `ignore`. */
  async createLines(lines, {pid, parent, ignore = {}, ignores = [], jobs = jobsFor([], lines)} = {}){
    const ids = [], problems = []; let used = 0;
    try {
      for (const [k, line] of lines.entries()) {
        const parsed = parseCapture(line, this.projects, {...this.parseOpts, ignore: {...ignore, ...ignores[k]}});
        if (parsed.title) {
          const job = jobs[k], t = await this.createTask(parsed, parent ? parent.project_id : pid, {job, at: job.at, skip: new Set(ids), parent: parent?.id});
          ids.push(t.id); problems.push(...t.problems);
        }
        used++;
      }
      return {ids, used, problems, error: null};
    } catch (error) { return {ids, used, problems, error}; }
  },
  /* Every capture goes through the outbox: online it's sent straight away, offline it waits. */
  async submitCapture(){
    const lines = this.capLines, parsed = this.parsed;
    if (!parsed.title || this.cap.busy) return;
    // A single task can go to the project picked for its @usernames; a pasted list goes where it always does.
    const pid = lines.length === 1 ? this.boxPid('cap') : this.defaultProjectId();
    const first = parsed.project?.id || pid;
    if (!first) { this.say('Create a project in Vikunja first', {place: 'cap', cls: 'failed'}); return; }
    if (!this.canWrite(first)) { this.say(`${this.projById.get(first)?.title || 'That project'} is shared with you to read only: pick another with +project.`, {place: 'cap', cls: 'failed'}); return; }
    const nest = this.cap.nest && lines.length > 1;
    // Parse every line now, so dates mean what they meant when typed.
    const list = this.parseList(lines, parsed);
    // Under the first line, the rest keep their order in its project's List view, each after the one before (Vikunja
    // would put each new one first).
    const items = lines.map((raw, i) => ({raw, p: list.parsed[i]}))
      .filter(x => x.p.title).map((x, k) => ({raw: x.raw, p: {...packParsed({...x.p, remind: this.remindOn('cap', lines)}), ...nest && k && {position: k * SPACING}}, taskId: null, done: false, linked: false}));
    const photos = this.capPhotos.map(f => Alpine.raw(f));
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), nest, pid, items, files: photos.map(fileEntry)};
    this.cap.busy = true; this.cap.text = ''; this.cap.nest = false; this.capPhotos = [];
    if (this.cap.focus) this.$nextTick(() => this.$refs.capture.focus());   // to type the next one
    try {
      // Saved first, with its photos, and on screen at once, where it'll be: it looks waiting only if sending takes a while.
      const {kept, full} = await sync.add(entry, photos);
      this.refreshPending();
      const r = await sync.lock(() => this.sendEntry(entry.id));
      if (r.ids?.length) this.flash(r.ids);
      this.refreshPending();                                                // its waiting row, and the row sent, swapped at once
      this.placeSent(r.tasks || []);
      /* Added, the new rows light up in the list, and nothing more is said: unless they aren't on this screen (a task due
         next month, added on Today; one for another project), when the add box says where they went, with Open. What
         didn't go as asked, or couldn't be added, is said there too. */
      const n = items.length, np = photos.length, cap = {place: 'cap'}, err = {place: 'cap', cls: 'failed'};
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      const open = {label: 'Open', fn: () => this.openTask(r.ids[0])};
      if (r.status === 'offline') {
        // It shows up in the list, tinted, unless this list wouldn't include it (say, a task due next month on Today).
        this.refreshPending();
        sync.keep();
        if (!kept) this.say(full ? NO_ROOM : NOT_KEPT, err);
        else if (np && r.ids.length === n)            // the task got there; its photos are still to go
          this.say(`Added to ${this.projById.get(r.projectId)?.title || 'its project'}. ${np === 1 ? 'The photo uploads' : 'The photos upload'} when the connection's back.`, {...cap, action: open});
        else if (np) this.say(`Saved offline, with ${np === 1 ? 'the photo' : np + ' photos'}. ${n === 1 && np === 1 ? 'Both go' : 'They all go'} to Vikunja when you're back online.`, cap);
        else if (!this.pendingTasks.some(t => t.entry === entry.id && this.pendingPlace(t)))
          this.say(`Saved offline. ${n === 1 ? 'It goes' : 'They go'} to Vikunja when you're back online.`, cap);
      } else if (r.status === 'error') {
        this.cap.text = r.unsent.join('\n');                                // keep what wasn't added
        this.capPhotos = r.photos;
        const undo = r.ids.length ? {label: 'Undo', fn: () => this.deleteTasks(r.ids)} : null;
        this.say(r.ids.length ? `Added ${r.ids.length} of ${n}${but}. Stopped: ${r.error.message}` : 'Not added: ' + r.error.message, {...err, action: undo});
      } else if (r.status === 'sent') {
        const away = (r.tasks || []).filter(t => !this.pendingPlace(t));
        if (away.length || but) this.say(addedWhere({n, nest, project: this.projById.get(r.projectId)?.title, due: items[0].p.due, photos: r.uploaded, but}),
          {...(but ? err : cap), action: away.length ? {label: 'Open', fn: () => this.openTask(away[0].id)} : null});
      }                                                                     // gone: another tab sent it, and its rows show
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
    if (entry.kind === 'step') return this.sendStep(entry);
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
        const t = await this.readTask(target).catch(() => null);
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
      // On a project's list, a new task goes first, where Vikunja puts it, until the list is read again.
      if (g && this.route.name === 'project' && this.view.listView && !child && !t.parent)
        this.positions[t.id] = Math.min(2 * SPACING, ...g.tasks.map(x => this.positions[x.id]).filter(p => p > 0)) / 2;
      // A subtask was sent with its place among its siblings, which Vikunja keeps.
      else if (g && this.view.listView && t.position > 0) this.positions[t.id] = t.position;
      if (g) g.tasks.push(this.keep(t));
      else this.view.groups.push({...(this.route.name === 'today' ? todayGroups().find(x => x.key === key) : {key, cls: '', title: 'Open'}), tasks: [this.keep(t)]});
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
        const all = sync.all(this.user?.id), stopped = heldTasks(all);        // and behind one turned down, those on its task
        for (const e of all) {
          if (e.failed || held(e) || (e.kind === 'act' && (actsWait || stopped.has(e.task)))) continue;
          const r = await this.sendEntry(e.id);
          if (e.kind === 'act' && r.status === 'offline') actsWait = true;
          if (r.kept) stopped.add(e.task);
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
    if (open && tasks.some(t => t.parent === open)) this.readTask(open).then(t => {
      if (!t) return;
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
      // Said by the box it's back in: quick add's, or the subtask box in its task's sheet.
      this.say(`${subs.length ? 'A subtask' : 'A task'} added offline couldn't be added: ${failed[0].error.message}. It's back in the box.`, {place: back.length ? 'cap' : 'sheet:subtasks', cls: 'failed'});
    } else if (other.length) this.notify(`${other[0].error.what || 'Something done offline'} couldn't be sent: ${other[0].error.message}.` + (other[0].kept ? KEPT : this.wordsBack(other[0].error)));
    else if (problems.length) this.notify('Sent what was waiting, but ' + problems.join('; '));
    if (sent || failed.length || other.length) this.render();
  },

  /* ---------- what's waiting to be sent ---------- */
  // What's waiting, and what Vikunja turned down (kept to try again or drop). It's on screen at once; it looks waiting,
  // and the header's button says so, only once it has waited a while (markSlow).
  refreshPending(){
    const all = this.user ? sync.all(this.user.id) : [];
    this.pending = all.filter(e => !e.failed && !sync.held.has(e.id)); this.failed = all.filter(e => e.failed);
    this.unsent = this.user ? all.length : null;
    // Tasks being deleted, unless Vikunja turned it down: off every list until they're gone (but rows deleted in place,
    // leaving.js), or back with Restore or Undo.
    this.deleting = all.filter(e => e.op === 'delete' && !e.failed).flatMap(e => e.ids);
    this.markSlow();
  },
  // What has waited long enough to look waiting (slowness), worked out again when the next will have. Once it looks
  // waiting, it does until it's sent.
  markSlow(){
    clearTimeout(waitTimer);
    const was = new Set(this.slow), still = this.pending.filter(e => was.has(e.id)).map(e => e.id);
    const {slow: more, next} = slowness(this.pending.filter(e => !was.has(e.id)), Date.now(), this.offline), slow = [...still, ...more];
    if (slow.join() !== this.slow.join()) this.slow = slow;
    this.waitShown = slow.length > 0;
    if (next !== null) waitTimer = setTimeout(() => this.markSlow(), next - Date.now());
  },
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
        out.push({id: `pending-${e.id}-${i}`, pending: true, waits: this.slow.includes(e.id), entry: e.id, index: i, child, parent: e.parent?.id ?? (child ? e.items[0].taskId || `pending-${e.id}-0` : null), title: p.title, done: false, priority: p.priority || 0, position: p.position || 0,
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
    if (r.name === 'project') return t.project_id === r.id ? 'open' : null;
    if (r.name !== 'today') return null;
    // A subtask only once it's loaded, on its task's card (cards.js): Today never shows one as a row of its own.
    if (t.child || t.parent) return null;
    if (!isSet(t.due_date)) return 'nodate';
    const d = new Date(t.due_date), t0 = startOfDay();
    return d >= addDays(t0, 8) ? null : isLate(t.due_date) ? 'overdue' : d < addDays(t0, 1) ? 'today' : 'week';
  },
  /* The current list, with waiting tasks added where they belong, and subtasks under their parents: a project's open
     tasks in its List view's order. Each group has what a finger can do on its rows on this screen (screenRows), and,
     where it has cards (not a list of done tasks), what it shows (`items`: listItems, each a row or a card). */
  get listGroups(){
    const hidden = this.hiddenRows, order = this.route.name === 'project' ? positionOrder(this.positions) : null, can = screenRows(this.route.name);
    return this.listBase.map(g => {
      const out = {...g, ...can, ...nestSubtasks(g.tasks.filter(t => !hidden.has(t.id)), g.key === 'open' ? order : null)};
      if (g.key === 'done') out.cards = null;
      if (out.cards) out.items = listItems(out.tasks, out.depth, t => !!this.cardOf(t, out));
      return out;
    });
  },
  get listBase(){
    const extra = this.pendingTasks.map(t => [this.pendingPlace(t), t]).filter(([k]) => k);
    let base = this.view.groups;
    if (this.route.name === 'today') {
      // Every group, even in a list saved offline before "Added today, no date" existed, and in one saved yesterday only
      // today's additions (a card's, by what brought it).
      const t0 = startOfDay(), at = todayAt(this.view.cards);
      base = todayGroups().map(g => {
        const b = base.find(x => x.key === g.key) || g;
        return g.key === 'nodate' ? {...b, tasks: b.tasks.filter(t => new Date(at(t).created) >= t0)} : b;
      });
    } else if (!extra.length) return base;
    if (!base.length && this.route.name === 'project' && this.view.project) base = [{key:'open', cls:'', title:'Open', tasks:[]}];
    // Today's in each group's own order (a project's are put in its List view's by listGroups).
    const order = this.route.name === 'today' ? todayOrder(todayAt(this.view.cards)) : {};
    return base.map(g => {
      const tasks = [...g.tasks, ...extra.filter(([k]) => k === g.key).map(([, t]) => t)];
      return {...g, tasks: order[g.key] ? tasks.sort(order[g.key]) : tasks};
    });
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
    // Said by the box its words went back to: quick add's, or the subtask box in its parent's sheet.
    const place = !parent ? 'cap' : this.sheet.task?.id === parent.id ? 'sheet:subtasks' : null;
    if (sent) { this.say('It was sent before it could be cancelled.', {place}); this.render(); return; }
    const box = parent ? (this.sheet.task?.id === parent.id ? this.sheet.sub : null) : this.cap;
    if (raw && box) box.text = [box.text.trim(), raw].filter(Boolean).join('\n');
    this.say(['Cancelled.', raw && box && 'It\'s back in the box.', rest && `The ${rest} line${rest === 1 ? '' : 's'} under it ${rest === 1 ? 'is' : 'are'} now ${rest === 1 ? 'a task' : 'tasks'} of ${rest === 1 ? 'its' : 'their'} own.`].filter(Boolean).join(' '), {place});
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
