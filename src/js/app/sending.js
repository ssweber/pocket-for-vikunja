// Send what was added through the outbox, and show the "Waiting to send" rows until it reaches Vikunja.
import {cache, raw, userCache, ZERO} from '../util.js';
import {api, ApiError, items, opening, passing, seenToken, sharedToken, TRANSIENT, triedSince} from '../api.js';
import {isSet, startOfDay} from '../dates.js';
import {addedWhere, cancelName, doneText} from '../messages.js';
import {patiently} from '../checklists.js';
import {parseCapture} from '../quickadd.js';
import {entryDone, fileEntry, held, heldTasks, isChild, itemDone, itemsOf, KEPT, LINE_STEPS, NO_ROOM, NOT_KEPT, randomId, slowness, sync, underOf, unpackParsed} from '../sync.js';
import {dayGroup, intoGroup, intoKeys, keptGroups, listItems, nestSubtasks, sameGroup, saved, screenRows, todayAt, todayGroups, todayOrder, viewKey} from '../lists.js';
import {positionOrder, SPACING} from '../order.js';

let waitTimer;
const lastGroups = new Map();                    // each group as listGroups last returned it, by key
// The job for each line: the earlier try's job if the line is unchanged, else a new one.
export const jobsFor = (kept, lines) => lines.map((line, k) => kept[k]?.line === line ? kept[k] : {line, at: new Date().toISOString()});

