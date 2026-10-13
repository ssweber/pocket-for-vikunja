// The outbox: everything waiting to go to Vikunja, kept on the phone, and the steps each kind of change is sent in.
import {andList, app, ZERO} from './util.js';
import {api, ApiError, passing, patchTask} from './api.js';
import {DONE_MARK, isTemplateLabel, nextAfter, notesOnly, patiently, placeBefore, SKIP_MARK, stepOrder, stepsOf, vikunjaNext, withAdded, withOrder, withRunMark, withStepLine} from './checklists.js';
import {repeats} from './dates.js';
import {removeAssignee} from './quickadd.js';

/* An entry is one capture: a task or a pasted list, subtasks added from a task's sheet (`parent`), or files added from
   a task's sheet (`taskId`):
   {id, user, at, nest, pid, parent: {id, project_id, title}, items: [{raw, p, under, ...its steps}], files: [{key, name, size, type, ...}], taskId}.
   `p` is the line as parsed when it was typed, so "tomorrow" keeps meaning the day after it was typed. `under` is the
   index in `items` of the line this one goes under (always an earlier one, null for none), so a list can have several
   parents and subtasks of subtasks. An entry from an older Pocket has `nest` instead: its first line is the parent of
   all the rest (underOf).
   Entries, file bytes and the tasks Pocket has added live in IndexedDB. An entry and its files are saved together or
   not at all. The screen reads a copy in memory (`entries`), and sending always starts from the database's copy, so
   two tabs never work from a stale one. If the database can't be used or the phone has no room, an entry waits in
   memory only, and Pocket says to keep it open. */
export const sync = {
  entries: new Map(),                            // id -> entry, what the screen shows
  volatile: new Set(),                           // ids of entries kept in memory only
  bytes: new Map(),                              // key -> File, for files kept in memory only
  claimed: new Map(),                            // task id -> {key, at}, see claim()
  held: new Set(),                               // ids of deletions in this tab that can still be restored, not sent yet
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
      // A newer Pocket in another tab may need to upgrade the database. Close, so that tab isn't kept waiting.
      r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); ok(r.result); };
      r.onerror = () => no(r.error);
    });
  },
  // One transaction over `stores`. Resolves with what `fn` returned once it commits, rejects if it doesn't.
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

  // Save a new entry and its files together. Returns {kept, full}: whether it reached the database, and if not,
  // whether the phone is out of room.
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
  // Save an entry's progress and delete the bytes of files it is done with (`drop`), in one transaction.
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
  // The entry to send from: the database's copy, which another tab may have moved on. Null if that tab sent it.
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
  /* Remember which line each task Pocket added in the last day was added for, so a retry never takes one of them for
     its own: two "Buy milk"s added a minute apart stay two tasks. */
  claim(id, key){
    const c = {id, key, at: Date.now()};
    this.claimed.set(id, c);
    this.tx(['claims'], 'readwrite', s => s('claims').put(c)).catch(() => {});
  },
  claimedByOther(id, key){ const c = this.claimed.get(id); return !!c && c.key !== key; },
  // The id of the task added for entry `key`, once it is in Vikunja. Null until then.
  taskOf(key){ for (const [id, c] of this.claimed) if (c.key === key) return id; return null; },
  // Once something has to wait, ask the browser not to clear the database when the phone runs low on space.
  keep(){ if (!this.asked) { this.asked = true; navigator.storage?.persist?.().catch(() => {}); } },
  // One sender at a time, even with Pocket open in two tabs.
  lock(fn){ return navigator.locks ? navigator.locks.request('pocket-outbox', fn) : fn(); },
};
sync.ready = sync.start();
// A copy the database can store. Parts of an entry can be Alpine's reactive proxies, which it can't.
const plain = o => JSON.parse(JSON.stringify(o));
export const NO_ROOM = 'This phone\'s storage is full, so Pocket can\'t save this for later. Keep Pocket open until it is sent.';
export const KEPT = ' It is saved. Tap the warning sign at the top to try again.';
export const NOT_KEPT = 'This couldn\'t be saved on the phone. Keep Pocket open until it\'s sent.';
export const packParsed = p => ({title: p.title, due: p.due ? p.due.toISOString() : null, priority: p.priority, repeat: p.repeat,
  labels: p.labels, assignees: p.assignees, project: p.project ? {id: p.project.id, title: p.project.title} : null, remind: !!p.remind, done: !!p.done, pct: p.pct || 0});
