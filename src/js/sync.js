// Sending to Vikunja: what's waiting, kept on the phone, and the steps each kind of change is sent in.
import {andList, app, ZERO} from './util.js';
import {api, ApiError, passing, patchTask} from './api.js';
import {DONE_MARK, isTemplateLabel, nextAfter, notesOnly, patiently, placeBefore, SKIP_MARK, stepOrder, stepsOf, vikunjaNext, withAdded, withOrder, withRunMark, withStepLine} from './checklists.js';
import {repeats} from './dates.js';
import {removeAssignee} from './quickadd.js';

/* Everything waiting to go to Vikunja: tasks added without a connection (or whose sending was cut off), and photos and
   files. Each entry is one capture, a task or a pasted list, or subtasks added to a task from its sheet (parent), or the
   files added to a task from its sheet (taskId):
   {id, user, at, nest, pid, parent: {id, project_id, title}, items: [{raw, p, ...its steps}], files: [{key, name, size, type, ...}], taskId}.
   p is the line as parsed when it was typed, so "tomorrow" keeps meaning the day after it was typed.
   It all lives in the browser's database (IndexedDB): the entries, the files' bytes, and the tasks Pocket has added.
   An entry and its files are saved together or not at all. The screen reads a copy kept in memory (`entries`), and
   sending always starts from the database's copy, so two tabs never work from an old one. If the database can't be
   used, or the phone has no room, an entry waits in memory only, and Pocket says to keep it open. */