export default {
  /* Create a task from a parsed line, one step at a time (LINE_STEPS). `job` records how far each step got, and
     `save` stores the job. For a line in the outbox, the job is the outbox item. `made` is called as soon as the task
     exists. `parent` makes the task a subtask of that task. Returns the task, which is just {id, project_id} if an
     earlier try made it. It has `problems` (what couldn't be done, such as an @username who can't see the project)
     and, for a line marked done or given a percentage, `arrived`: {now: Vikunja's copy after that was set, done}.
     Throws on a lost connection or a busy Vikunja. */
  async createTask(parsed, pid, {job = {}, save = async () => {}, made, at, skip, parent} = {}){
    job.problems ||= [];
    job.key ||= randomId();                      // identifies this line in the record of which task was added for it
    const c = {parsed, pid, save, made, at, skip, parent};
    if (!itemDone(job, !!parent)) {
      // A busy Vikunja (on SQLite, "database is locked") is retried a few times. Each step records how far it got.
      for (const step of LINE_STEPS) while (!step.done(job, c)) { await patiently(() => step.run(job, c)); await save(); }
      job.done = true; await save();
    }
    return Object.assign(c.task || {id: job.taskId, project_id: job.projectId}, {problems: job.problems}, c.arrived && {arrived: c.arrived});
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
  /* Create one task per line, in order. With `parent`, each becomes a subtask of it, in the parent's project unless
     the line names one. Returns the ids created and how many lines were used, and stops at the first error. `jobs`
     (from jobsFor) records how far each line got, so a retry carries on. A task whose reply was lost is found, not
     added twice. `ignores` holds the chips tapped off for each line, on top of `ignore`. */
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
  /* Everything typed in quick add goes through the outbox: online it is sent straight away, offline it waits. */
  async submitCapture(){
    const lines = this.capLines, parsed = this.parsed;
    if (!parsed.title || this.cap.busy) return;
    // A single task can go to the project picked for its @usernames. A pasted list goes to the default project.
    const pid = lines.length === 1 ? this.boxPid('cap') : this.defaultProjectId();
    const first = parsed.project?.id || pid;
    if (!first) { this.say('Create a project in Vikunja first', {place: 'cap', cls: 'failed'}); return; }
    if (!this.canWrite(first)) { this.say(`${this.projById.get(first)?.title || 'That project'} is read only. Type +project to pick another project.`, {place: 'cap', cls: 'failed'}); return; }
    // Parse every line now, so dates mean what they meant when typed. Each line records which line it is under. Lines
    // under another line get positions in the project's List view, each after the line before it, because Vikunja
    // would otherwise put each new one first. When the box has been moved out a level (boxOut, quickadd.js), the
    // top-level lines go where the box is. That is after the task the box was moved out from and everything under it,
    // each after the line before it.
    const places = this.boxOut && first === this.view.project?.id ? this.outPlaces(itemsOf(this.boxItems('cap')).filter(x => x.under === null).length) : null;
    let top = 0;
    const items = itemsOf(this.boxItems('cap'), (k, under) => under !== null ? {position: k * SPACING} : places && {position: places[top++]}), subs = items.filter(x => x.under !== null).length;
    const photos = this.capPhotos.map(f => Alpine.raw(f));
    const entry = {id: randomId(), user: this.user?.id, at: new Date().toISOString(), nest: false, pid, items, files: photos.map(fileEntry)};
    if (this.boxOut) this.aimAddedOut(entry, items.findLastIndex(x => x.under === null));   // the box moves under the last of them
    this.cap.busy = true; this.cap.text = ''; this.cap.nest = false; this.cap.flat = false; this.capPhotos = [];
    if (this.cap.focus) this.$nextTick(() => this.$refs.capture.focus());   // so the user can type the next one
    try {
      // Save it first, with its photos, and show it at once where it will land. It looks waiting only if sending takes a while.
      const {kept, full} = await sync.add(entry, photos);
      this.refreshPending();
      const r = await sync.lock(() => this.sendEntry(entry.id));
      if (r.ids?.length) this.flash(r.ids);
      this.refreshPending();                                                // swap the waiting row for the sent one at once
      this.placeSent(r.tasks || []);
      /* New rows flash in the list when they are added, and no message is shown. The exception is tasks that aren't on
         this screen (a task due next month added on Today, or a task for another project). Then the add box shows
         where they went, with an Open button. It also shows anything that didn't go as asked or couldn't be added. */
      const n = items.length, np = photos.length, cap = {place: 'cap'}, err = {place: 'cap', cls: 'failed'};
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      const open = {label: 'Open', fn: () => this.openTask(r.ids[0])};
      if (r.status === 'offline') {
        // The task shows in the list as waiting, unless this list wouldn't include it (such as a task due next month on
        // Today).
        this.refreshPending();
        sync.keep();
        if (!kept) this.say(full ? NO_ROOM : NOT_KEPT, err);
        else if (np && r.ids.length === n)            // the task was added, and its photos are still waiting
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
        if (away.length || but) this.say(addedWhere({n, subs, project: this.projById.get(r.projectId)?.title, due: items[0].p.due, photos: r.uploaded, but}),
          {...(but ? err : cap), action: away.length ? {label: 'Open', fn: () => this.openTask(away[0].id)} : null});
      }                                                                     // status 'gone': another tab sent it and its rows already show
    } finally {
      this.cap.busy = false;
      this.refreshPending();
      this.render();
    }
  },
  /* Send one outbox entry, carrying on where an earlier try stopped. Returns {status: sent|offline|error|gone, ...}
     with the ids of its tasks, the tasks created this time, and how many files were uploaded. `offline` means the entry
     is kept to try again. `reached` means Vikunja answered, but not usefully yet (busy, or a server error on a file). */
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
        // A line goes under the line it names, which is always an earlier line and was made before it, or else under
        // the entry's parent task. `was` is the id the line's waiting row had (pendingTasks), so the add box's cursor
        // can move from that row to the task (aimSent).
        const u = underOf(entry, i), over = u === null ? null : entry.items[u], child = isChild(entry, i), under = over ? over.taskId : entry.parent?.id ?? null;
        const t = await this.createTask(unpackParsed(item.p), entry.parent ? entry.parent.project_id : over ? over.projectId ?? entry.parentProject : entry.pid, {
          job: item, save, at: entry.at, skip: taken, parent: under,
          made: t => { taken.add(t.id); tasks.push({...t, child, parent: under, was: `pending-${entry.id}-${i}`, place: item.p.position || 0}); if (i === 0) entry.parentProject = t.project_id; }});
        // A task that arrived done, or with progress, shows that on its row (placeSent).
        if (t.arrived) for (const x of tasks) if (x.id === t.id) x.arrived = t.arrived;
        ids.push(item.taskId);
      }
      // A line with lines under it gets its progress from them, if any of them arrived done or with progress. This is
      // written once they are all added, deepest first, because each line's progress counts in the line above it.
      for (let i = entry.items.length - 1; i >= 0; i--) {
        const x = entry.items[i];
        if (x.figured || !entry.items.some((k, j) => underOf(entry, j) === i && (k.p.done || k.p.pct > 0 || k.figured))) continue;
        await this.writeFigure(x.taskId); x.figured = true; await save();
      }
      // Subtasks added to a task lower the task's calculated progress, so it is written once they are added.
      if (entry.parent && !entry.figured) { await this.writeFigure(entry.parent.id); entry.figured = true; await save(); }
      // Then the photos and files, to the task they were added to.
      const target = entry.taskId || entry.items[0]?.taskId, files = (entry.files || []).filter(f => !f.sent);
      if (files.length) { this.placeSent(tasks); this.refreshPending(); }    // the task shows while its photos upload
      for (const f of files) if (await this.sendFile(entry, target, f)) uploaded++;
      await sync.remove(entry.id);
      if (files.length) {
        this.refreshPending();
        // Read the task again with its new attachments, for its row and its sheet.
        const t = await this.readTask(target).catch(() => null);
        if (t) {
          cache.set(t.id, t); this.syncTask(t);
          for (const x of tasks) if (x.id === t.id) Object.assign(x, t);
          if (this.sheet.task?.id === t.id) { this.showTask(t); this.sheet.dirty = true; }
          const step = this.view.run?.steps.find(s => s.id === t.id);           // a photo added to a checklist step
          if (step) step.attachments = t.attachments || [];
        }
      }
      return {status: 'sent', ids, tasks, problems: all(), uploaded, projectId: entry.parentProject};
    } catch (error) {
      // Keep the entry for later when there is no connection, Vikunja is busy, or the user is signed out.
      if (passing(error) || error.again || (error instanceof ApiError && error.status === 401))
        return {status: 'offline', reached: error instanceof ApiError && error.status !== 401, ids, tasks, problems: all(), uploaded, projectId: entry.parentProject};
      // Photos added with a task that couldn't be added go back to the add box with it.
      const photos = (await Promise.all((entry.files || []).filter(f => !f.sent).map(f => sync.file(f.key)))).filter(Boolean);
      await sync.remove(entry.id);
      return {status: 'error', ids, tasks, problems: all(), error, photos, unsent: entry.items.filter(x => !x.taskId).map(x => x.raw), parent: entry.parent || null};
    }
  },
  // Upload one waiting file, unless an earlier try that was cut off already uploaded it. A file Vikunja rejects (for
  // example because it is too big, or the task is gone) is reported and dropped. After a server error the file is
  // kept to try again, and `trouble` makes its row show that. `sent` marks the file as dealt with. Returns whether
  // the file is on the task.
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
          // Vikunja answers OK even when it rejects a file, and puts the reasons in `errors`.
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
  // Whether the file was already uploaded to the task since the entry was added.
  async hasAttachment(taskId, f, at){
    const t = await api('/tasks/' + taskId), since = triedSince(f.triedAt, at);
    return (t?.attachments || []).some(a => a.file?.name === f.name && a.file?.size === f.size && new Date(a.created).getTime() >= since);
  },
  // Put tasks that just reached Vikunja into the list on screen, where they belong, without waiting for the list to
  // reload. On a patchy connection the reload can fail, and the list would otherwise stay as it was, without them.
  placeSent(tasks){
    this.aimSent(tasks);                         // the add box's cursor follows a task from its waiting row (quickadd.js)
    if (this.view.loading || this.view.route !== location.hash) return;
    let placed = false;
    for (const {child, problems, arrived, was, place, ...t} of tasks) {
      // A subtask sent with a position among its siblings keeps that position, wherever it was added, including from
      // a card on Today.
      if (t.parent && place > 0) this.positions[t.id] = t.position > 0 ? t.position : place;
      const key = this.pendingPlace({...t, child});
      if (!key || this.view.groups.some(g => g.tasks.some(x => x.id === t.id))) continue;
      // A task marked done, or given a percentage, shows that on its row. A repeating task shows as done, as it was
      // created, until the batch clears (arrivedDone).
      const now = arrived?.now;
      if (now) Object.assign(t, arrived.done && !now.done ? {done: true} : {done: now.done, done_at: now.done_at, percent_done: now.percent_done, updated: now.updated});
      const g = this.view.groups.find(g => g.key === key);
      // On a project's list a new task goes first, where Vikunja puts it, until the list is read again. The exception
      // is a task sent with its own position (`place`, from a box moved out a level), which Vikunja keeps.
      if (g && this.route.name === 'project' && this.view.listView && !child && !t.parent && place > 0) this.positions[t.id] = place;
      else if (g && this.route.name === 'project' && this.view.listView && !child && !t.parent)
        this.positions[t.id] = Math.min(2 * SPACING, ...g.tasks.map(x => this.positions[x.id]).filter(p => p > 0)) / 2;
      // A subtask keeps the position it was sent with.
      else if (g && this.view.listView && t.position > 0) this.positions[t.id] = t.position;
      if (g) g.tasks.push(this.keep(t));
      else this.view.groups.push({...(this.route.name === 'today' ? todayGroups().find(x => x.key === key) : {key, cls: '', title: 'Open'}), tasks: [this.keep(t)]});
      if (arrived?.done) this.arrivedDone(this.tasks[t.id], now);
      placed = true;
    }
    // Also update the copy kept for opening offline.
    const k = viewKey(this.route), s = saved.get(k);
    if (placed && s) saved.set(k, {...s, groups: keptGroups(this.view.groups)});
  },
  /* A task that arrived done (its line was marked done in quick add) is ticked on its row and leaves with the batch,
     the same as a task the user ticks there (toggleDone, actions.js). It leaves Today, or moves to Done in a
     project. Tapping its tick before then opens it again.

     A repeating task is open again at its next date in `now`, Vikunja's copy. It shows as done, with the date it was
     given, until the batch clears. Then it shows as open at its next date, or leaves Today if that date is 8 or more
     days from today. Tapping its tick before then puts its date back. */
  arrivedDone(t, now){
    if (now.done) this.signTick(now);
    const said = doneText(0, 0, t.title), failed = e => this.say('Not undone: ' + e.message, {row: {id: t.id, stays: true, cls: 'failed'}});
    if (!now.done) {
      const was = t.due_date, beyond = () => this.route.name === 'today' && dayGroup(now.due_date) === null;
      const undo = async () => { try { Object.assign(t, await this.saveTask(t.id, {due_date: was})); } catch (e) { failed(e); } this.render(); };
      this.markRow(t.id, {kind: 'done', out: () => beyond() ? [t.id] : [], undo, said: said + '. It repeats',
        gone: () => { Object.assign(t, now); if (beyond()) this.removeRow(t.id); else if (this.route.name === 'today') this.regroupToday(); }});
      return;
    }
    const ids = [t.id], moves = () => !!this.searchGroups(t);
    this.markRow(t.id, {kind: 'done', ids, said, undo: async () => { await this.toggleDone(t, null, {quiet: true}); this.render(); },
      out: () => this.bothWays && !moves() ? [] : ids,
      gone: () => { if (this.bothWays) this.moveInSearch(t, ids); else if (t.done) { this.removeRow(t.id); this.intoDoneToday(ids); } }});
  },
  // Find the task that an earlier, cut-off try added, if it was added. It has the same title, is in this project, was
  // created by this user since that try, and is not one of the entry's other tasks or a task Pocket added for another
  // line.
  async findSent(title, project, triedAt, at, skip = new Set(), key){
    const list = items(await api('/tasks?q=' + encodeURIComponent(title)));
    const since = triedSince(triedAt, at);
    return list.find(t => t.title === title && t.project_id === project && t.created_by?.id === this.user?.id && !skip.has(t.id) && !sync.claimedByOther(t.id, key)
      && new Date(t.created).getTime() >= since) || null;
  },
  // Send whatever is waiting. Called when Pocket opens, comes back to the front, reconnects, and every 30 seconds.
  async flush(){
    if (opening) return;                         // Pocket is still opening on the saved screen, and boot sends what's waiting once Vikunja says who is signed in
    // In a shared session, nothing is sent until Pocket knows the session still belongs to this user.
    if (this.signedIn && this.user && sharedToken.get() !== seenToken) { this.sessionChanged(); return; }
    if (this.flushing || !this.signedIn || !this.user || !sync.all(this.user.id).length) return;
    this.flushing = true;
    let sent = 0; const failed = [], other = [], tasks = [], problems = [];
    try {
      await sync.lock(async () => {
        let actsWait = false;                                                 // after an act is kept offline, later acts wait behind it
        const all = sync.all(this.user?.id), stopped = heldTasks(all);        // acts on a task whose earlier act failed wait too
        for (const e of all) {
          if (e.failed || held(e) || (e.kind === 'act' && (actsWait || stopped.has(e.task)))) continue;
          const r = await this.sendEntry(e.id);
          if (e.kind === 'act' && r.status === 'offline') actsWait = true;
          if (r.kept) stopped.add(e.task);
          tasks.push(...(r.tasks || [])); problems.push(...(r.problems || []));
          if (r.status === 'offline' && !r.reached) break;                    // no connection, so the rest wait too
          if (r.status === 'sent') sent += r.ids.length + r.uploaded + (r.changed || 0);
          if (r.status === 'error') (r.unsent ? failed : other).push(r);
        }
      });
    } finally { this.flushing = false; this.refreshPending(); }
    this.placeSent(tasks);
    // Subtasks that waited to be sent for the task whose sheet is open now show in that sheet.
    const open = this.sheet.task?.id;
    if (open && tasks.some(t => t.parent === open)) this.readTask(open).then(t => {
      if (!t) return;
      cache.set(t.id, t);
      if (this.sheet.task?.id === t.id) { this.showTask(t); this.sheet.dirty = true; }
    }).catch(() => {});
    // Text that couldn't be added goes back into the box it came from: quick add, or the subtask box if the task's
    // sheet is open. Subtasks of a task whose sheet isn't open are named in the message instead, so they aren't lost.
    const subs = failed.filter(f => f.parent), lost = subs.filter(f => this.sheet.task?.id !== f.parent.id), back = failed.filter(f => !f.parent);
    for (const f of subs) if (!lost.includes(f)) this.sheet.sub.text = [this.sheet.sub.text, ...f.unsent].filter(Boolean).join('\n');
    if (back.length) {
      this.cap.text = [this.cap.text, ...back.flatMap(f => f.unsent)].filter(Boolean).join('\n');
      this.capPhotos = [...this.capPhotos, ...back.flatMap(f => f.photos)];
    }
    if (lost.length) {
      const f = lost[0], loose = (f.tasks || []).map(t => `“${t.title}”`);
      this.notify(`Subtasks of “${f.parent.title}” added offline couldn't be added under it: ${f.error.message}.`
        + (loose.length ? ` ${loose.join(', ')} ${loose.length === 1 ? 'is now its own task' : 'are now their own tasks'}.` : '')
        + (f.unsent.length ? ` Not added: ${f.unsent.join('; ')}.` : ''));
    } else if (failed.length) {
      // The message shows in the box the text went back to: quick add, or the subtask box in the task's sheet.
      this.say(`${subs.length ? 'A subtask' : 'A task'} you added offline couldn't be saved: ${failed[0].error.message}. Its text is back in the add box.`, {place: back.length ? 'cap' : 'sheet:subtasks', cls: 'failed'});
    } else if (other.length) this.notify(`${other[0].error.what || 'A change made offline'} couldn't be sent: ${other[0].error.message}.` + (other[0].kept ? KEPT : this.wordsBack(other[0].error)));
    else if (problems.length) this.notify('Sent what was waiting, but ' + problems.join('; '));
    if (sent || failed.length || other.length) this.render();
  },

  /* ---------- what's waiting to be sent ---------- */
  // Sort the outbox into entries that are waiting and entries Vikunja rejected (kept to retry or drop). A waiting task
  // shows on screen at once. It looks waiting, and the header's button says so, only after it has waited a while
  // (markSlow).
  refreshPending(){
    const all = this.user ? sync.all(this.user.id) : [];
    this.pending = all.filter(e => !e.failed && !sync.held.has(e.id)); this.failed = all.filter(e => e.failed);
    this.unsent = this.user ? all.length : null;
    // Tasks being deleted stay out of every list until the delete is sent, or until Restore or Undo brings them back.
    // If Vikunja rejects the delete, they come back. leaving.js handles rows deleted in place.
    this.deleting = all.filter(e => e.op === 'delete' && !e.failed).flatMap(e => e.ids);
    this.keyWaiting();
    this.markSlow();
  },
  /* What is waiting for each task, by task id (`waiting`): its last claim or unclaim, its last tick or untick, its last
     progress, and how many photos and files wait to upload. Each key is written separately (intoKeys) when the outbox changes, so a row that reads its own
     task's entry (peopleOf, rowMeta) redraws only when that entry changes. Without this, every row searched the
     whole outbox whenever anything in it changed, and adding a task to a long list made every row search it twice. */
  keyWaiting(){
    const claims = {}, files = {}, ticks = {}, pcts = {};
    for (const e of this.pending) {
      if (e.kind === 'act' && (e.op === 'claim' || e.op === 'unclaim')) claims[e.task] = e.op;
      if (e.kind === 'act' && ['done', 'doneNote', 'skip', 'undone'].includes(e.op)) ticks[e.task] = e.op !== 'undone';
      if (e.kind === 'act' && e.op === 'progress') pcts[e.task] = e.pct;
      const id = e.taskId || e.items?.[0]?.taskId;
      if (id) for (const f of e.files || []) if (!f.sent && !this.dropping.includes(f.key)) files[id] = (files[id] || 0) + 1;
    }
    intoKeys(this.waiting.claims, claims, raw); intoKeys(this.waiting.files, files, raw);
    intoKeys(this.waiting.ticks, ticks, raw); intoKeys(this.waiting.pcts, pcts, raw);
  },
  // Decide which entries have waited long enough to look waiting (slowness), and schedule the next check for when
  // another entry will have. An entry that looks waiting keeps looking waiting until it is sent.
  markSlow(){
    clearTimeout(waitTimer);
    const was = new Set(this.slow), still = this.pending.filter(e => was.has(e.id)).map(e => e.id);
    const {slow: more, next} = slowness(this.pending.filter(e => !was.has(e.id)), Date.now(), this.offline), slow = [...still, ...more];
    if (slow.join() !== this.slow.join()) this.slow = slow;
    this.waitShown = slow.length > 0;
    if (next !== null) waitTimer = setTimeout(() => this.markSlow(), next - Date.now());
  },
  // The label of a waiting row's Cancel, which says what becomes of the lines waiting under it.
  cancelLabel(t){
    const e = this.pending.find(x => x.id === t.entry), up = e ? underOf(e, t.index) : null;
    return cancelName(t.title, e ? e.items.filter((x, i) => underOf(e, i) === t.index).length : 0, up !== null ? e.items[up].p.title : e?.parent?.title);
  },
  // Tasks still in the outbox, shaped like tasks so they can sit in the lists where they'll land once sent.
  get pendingTasks(){
    const out = [];
    for (const e of this.pending) {
      const parentProject = e.parent?.project_id || e.items[0]?.p.project?.id || e.pid;
      e.items.forEach((x, i) => {
        if (x.taskId) return;
        const p = x.p;
        // The parent is the line this line names. It is identified by that line's waiting-row id until that line is
        // sent, and by its task id after. If the line names none, the parent is the entry's parent task.
        const child = isChild(e, i), u = underOf(e, i), over = u === null ? e.parent?.id ?? null : e.items[u].taskId || `pending-${e.id}-${u}`;
        out.push({id: `pending-${e.id}-${i}`, pending: true, waits: this.slow.includes(e.id), entry: e.id, index: i, child, parent: over, title: p.title, done: !!p.done || p.pct >= 100, percent_done: (p.pct || 0) / 100, priority: p.priority || 0, position: p.position || 0,
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
    // A subtask is never a separate row on Today. It waits on its task's card, where it was added (cardRows, cards.js).
    return t.child || t.parent ? null : dayGroup(t.due_date);
  },
  /* The current list's groups, with waiting tasks added where they belong and subtasks nested under their parents. A
     project's open tasks are in List view order. Each group carries the gestures its rows allow on this screen
     (screenRows). A group with cards (every group except done tasks) also has `items`, each a row or a card
     (listItems). `before` is the number of rows above the group on the screen, so a long screen can be drawn a batch
     at a time (drawn, views.js). A group that is unchanged since the last call is returned as the same object
     (sameGroup), so its rows have nothing to redraw. */
  get listGroups(){
    const hidden = this.hiddenRows, order = this.route.name === 'project' ? positionOrder(this.positions) : null, can = screenRows(this.route.name);
    let before = 0;
    return this.listBase.map(g => {
      const out = {...g, ...can, ...nestSubtasks(g.tasks.filter(t => !hidden.has(t.id)), g.key === 'open' ? order : null), before};
      if (g.key === 'done') out.cards = null;
      // Done today's rows are plain rows with their count in the heading. A done task has no date to hold it to.
      if (g.key === 'donetoday') Object.assign(out, {cards: null, reschedule: false, count: out.tasks.length});
      if (out.cards) out.items = listItems(out.tasks, out.depth, t => !!this.cardOf(t, out));
      before += (out.cards ? out.items : out.tasks).length;
      const was = lastGroups.get(g.key);
      if (sameGroup(was, out)) return was;
      lastGroups.set(g.key, out);
      return out;
    });
  },
  /* The same groups, in the form the screen draws (screens/lists.html). Each group is one object that lasts as long as
     the screen does (`shown`, by the group's key). A new group is written into it (intoGroup, lists.js), changing
     only what differs, with depths and cards' subtasks updated one task at a time. Without this, a row leaving with
     the batch, or a row added, gave every row in the list a new group, and each row redrew completely. That took half
     a second on 660 rows, and seconds on a slow phone. Now only that one row is redrawn. */
  get shownGroups(){
    const r = this.route, at = r.name + ':' + (r.id ?? '');
    if (raw(this.shown).at !== at) this.shown = {at, groups: {}};
    const kept = this.shown.groups;
    return this.listGroups.map(g => {
      if (!raw(kept)[g.key]) kept[g.key] = {depth: {}, kids: new Map()};
      return intoGroup(kept[g.key], g, raw);
    });
  },
  get listBase(){
    const extra = this.pendingTasks.map(t => [this.pendingPlace(t), t]).filter(([k]) => k);
    let base = this.view.groups;
    if (this.route.name === 'today') {
      // Show every group, even in a list saved offline before the "Added today, no date" group existed. In a list
      // saved on an earlier day, that group keeps only tasks created today (for a card, judged by the task that
      // brought it), and Done today only tasks done today. A task just ticked may not have its time yet.
      const t0 = startOfDay(), at = todayAt(this.view.cards);
      base = todayGroups().map(g => {
        const b = base.find(x => x.key === g.key) || g;
        return g.key === 'nodate' ? {...b, tasks: b.tasks.filter(t => new Date(at(t).created) >= t0)}
          : g.key === 'donetoday' ? {...b, tasks: b.tasks.filter(t => !isSet(t.done_at) || new Date(t.done_at) >= t0)} : b;
      });
    } else if (!extra.length) return base;
    if (!base.length && this.route.name === 'project' && this.view.project) base = [{key:'open', cls:'', title:'Open', tasks:[]}];
    // Each of Today's groups has its own order. listGroups puts a project's tasks in List view order.
    const order = this.route.name === 'today' ? todayOrder(todayAt(this.view.cards)) : {};
    return base.map(g => {
      const tasks = [...g.tasks, ...extra.filter(([k]) => k === g.key).map(([, t]) => t)];
      return {...g, tasks: order[g.key] ? tasks.sort(order[g.key]) : tasks};
    });
  },
  /* Cancel one waiting task. Its text goes back into the box it was added from, to change or add again. The lines
     under it move up to what the cancelled task was under, and the message says so. If the cancelled task was under
     nothing, those lines become separate tasks. Cancelling the first line of a pasted list does this. The photos added
     with it are dropped too. */
  async cancelPending(entryId, index){
    let raw = '', rest = 0, over = '', parent = null, sent = false;
    await sync.lock(async () => {
      const e = await sync.fresh(entryId);
      if (!e || !e.items[index] || e.items[index].taskId) { sent = true; return; }   // sent while this call waited for the lock
      raw = e.items[index].raw.trim(); parent = e.parent || null;
      // Record which line each line is under now. After this line is removed, every later line has an index one lower.
      const was = e.items.map((x, i) => underOf(e, i)), up = was[index];
      rest = was.filter(u => u === index).length; over = up !== null ? e.items[up].p.title : parent?.title || '';
      e.items.forEach((x, i) => { const u = was[i] === index ? up : was[i]; x.under = u === null ? null : u - (u > index ? 1 : 0); });
      e.items.splice(index, 1); e.nest = false;
      let drop = [];
      if (index === 0) { drop = (e.files || []).map(f => f.key); e.files = []; }
      await sync.save(e, drop);
      if (entryDone(e)) await sync.remove(e.id);
    });
    this.refreshPending();
    if (!sent) this.aimCancelled(entryId, index);  // the add box's cursor adjusts to the cancelled line (aimCancelled, quickadd.js)
    // The message shows in the box the text went back to: quick add, or the subtask box in the parent's sheet.
    const place = !parent ? 'cap' : this.sheet.task?.id === parent.id ? 'sheet:subtasks' : null;
    if (sent) { this.say('It was sent before it could be cancelled.', {place}); this.render(); return; }
    const box = parent ? (this.sheet.task?.id === parent.id ? this.sheet.sub : null) : this.cap;
    if (raw && box) box.text = [box.text.trim(), raw].filter(Boolean).join('\n');
    const lines = `The ${rest} line${rest === 1 ? '' : 's'} under it ${rest === 1 ? 'is' : 'are'} now `;
    this.say(['Cancelled.', raw && box && 'It\'s back in the box.', rest && lines + (over ? `under “${over}”.` : `${rest === 1 ? 'its own task' : 'their own tasks'}.`)].filter(Boolean).join(' '), {place});
  },
  // Cancel the upload of a waiting photo or file. Its row disappears at once, but an upload already running finishes
  // first.
  async cancelFile(entryId, key){
    this.dropping.push(key); this.keyWaiting();
    await sync.lock(async () => {
      const e = await sync.fresh(entryId); if (!e) return;
      const was = e.files.length;
      e.files = e.files.filter(f => f.key !== key || f.sent);
      if (e.files.length === was) return;                                    // already uploaded while waiting
      await sync.save(e, [key]);
      if (entryDone(e)) await sync.remove(e.id);
    });
    this.dropping = this.dropping.filter(k => k !== key);
    this.refreshPending();
  },
};