export const unpackParsed = p => ({...p, due: p.due ? new Date(p.due) : null});
export const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
export const fileEntry = f => ({key: randomId(), name: f.name, size: f.size, type: f.type, tried: false, sent: false});
// A line is done when all its steps are. A line saved by an older Pocket has no `done`: then having a task, and for a
// subtask its link, was all there was.
export const itemDone = (x, child) => x.done ?? (!!x.taskId && (!child || !!x.linked));
// The index of the line that line `i` goes under, or null: from `under`, or for an older entry with `nest`, the first
// line.
export const underOf = (e, i) => e.items[i]?.under ?? (e.nest && i > 0 ? 0 : null);
// Whether line `i` goes under a task: the entry's parent in Vikunja, or an earlier line.
export const isChild = (e, i) => !!e.parent || underOf(e, i) !== null;
/* A box's lines as an entry's items. `lines` is [{raw, p, under}], with `p` the parsed line and `under` the index of
   the line it goes under. A line with no title left (a date alone, say) is dropped, and the lines under it go under
   its parent. `more(k, under)` adds fields to kept line `k`. */
export function itemsOf(lines, more = () => null){
  const kept = lines.map(x => !!x.p.title), at = [];
  for (const ok of kept) at.push(ok ? at.filter(k => k >= 0).length : -1);
  const up = i => { let u = lines[i].under ?? null; while (u !== null && !kept[u]) u = lines[u].under ?? null; return u === null ? null : at[u]; };
  return lines.flatMap((x, i) => kept[i] ? [{raw: x.raw, p: {...packParsed(x.p), ...more(at[i], up(i))}, under: up(i), taskId: null, done: false, linked: false}] : []);
}
export const entryDone = e => e.items.every((x, i) => itemDone(x, isChild(e, i))) && !(e.files || []).some(f => !f.sent);
/* How a captured line becomes a task in Vikunja, one step at a time. `done` says whether a step is finished for the
   line (`j`), `run` does the step or the next part of it (one label, one person). Progress is saved after every run,
   so a try that is cut off carries on at the step it stopped at: nothing is added twice and nothing is skipped. A
   Vikunja answer meaning "that's there already" counts as done. Any other refusal is reported as a problem and the
   step moves on. A lost connection, or Vikunja busy, stops the run to try again later. */