export const sync = {
  entries: new Map(),                            // id -> entry, as the screen shows them
  volatile: new Set(),                           // ids of entries kept in memory only
  bytes: new Map(),                              // key -> File, for files kept in memory only
  claimed: new Map(),                            // task id -> {key, at}: see claim()
  db: null, asked: false,
  channel: 'BroadcastChannel' in self ? new BroadcastChannel('pocket-sync') : null,

  open(){
    return this.db ||= new Promise((ok, no) => {
      const r = indexedDB.open('pocket', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', {keyPath: 'id'});
        if (!db.objectStoreNames.contains('claims')) db.createObjectStore('claims', {keyPath: 'id'});
      };
      // A newer Pocket in another tab may need to upgrade it: let go, so that tab isn't kept waiting.
      r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); ok(r.result); };
      r.onerror = () => no(r.error);
    });
  },
  // One transaction over `stores`: resolves with what `fn` returns once it's committed, rejects if it isn't.
  async tx(stores, mode, fn){
    const db = await this.open();
    return new Promise((ok, no) => {
      const t = db.transaction(stores, mode), get = n => t.objectStore(n);
      let out;
      t.oncomplete = () => ok(out instanceof IDBRequest ? out.result : out);
      t.onerror = t.onabort = () => no(t.error || new DOMException('aborted', 'AbortError'));
      try { out = fn(get); } catch (e) { try { t.abort(); } catch {} no(e); }
    });
  },
  // Load what's waiting, moving over anything an older Pocket kept in localStorage.
  async start(){
    const old = (() => { try { return JSON.parse(localStorage.getItem('pocket.outbox') || '[]'); } catch { return []; } })();
    const oldClaims = (() => { try { return JSON.parse(localStorage.getItem('pocket.claims') || '[]'); } catch { return []; } })();
    try {
      if (old.length || oldClaims.length) {
        await this.tx(['outbox', 'claims'], 'readwrite', s => {
          for (const e of old) s('outbox').put(e);
          for (const [id, c] of oldClaims) s('claims').put({id, ...c});
        });
      }
      localStorage.removeItem('pocket.outbox'); localStorage.removeItem('pocket.claims');
      await this.reload();
      const day = Date.now() - 86400000;
      const claims = await this.tx(['claims'], 'readonly', s => s('claims').getAll());
      for (const c of claims) if (c.at > day) this.claimed.set(c.id, c);
      this.tx(['claims'], 'readwrite', s => { for (const c of claims) if (c.at <= day) s('claims').delete(c.id); }).catch(() => {});
    } catch {
      for (const e of old) { this.entries.set(e.id, e); this.volatile.add(e.id); }   // no database: they wait in memory
    }
    this.channel?.addEventListener('message', async () => { await this.reload().catch(() => {}); app?.refreshPending(); });
  },
  // The database's entries, plus those kept in memory only.
  async reload(){
    const list = await this.tx(['outbox'], 'readonly', s => s('outbox').getAll());
    const keep = [...this.volatile].map(id => this.entries.get(id)).filter(Boolean);
    this.entries = new Map([...list, ...keep].map(e => [e.id, e]));
  },
  changed(){ this.channel?.postMessage('changed'); },
  // This person's entries, oldest first, so things are sent in the order they were done (a tick, then its untick).
  all(user){ return [...this.entries.values()].filter(e => e.user === user).sort((a, b) => a.at.localeCompare(b.at) || (a.n || 0) - (b.n || 0)); },

  // A new entry, with its files: saved together. Returns {kept, full}: whether it's in the database, and if not,
  // whether that's because the phone has no room.
  async add(entry, files){
    this.entries.set(entry.id, entry);
    try {
      const data = await Promise.all(files.map(async f => ({name: f.name, type: f.type, data: await f.arrayBuffer()})));
      await this.tx(['files', 'outbox'], 'readwrite', s => {
        data.forEach((d, i) => s('files').put(d, entry.files[i].key));
        s('outbox').put(plain(entry));
      });
      this.changed();
      return {kept: true};
    } catch (e) {
      this.volatile.add(entry.id);
      files.forEach((f, i) => this.bytes.set(entry.files[i].key, f));
      return {kept: false, full: e?.name === 'QuotaExceededError'};
    }
  },
  // Progress on an entry, and the bytes of any of its files that are done with (`drop`), in one go.
  async save(entry, drop = []){
    this.entries.set(entry.id, entry);
    for (const k of drop) this.bytes.delete(k);
    if (this.volatile.has(entry.id)) return;
    try {
      await this.tx(['files', 'outbox'], 'readwrite', s => { for (const k of drop) s('files').delete(k); s('outbox').put(plain(entry)); });
      this.changed();
    } catch { this.volatile.add(entry.id); }                                 // no room for it now: keep it in memory
  },
  async remove(id){
    const e = this.entries.get(id), keys = (e?.files || []).map(f => f.key);
    this.entries.delete(id); this.volatile.delete(id);
    for (const k of keys) this.bytes.delete(k);
    try { await this.tx(['files', 'outbox'], 'readwrite', s => { for (const k of keys) s('files').delete(k); s('outbox').delete(id); }); this.changed(); }
    catch {}
  },
  async drop(fn){ for (const e of [...this.entries.values()]) if (fn(e)) await this.remove(e.id); },
  // The entry to send from: the database's copy, which another tab may have moved on (or sent: then null).
  async fresh(id){
    if (this.volatile.has(id)) return this.entries.get(id) || null;
    try {
      const e = await this.tx(['outbox'], 'readonly', s => s('outbox').get(id));
      if (e) this.entries.set(id, e); else this.entries.delete(id);
      return e || null;
    } catch { return this.entries.get(id) || null; }
  },
  async file(key){
    if (this.bytes.has(key)) return this.bytes.get(key);
    try { const v = await this.tx(['files'], 'readonly', s => s('files').get(key)); return v ? new File([v.data], v.name, {type: v.type}) : null; }
    catch { return null; }
  },
  /* The tasks Pocket has added in the last day, and the line each was added for, so a retry never takes one of them
     for its own: two "Buy milk"s added a minute apart stay two tasks. */
  claim(id, key){
    const c = {id, key, at: Date.now()};
    this.claimed.set(id, c);
    this.tx(['claims'], 'readwrite', s => s('claims').put(c)).catch(() => {});
  },
  claimedByOther(id, key){ const c = this.claimed.get(id); return !!c && c.key !== key; },
  // The task added for an entry (a step inserted in a run, say), once it's in Vikunja; null until then.
  taskOf(key){ for (const [id, c] of this.claimed) if (c.key === key) return id; return null; },
  // Once something has to wait, ask the browser not to clear the database when the phone runs low on space.
  keep(){ if (!this.asked) { this.asked = true; navigator.storage?.persist?.().catch(() => {}); } },
  // One sender at a time, even with Pocket open in two tabs.
  lock(fn){ return navigator.locks ? navigator.locks.request('pocket-outbox', fn) : fn(); },
};
sync.ready = sync.start();
// A copy the database can store: parts of an entry can be Alpine's reactive proxies, which it can't.
const plain = o => JSON.parse(JSON.stringify(o));
export const NO_ROOM = 'There\'s no room left on this phone to keep this until there\'s a connection. Keep Pocket open until it\'s sent.';
export const KEPT = ' It\'s kept: tap the warning sign at the top to try again.';
export const NOT_KEPT = 'This couldn\'t be saved on the phone. Keep Pocket open until it\'s sent.';
export const packParsed = p => ({title: p.title, due: p.due ? p.due.toISOString() : null, priority: p.priority, repeat: p.repeat,
  labels: p.labels, assignees: p.assignees, project: p.project ? {id: p.project.id, title: p.project.title} : null, remind: !!p.remind});
export const unpackParsed = p => ({...p, due: p.due ? new Date(p.due) : null});
export const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
export const fileEntry = f => ({key: randomId(), name: f.name, size: f.size, type: f.type, tried: false, sent: false});
// A line is done when all its steps are. One saved by a Pocket from before the steps has no `done`: having a task
// (and, as a subtask, its link) was all there was to it then.
export const itemDone = (x, child) => x.done ?? (!!x.taskId && (!child || !!x.linked));
// Whether a line of an entry goes under a task: one in Vikunja already (parent), or the entry's first line (nest).
export const isChild = (e, i) => !!e.parent || (!!e.nest && i > 0);
export const entryDone = e => e.items.every((x, i) => itemDone(x, isChild(e, i))) && !(e.files || []).some(f => !f.sent);
/* How a captured line becomes a task in Vikunja, step by step. `done` says whether a step is finished for the line
   (`job`); `run` does it, or the next part of it (one label, one person). Progress is saved after every run, so a try
   that's cut off carries on at the step it stopped at: nothing is added twice and nothing is skipped. An answer from
   Vikunja meaning "that's there already" (a cut-off try got that far) counts as done; any other refusal is reported
   as a problem and the step moves on. A lost connection, or Vikunja busy, stops the run, to try again later. */
export const ALREADY = {label: 8001, assignee: 4021, link: 4008};
const settle = (e, step, problem) => {
  if (passing(e) || e.status === 401) throw e;
  if (e.code !== ALREADY[step]) problem(e.message);
};
export const LINE_STEPS = [
  {name: 'prepare', done: j => !!j.body, async run(j, {parsed, pid}){
    const to = parsed.project?.id || pid, body = {title: parsed.title}, assign = [];
    // Someone who can see the project is assigned, and their @username leaves the title, as in Vikunja. Someone who
    // can't stays in the title and is reported. If Pocket can't check (an API token without Projects → Users search), it just tries.
    for (const name of parsed.assignees) {
      const seen = await app.canSee(to, name);
      if (seen === false) j.problems.push(await app.userExists(name).catch(() => true) ? `@${name} can't see ${app.projById.get(to)?.title || 'that project'}` : `no user @${name}`);
      else assign.push(name);
      if (seen === true) body.title = removeAssignee(body.title, app.prefixes.assignee, name);
    }
    if (parsed.due) body.due_date = parsed.due.toISOString();
    if (parsed.due && parsed.remind) body.reminders = [{relative_to: 'due_date', relative_period: 0}];   // the 🔔 chip: at the due time
    if (parsed.priority) body.priority = parsed.priority;
    if (parsed.repeat) { body.repeat_after = parsed.repeat.after; body.repeat_mode = parsed.repeat.mode; }
    // Kept, so a later try sends the same, and looks for the title as sent (without the @usernames).
    Object.assign(j, {to, body, assign, labels: [...parsed.labels]});
  }},
  {name: 'task', done: j => !!j.taskId, async run(j, c){
    // A try that was cut off may have reached Vikunja anyway: look for it before adding it again.
    let t = j.tried ? await app.findSent(j.body.title, j.to, j.triedAt, c.at, c.skip, j.key) : null;
    if (!t) { j.tried = true; j.triedAt = Date.now(); await c.save(); t = await api(`/projects/${j.to}/tasks`, {method:'POST', body: j.body}); }
    sync.claim(t.id, j.key);
    Object.assign(j, {taskId: t.id, projectId: t.project_id});
    c.task = t; c.made?.(t);
  }},
  {name: 'label', done: j => !j.labels.length, async run(j){
    const name = j.labels[0];
    try {
      const all = await app.loadLabels(j.newLabel);                         // a cut-off try may have created it
      let l = all.find(x => x.title.toLowerCase() === name.toLowerCase());
      if (!l) { j.newLabel = true; l = await api('/labels', {method:'POST', body:{title: name}}); all.push(l); }
      await patiently(() => api(`/tasks/${j.taskId}/labels`, {method:'POST', body:{label_id: l.id}}));
    } catch (e) { settle(e, 'label', m => j.problems.push(`label ${name}: ${m}`)); }
    j.labels.shift();
  }},
  // An assignment that fails (unknown user, no access to the project) doesn't undo the task; it's reported instead.
  {name: 'assignee', done: j => !j.assign.length, async run(j){
    const name = j.assign[0];
    try {
      const u = await app.findUser(name);
      if (!u) j.problems.push(`no user @${name}`);
      else await patiently(() => api(`/tasks/${j.taskId}/assignees`, {method:'POST', body:{user_id: u.id}}));
    } catch (e) { settle(e, 'assignee', m => j.problems.push(`@${name}: ${m}`)); }
    j.assign.shift();
  }},
  // Under the first line of a pasted list, or under the task its sheet is for.
  // Here a refusal stops the line, as the list can't be put together without it.
  {name: 'link', done: (j, c) => !c.parent || !!j.linked, async run(j, c){
    try { await app.linkSubtask(c.parent, j.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
    j.linked = true;
  }},
];
/* How a run is set up from its template, in the same way: the outbox entry (`j`) keeps how far it got, so a try that's
   cut off carries on where it stopped. A copy that reached Vikunja without its reply is found again through the
   "copied to" links of what it was copied from, instead of being made twice. */
export const NOT_RELATED = 4009;
// A copy of a task, noting in `rec` when the try began and, if it fails, when it ended: a copy it made despite the
// failure was made in between.
async function duplicate(from, rec, save, title){
  rec.tried = true; rec.triedAt = Date.now(); rec.triedUntil = null; rec.triedTitle = title ?? null;
  await save();
  try { return (await api(`/tasks/${from}/duplicate`, {method: 'POST'})).duplicated_task; }
  catch (e) { rec.triedUntil = Date.now(); await save(); throw e; }
}
export const runTitle = (template, name, day) => `${template} · ${name} · ${day.toLocaleDateString([], {month: 'short', day: 'numeric'})}`;
export const RUN_STEPS = [
  {name: 'run', done: j => !!j.runId, async run(j, c){
    const t = (j.tried && await app.findCopy(j.template.id, j, j.at, c.taken, j.id, null)) || await duplicate(j.template.id, j, c.save, (await api('/tasks/' + j.template.id)).title);
    sync.claim(t.id, j.id); c.taken.add(t.id); j.runId = t.id;
    // The template's notes come with it, but not its order line: the ids in it are the template's steps. And a line
    // saying it's a run, so it still is if its template is deleted.
    j.desc = withRunMark(notesOnly(t.description));
  }},
  // Named after its template, the name typed when it was started or else which run of it this is, and the day:
  // "Startup · Night shift · Oct 3", or "Startup · run 3 · Oct 3". Without a due date of its own (its steps have theirs),
  // except the time its template was due, when this start ticks it (tick), so a run left open shows on Today. Nothing
  // that repeats or reminds: those are the template's, and the copy has them.
  {name: 'name', done: j => !!j.named, async run(j){
    let name = j.name;
    if (!name) {
      const runs = ((await api('/tasks/' + j.template.id)).related_tasks?.copiedto || []).map(x => x.id).sort((a, b) => a - b);
      name = 'run ' + (runs.indexOf(j.runId) + 1 || runs.length);
    }
    j.title = runTitle(j.template.title, name, new Date(j.at));
    await patchTask(j.runId, {title: j.title, done: false, due_date: j.tick || ZERO, repeat_after: 0, repeat_mode: 0, reminders: [], ...j.desc && {description: j.desc}});
    j.named = true;
  }},
  // Each step, in the template's order: a copy of the template's step, linked under the run, then named, without its
  // T# and {#name}, and given its due time if it counts from the start. A timed step gets a reminder at its due time,
  // which Vikunja emails to whoever started the run and anyone on the step; Pocket's plugin moves it with the due date
  // it sets. Not one due less than a minute after the step it waits on: Vikunja looks for reminders once a minute, so it
  // would be past before it's seen. One part per run, so progress is kept after each.
  {name: 'step', done: j => j.steps.every(s => s.ready), async run(j, c){
    const s = j.steps.find(s => !s.ready);
    if (!s.taskId) {
      const t = (s.tried && await app.findCopy(s.from, s, j.at, c.taken, j.id, j.runId)) || await duplicate(s.from, s, c.save);
      sync.claim(t.id, j.id); c.taken.add(t.id); s.taskId = t.id; s.desc = t.description || '';
    } else if (!s.linked) {
      try { await app.linkSubtask(j.runId, s.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
      s.linked = true;
    } else {
      // Its template step's title, whose T# and {#name} its time is read from: changing the template later changes
      // only runs started after.
      await patchTask(s.taskId, {title: s.title, done: false, due_date: s.due || ZERO, repeat_after: 0, repeat_mode: 0,
        ...(s.remind ?? s.timed) && {reminders: [{relative_to: 'due_date', relative_period: 0}]},
        ...s.tpl != null && s.desc != null && {description: withStepLine(notesOnly(s.desc), s.tpl)}});
      s.ready = true;
    }
  }},
  // The run's own order, its steps' ids as copied: from now on it never reads its template's, and a step inserted
  // during the run goes in it. Written again after a lost reply, it's the same line.
  {name: 'order', done: j => !!j.ordered, async run(j){
    await patchTask(j.runId, {description: withOrder(j.desc ?? '', j.steps.map(s => s.taskId))});
    j.ordered = true;
  }},
  // Who it's for, and only them. Pocket assigns only the run: Vikunja tells them about it once, not once per step. (A
  // step assigned in the template, say to QA, stays assigned: the copy keeps it.)
  {name: 'assign', done: j => !!j.assigned, async run(j){
    await api(`/tasks/${j.runId}/assignees/bulk`, {method: 'PUT', body: {assignees: j.for.map(u => ({id: u.id}))}});
    j.assigned = true;
  }},
  // The copy has the template's labels, "template" too: that one comes off last, so until the run is whole it isn't a
  // run anywhere (isRun), and teammates can't start working on it. (Vikunja refuses to remove one that isn't there.)
  {name: 'unlabel', done: j => !!j.unlabeled, async run(j){
    for (const l of (await api('/tasks/' + j.runId)).labels || []) if (isTemplateLabel(l)) await api(`/tasks/${j.runId}/labels/${l.id}`, {method: 'DELETE'});
    j.unlabeled = true;
  }},
  /* Last, so a start called off ticks nothing: the template ticked, when this start is for the time it was due (tick).
     Only while it's still not done at that time, so one sent again after a lost reply doesn't skip a second time.
     Vikunja moves it on by its repeat; without one, it's done, its date taken off: that schedule's over. Every month
     moves one month only, so one left for months is moved on again, to the first time after now on its beat: only from
     where this tick put it, so a change made since stays. `ticked` keeps where it went, for Undo, if this tick moved it. */
  {name: 'tick', done: j => !!j.ticked, async run(j){
    if (!j.tick) { j.ticked = {}; return; }
    let t = await api('/tasks/' + j.template.id).catch(e => { if (e.status === 404) return null; throw e; }), mine = false;
    if (t && !t.done && Date.parse(t.due_date) === Date.parse(j.tick)) { t = await patchTask(t.id, repeats(t) ? {done: true} : {done: true, due_date: ZERO}); mine = true; }
    const due = t && Date.parse(t.due_date);
    if (t && !t.done && t.repeat_mode === 1 && due <= Date.now() && due === vikunjaNext({...t, due_date: j.tick}))
      t = await patchTask(t.id, {due_date: new Date(nextAfter(t, due)).toISOString()});
    j.ticked = {from: j.tick, to: mine ? t.due_date : null, done: !!t?.done};
  }},
];
// How much of a run is set up, of 6 + 3 per step.
export const runProgress = j => [j.runId, j.unlabeled, j.named, j.ordered, j.assigned, j.ticked, ...j.steps.flatMap(s => [s.taskId, s.linked, s.ready])].filter(Boolean).length;
/* A step inserted in a run, or repeated, in the same way: the entry (`j`) keeps how far it got. Inserted: a new task under
   the run. Repeated: a copy of the template step the repeated one was copied from (`from`), as a start makes one, so it
   has that step's notes and photos but none of this run's, found again through "copied to" if its reply was lost.
   Either is marked "pocket:added" (a repeated one also keeps the "pocket:step" line of the one it repeats, `tpl`), and
   goes in the run's order before the step it was inserted at (`before`). */
export const INSERT_STEPS = [
  {name: 'task', done: j => !!j.taskId, async run(j, c){
    if (j.from) {
      const t = (j.tried && await app.findCopy(j.from, j, j.at, c.taken, j.id, j.run)) || await duplicate(j.from, j, c.save);
      sync.claim(t.id, j.id); j.taskId = t.id; j.desc = t.description || '';
    } else {
      // Under the run, as a subtask is added, with what quick add read; found again by its title and time if its reply
      // was lost.
      j.job ||= {key: j.id};
      const t = await app.createTask(j.p ? unpackParsed(j.p) : {title: j.title, labels: [], assignees: []}, j.project, {job: j.job, save: c.save, at: j.at, parent: j.run});
      Object.assign(j, {taskId: t.id, linked: true, desc: j.desc ?? ''});
    }
  }},
  {name: 'link', done: j => !!j.linked, async run(j){
    try { await app.linkSubtask(j.run, j.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
    j.linked = true;
  }},
  // Not done, no time of its own, nothing that repeats or reminds: it's done when it's done.
  {name: 'mark', done: j => !!j.marked, async run(j){
    const desc = withAdded(j.tpl != null ? withStepLine(notesOnly(j.desc), j.tpl) : notesOnly(j.desc));
    // A repeat's title is its template step's, without T#; an inserted step's is as quick add sent it (without @people).
    await patchTask(j.taskId, {...(j.from || j.tpl != null) && {title: j.title}, done: false, due_date: ZERO, repeat_after: 0, repeat_mode: 0, reminders: [], description: desc});
    j.marked = true;
  }},
  // Before the step it was inserted at, read from the run as it is now, so another step inserted meanwhile stays. If that
  // step was deleted meanwhile, after the one it was inserted under.
  {name: 'order', done: j => !!j.ordered, async run(j){
    const after = typeof j.after === 'string' ? sync.taskOf(j.after.replace(/^pending-/, '')) : j.after ?? null;
    await app.saveTask(j.run, null, now => {
      if (stepOrder(now.description)?.includes(j.taskId)) return null;
      return {description: withOrder(now.description, placeBefore(stepsOf(now).map(s => s.id).filter(id => id !== j.taskId), j.taskId, j.before, after))};
    });
    j.ordered = true;
  }},
];
/* What's done on a run's screen: one outbox entry each, sent in the order they were done, with or without a
   connection. Each part can be sent again safely: setting done twice is the same, Vikunja keeps one reaction per person
   and mark, someone is assigned once, and a note whose reply was lost is looked for before it's posted again. Claiming
   a subtask or a step (assigning yourself) goes the same way, from anywhere. */
// The tasks with an act Vikunja turned down: later acts on them wait, so an untick never arrives before its tick.
export const heldTasks = entries => new Set(entries.filter(e => e.kind === 'act' && e.failed).map(e => e.task));
export const ACTS = {progress: ['progress'], done: ['done', 'mark'], skip: ['done', 'markSkip', 'note'], undone: ['undone', 'unmark'], note: ['note'], finish: ['done'], reopen: ['undone'], doneNote: ['done', 'mark', 'note'],
  claim: ['claim'], unclaim: ['unclaim']};
export const ACT_STEPS = {
  done: a => patchTask(a.task, {done: true}),
  undone: a => patchTask(a.task, {done: false}),
  progress: a => patchTask(a.task, {percent_done: a.pct / 100}),
  mark: a => api(`/tasks/${a.task}/reactions`, {method: 'POST', body: {value: DONE_MARK}}),
  markSkip: a => api(`/tasks/${a.task}/reactions`, {method: 'POST', body: {value: SKIP_MARK}}),
  /* Someone else who said they'd do it meanwhile keeps it: two people tapping at once, or a claim that waited offline.
     It's looked at before, and after (for two at the same moment: the one who signed up to Vikunja first keeps it, as
     both phones work out the same). */
  claim: async a => {
    const others = async () => ((await api('/tasks/' + a.task)).assignees || []).filter(u => u.id !== a.user);
    const taken = list => Object.assign(new ApiError(409, `${andList(list.map(u => u.name || u.username))} said they'd do it just now`), {drop: true});
    const before = await others();
    if (before.length) throw taken(before);
    await api(`/tasks/${a.task}/assignees`, {method: 'POST', body: {user_id: a.user}}).catch(e => { if (e.code !== ALREADY.assignee) throw e; });
    const after = (await others()).filter(u => u.id < a.user);
    if (after.length) { await api(`/tasks/${a.task}/assignees/${a.user}`, {method: 'DELETE'}).catch(() => {}); throw taken(after); }
  },
  unclaim: a => api(`/tasks/${a.task}/assignees/${a.user}`, {method: 'DELETE'}).catch(e => { if (e.status !== 404) throw e; }),
  unmark: async a => { for (const value of [DONE_MARK, SKIP_MARK]) await api(`/tasks/${a.task}/reactions/delete`, {method: 'POST', body: {value}}); },
  note: async (a, save) => {
    if (a.tried && await app.findNote(a.task, a.html, a.triedAt, a.at)) return;
    a.tried = true; a.triedAt = Date.now(); await save();
    await api(`/tasks/${a.task}/comments`, {method: 'POST', body: {comment: a.html}});
  },
};