export const ALREADY = {label: 8001, assignee: 4021, link: 4008};
const settle = (e, step, problem) => {
  if (passing(e) || e.status === 401) throw e;
  if (e.code !== ALREADY[step]) problem(e.message);
};
export const LINE_STEPS = [
  {name: 'prepare', done: j => !!j.body, async run(j, {parsed, pid}){
    const to = parsed.project?.id || pid, body = {title: parsed.title}, assign = [];
    // Someone who can see the project is assigned, and their @username leaves the title, as in Vikunja. Someone who
    // can't stays in the title and is reported. If Pocket can't check (an API token without the Projects → Users
    // search), it just tries.
    for (const name of parsed.assignees) {
      const seen = await app.canSee(to, name);
      if (seen === false) j.problems.push(await app.userExists(name).catch(() => true) ? `@${name} can't see ${app.projById.get(to)?.title || 'that project'}` : `no user @${name}`);
      else assign.push(name);
      if (seen === true) body.title = removeAssignee(body.title, app.prefixes.assignee, name);
    }
    if (parsed.due) body.due_date = parsed.due.toISOString();
    if (parsed.due && parsed.remind) body.reminders = [{relative_to: 'due_date', relative_period: 0}];   // the 🔔 chip: a reminder at the due time
    if (parsed.priority) body.priority = parsed.priority;
    if (parsed.position) body.position = parsed.position;                   // its place in its project's List view
    if (parsed.repeat) { body.repeat_after = parsed.repeat.after; body.repeat_mode = parsed.repeat.mode; }
    // Kept on the job, so a later try sends the same body and looks for the title as sent, without the @usernames.
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
  // An assignment that fails (unknown user, no access to the project) is reported. The task stays.
  {name: 'assignee', done: j => !j.assign.length, async run(j){
    const name = j.assign[0];
    try {
      const u = await app.findUser(name);
      if (!u) j.problems.push(`no user @${name}`);
      else await patiently(() => api(`/tasks/${j.taskId}/assignees`, {method:'POST', body:{user_id: u.id}}));
    } catch (e) { settle(e, 'assignee', m => j.problems.push(`@${name}: ${m}`)); }
    j.assign.shift();
  }},
  // Link the task under its parent: the line it goes under in a pasted list, or the task whose sheet it was added
  // from. A refusal here stops the line, since the list can't be put together without the link.
  {name: 'link', done: (j, c) => !c.parent || !!j.linked, async run(j, c){
    try { await app.linkSubtask(c.parent, j.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
    j.linked = true;
  }},
  /* A line that said it was done, or how far along it was, is made like any task and then marked the way a tick or a
     swipe marks it (100% is done), so a repeating one moves on to its next date and its parent's progress counts it.
     Last, once it is under its parent. A repeating task ticked twice would skip a date, so after a cut-off try
     Vikunja's copy is checked first: done, or moved on from the date it was made with. `c.arrived` gives the row
     Vikunja's copy afterwards (`now`) and whether it was marked done. */
  {name: 'arrive', done: (j, c) => !!j.arrived || !(c.parsed.done || c.parsed.pct > 0), async run(j, c){
    const done = !!c.parsed.done || c.parsed.pct >= 100;
    const got = t => t.done || (repeats(t) && Date.parse(t.due_date) !== Date.parse(j.body.due_date));
    let t = done && j.arriving ? await api('/tasks/' + j.taskId) : null;
    if (!t || !got(t)) { j.arriving = true; await c.save(); t = await patchTask(j.taskId, done ? {done: true} : {percent_done: c.parsed.pct / 100}); }
    j.arrived = true;
    c.arrived = {now: t, done};
  }},
];
/* How a run (a started checklist) is set up from its template, the same way: the outbox entry (`j`) keeps how far it
   got, so a cut-off try carries on where it stopped. A copy that reached Vikunja without its reply is found again
   through the template's "copied to" links instead of being made twice. */
// Copy a task. `rec` notes when the try began and, if it fails, when it ended, so a copy made despite the failure can
// be found: it was made in between.
async function duplicate(from, rec, save, title){
  rec.tried = true; rec.triedAt = Date.now(); rec.triedUntil = null; rec.triedTitle = title ?? null;
  await save();
  try { return (await api(`/tasks/${from}/duplicate`, {method: 'POST'})).duplicated_task; }
  catch (e) { rec.triedUntil = Date.now(); await save(); throw e; }
}
export const runTitle = (template, name, day) => `${template} · ${day.toLocaleDateString([], {month: 'short', day: 'numeric'})} · ${name}`;
export const RUN_STEPS = [
  {name: 'run', done: j => !!j.runId, async run(j, c){
    const t = (j.tried && await app.findCopy(j.template.id, j, j.at, c.taken, j.id, null)) || await duplicate(j.template.id, j, c.save, (await api('/tasks/' + j.template.id)).title);
    sync.claim(t.id, j.id); c.taken.add(t.id); j.runId = t.id;
    // The template's notes come with the copy, but not its order line, whose ids are the template's steps. A line is
    // added saying this is a run, so it stays one if its template is deleted.
    j.desc = withRunMark(notesOnly(t.description));
  }},
  // The run is named after its template, the day, and the name typed when it was started, else its number among the
  // template's runs: "Startup · Oct 3 · Night shift" or "Startup · Oct 3 · #3". It gets no due date of its own (its
  // steps have theirs), except the time its template was due when this start ticks the template (`tick`), so a run
  // left open shows on Today. Nothing repeats or reminds: those belong to the template, and the copy came with them.
  {name: 'name', done: j => !!j.named, async run(j){
    let name = j.name;
    if (!name) {
      const runs = ((await api('/tasks/' + j.template.id)).related_tasks?.copiedto || []).map(x => x.id).sort((a, b) => a - b);
      name = '#' + (runs.indexOf(j.runId) + 1 || runs.length);
    }
    j.title = runTitle(j.template.title, name, new Date(j.at));
    await patchTask(j.runId, {title: j.title, done: false, due_date: j.tick || ZERO, repeat_after: 0, repeat_mode: 0, reminders: [], ...j.desc && {description: j.desc}});
    j.named = true;
  }},
  // Each step in the template's order: copy the template's step, link it under the run, then name it without its T#
  // and {#name} and give it its due time if it counts from the start. A timed step gets a reminder at its due time,
  // which Vikunja emails to whoever started the run and anyone on the step. Pocket's plugin moves the reminder with
  // the due date it sets. A step due less than a minute after the step it waits on gets no reminder: Vikunja looks
  // for reminders once a minute, so it would be past before it is seen. One part per run, so progress is kept after
  // each.
  {name: 'step', done: j => j.steps.every(s => s.ready), async run(j, c){
    const s = j.steps.find(s => !s.ready);
    if (!s.taskId) {
      const t = (s.tried && await app.findCopy(s.from, s, j.at, c.taken, j.id, j.runId)) || await duplicate(s.from, s, c.save);
      sync.claim(t.id, j.id); c.taken.add(t.id); s.taskId = t.id; s.desc = t.description || '';
    } else if (!s.linked) {
      try { await app.linkSubtask(j.runId, s.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
      s.linked = true;
    } else {
      // The title is the template step's, which its time was read from. Changing the template later changes only
      // runs started after.
      await patchTask(s.taskId, {title: s.title, done: false, due_date: s.due || ZERO, repeat_after: 0, repeat_mode: 0,
        ...(s.remind ?? s.timed) && {reminders: [{relative_to: 'due_date', relative_period: 0}]},
        ...s.tpl != null && s.desc != null && {description: withStepLine(notesOnly(s.desc), s.tpl)}});
      s.ready = true;
    }
  }},
  // The run's own order line, its steps' ids as copied. From now on the run never reads its template's order, and a
  // step inserted during the run goes in this line. Written again after a lost reply, it is the same line.
  {name: 'order', done: j => !!j.ordered, async run(j){
    await patchTask(j.runId, {description: withOrder(j.desc ?? '', j.steps.map(s => s.taskId))});
    j.ordered = true;
  }},
  // Assign the run to the people it is for, and only the run: Vikunja tells them once, not once per step. A step
  // assigned in the template, say to QA, keeps its assignee, since the copy keeps it.
  {name: 'assign', done: j => !!j.assigned, async run(j){
    await api(`/tasks/${j.runId}/assignees/bulk`, {method: 'PUT', body: {assignees: j.for.map(u => ({id: u.id}))}});
    j.assigned = true;
  }},
  // The copy has the template's labels, "template" among them. That one comes off last, so until the run is whole it
  // isn't a run anywhere (isRun) and teammates can't start on it. Vikunja refuses to remove a label that isn't there.
  {name: 'unlabel', done: j => !!j.unlabeled, async run(j){
    for (const l of (await api('/tasks/' + j.runId)).labels || []) if (isTemplateLabel(l)) await api(`/tasks/${j.runId}/labels/${l.id}`, {method: 'DELETE'});
    j.unlabeled = true;
  }},
  /* Last, so a start called off ticks nothing. When this start is for the time the template was due (`tick`), tick
     the template, but only while it is still not done at that time, so a start sent again after a lost reply doesn't
     tick it twice. Vikunja moves a repeating template on by its repeat. One that doesn't repeat is done and loses its
     date: that schedule is over. Every month moves one month only, so a template left for months is moved on again,
     to the first time after now on its schedule, counting from where this tick put it, so a change made since stays.
     `ticked` keeps where it went, for Undo. */
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
// How much of a run is set up, out of 6 + 3 per step.
export const runProgress = j => [j.runId, j.unlabeled, j.named, j.ordered, j.assigned, j.ticked, ...j.steps.flatMap(s => [s.taskId, s.linked, s.ready])].filter(Boolean).length;
/* A step inserted in a run, or repeated, set up the same way: the entry (`j`) keeps how far it got. An inserted step
   is a new task under the run. A repeated step is a copy of the template step the repeated one came from (`from`), so
   it has that step's notes and photos but none of this run's, found again through "copied to" if the reply was lost.
   Either is marked "pocket:added" (a repeated one also keeps the "pocket:step" line of the step it repeats, `tpl`)
   and goes in the run's order before the step it was inserted at (`before`). */
export const INSERT_STEPS = [
  {name: 'task', done: j => !!j.taskId, async run(j, c){
    if (j.from) {
      const t = (j.tried && await app.findCopy(j.from, j, j.at, c.taken, j.id, j.run)) || await duplicate(j.from, j, c.save);
      sync.claim(t.id, j.id); j.taskId = t.id; j.desc = t.description || '';
    } else {
      // A new task under the run, with what quick add read. Found again by its title and time if the reply was lost.
      j.job ||= {key: j.id};
      const t = await app.createTask(j.p ? unpackParsed(j.p) : {title: j.title, labels: [], assignees: []}, j.project, {job: j.job, save: c.save, at: j.at, parent: j.run});
      Object.assign(j, {taskId: t.id, linked: true, desc: j.desc ?? ''});
    }
  }},
  {name: 'link', done: j => !!j.linked, async run(j){
    try { await app.linkSubtask(j.run, j.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
    j.linked = true;
  }},
  // Not done, no due date, nothing that repeats or reminds. The step is done when someone does it.
  {name: 'mark', done: j => !!j.marked, async run(j){
    const desc = withAdded(j.tpl != null ? withStepLine(notesOnly(j.desc), j.tpl) : notesOnly(j.desc));
    // A repeated step's title is its template step's without T#. An inserted step's is as quick add sent it, without
    // @people.
    await patchTask(j.taskId, {...(j.from || j.tpl != null) && {title: j.title}, done: false, due_date: ZERO, repeat_after: 0, repeat_mode: 0, reminders: [], description: desc});
    j.marked = true;
  }},
  // Place it before the step it was inserted at, reading the run's order as it is now, so a step inserted meanwhile
  // stays. If that step was deleted meanwhile, place it after the step it was inserted under.
  {name: 'order', done: j => !!j.ordered, async run(j){
    const after = typeof j.after === 'string' ? sync.taskOf(j.after.replace(/^pending-/, '')) : j.after ?? null;
    await app.saveTask(j.run, null, now => {
      if (stepOrder(now.description)?.includes(j.taskId)) return null;
      return {description: withOrder(now.description, placeBefore(stepsOf(now).map(s => s.id).filter(id => id !== j.taskId), j.taskId, j.before, after))};
    });
    j.ordered = true;
  }},
  // A new step at 0% lowers the run's progress. Written once the step is in the run.
  {name: 'figure', done: j => !!j.figured, async run(j){ await app.writeFigure(j.run); j.figured = true; }},
];
/* Acts are what is done on a run's screen, one outbox entry each, sent in the order they were done. Each part can be
   sent twice safely: setting done twice is the same, Vikunja keeps one reaction per person and mark, someone is
   assigned once, and a note whose reply was lost is looked for before it is posted again. Claiming a subtask or a
   step (assigning yourself) goes the same way from anywhere. */
/* Whether a deletion can still be restored. In this tab, until its rows or its message go (sync.held). In another
   tab, or after a reload, until `until`. */
export const held = e => sync.held.has(e.id) || e.until > Date.now();
/* The value of <html data-sync>, which the tests wait on. 'sending' while a change is on its way. 'waiting' while
   something is kept that can't go now (no connection, a restorable deletion, a refusal, Vikunja busy) or the outbox
   isn't read yet (`unsent` null). Else 'idle'. */
export const sendState = ({busy, unsent}) => busy ? 'sending' : unsent === 0 ? 'idle' : 'waiting';
/* A change shows on screen at once. It looks like it is waiting (dotted, "waiting to send") only after WAIT_MS without
   an answer, or at once without a connection: most are answered well within WAIT_MS, so a row doesn't flicker.
   Returns the ids of the entries that look waiting at `now`, and when the next one will (null for none). */
export const WAIT_MS = 2500;
export function slowness(entries, now, offline){
  const slow = [], later = [];
  for (const e of entries) { const at = Date.parse(e.at) + WAIT_MS; if (offline || !(at > now)) slow.push(e.id); else later.push(at); }
  return {slow, next: later.length ? Math.min(...later) : null};
}
// The tasks with an act Vikunja turned down. Later acts on them wait, so an untick never arrives before its tick.
export const heldTasks = entries => new Set(entries.filter(e => e.kind === 'act' && e.failed).map(e => e.task));
/* Each act's parts, in order. `figure` comes last: a change to a run's step, or a deleted subtask, changes its
   parent's progress, which is written in the same entry so that offline it waits with the change. */
export const ACTS = {progress: ['progress', 'figure'], done: ['done', 'mark', 'figure'], skip: ['done', 'markSkip', 'note', 'figure'], undone: ['undone', 'unmark', 'figure'], note: ['note'],
  finish: ['done'], reopen: ['undone'], doneNote: ['done', 'mark', 'note', 'figure'], claim: ['claim'], unclaim: ['unclaim'], delete: ['delete', 'figure'], position: ['position']};
export const ACT_STEPS = {
  done: a => patchTask(a.task, {done: true}),
  undone: a => patchTask(a.task, {done: false}),
  progress: a => patchTask(a.task, {percent_done: a.pct / 100}),
  mark: a => api(`/tasks/${a.task}/reactions`, {method: 'POST', body: {value: DONE_MARK}}),
  markSkip: a => api(`/tasks/${a.task}/reactions`, {method: 'POST', body: {value: SKIP_MARK}}),
  /* Someone else who claimed it meanwhile keeps it: two people tapping at once, or a claim that waited offline.
     Checked before and after assigning. When two claim at the same moment, the one who signed up to Vikunja first
     (the lower id) keeps it, as both phones work that out the same way. */
  claim: async a => {
    const others = async () => ((await api('/tasks/' + a.task)).assignees || []).filter(u => u.id !== a.user);
    const taken = list => Object.assign(new ApiError(409, `${andList(list.map(u => u.name || u.username))} ${list.length === 1 ? 'was' : 'were'} assigned to it just now`), {drop: true});
    const before = await others();
    if (before.length) throw taken(before);
    await api(`/tasks/${a.task}/assignees`, {method: 'POST', body: {user_id: a.user}}).catch(e => { if (e.code !== ALREADY.assignee) throw e; });
    const after = (await others()).filter(u => u.id < a.user);
    if (after.length) { await api(`/tasks/${a.task}/assignees/${a.user}`, {method: 'DELETE'}).catch(() => {}); throw taken(after); }
  },
  unclaim: a => api(`/tasks/${a.task}/assignees/${a.user}`, {method: 'DELETE'}).catch(e => { if (e.status !== 404) throw e; }),
  // A task's position in its project's List view (a.view). Sending it again writes the same. Vikunja's reply has the
  // position it kept (a.got), which differs when Vikunja renumbered the view.
  position: async a => { a.got = (await api(`/tasks/${a.task}/position`, {method: 'PUT', body: {project_view_id: a.view, position: a.pos}}))?.position; },
  // Delete a task and its subtasks (a.ids, deepest first). One already gone, after a cut-off try, is fine.
  delete: async a => { for (const id of a.ids) await api('/tasks/' + id, {method: 'DELETE'}).catch(e => { if (e.status !== 404) throw e; }); },
  /* Write the parent's progress, worked out from its subtasks as Vikunja has them now, only if it changed: a run's
     after one of its steps (a.run), or a deleted subtask's parent (a.up). Sending it again writes the same. */
  figure: a => { const up = a.up ?? (a.run && a.task !== a.run ? a.run : null); return up ? app.writeFigure(up) : null; },
  unmark: async a => { for (const value of [DONE_MARK, SKIP_MARK]) await api(`/tasks/${a.task}/reactions/delete`, {method: 'POST', body: {value}}); },
  note: async (a, save) => {
    if (a.tried && await app.findNote(a.task, a.html, a.triedAt, a.at)) return;
    a.tried = true; a.triedAt = Date.now(); await save();
    await api(`/tasks/${a.task}/comments`, {method: 'POST', body: {comment: a.html}});
  },
};
