// The outbox: everything waiting to go to Vikunja, kept on the phone, and the steps a checklist's start or an inserted
// step is sent in. The requests of every other change are its op's stages (src/js/ops/).
import {app, ZERO} from './util.js';
import {api, patchTask} from './api.js';
import {copiedNotes, isTemplateLabel, nextAfter, notesOnly, placeBefore, stepOrder, stepsOf, vikunjaNext, withAdded, withOrder, withRunMark, withStepLine} from './checklists.js';
import {repeats} from './dates.js';

/* An entry is one of:
   - an op (`kind: 'act'`, `op`), sent through its stages. A line typed in an add box is an `add` op (ops/add.js):
     {id, kind, op: 'add', batch, raw, p, pid, under, over, parent, ups, files, ...its stages}. `p` is the line as parsed
     when it was typed, so "tomorrow" keeps meaning the day after it was typed. The photos added with a list are on its
     first line until its task is made.
   - a checklist's start (`kind: 'run'`) or a step inserted in one (`kind: 'step'`).
   - files for a task: {id, user, at, taskId, files: [{key, name, size, type, ...}]}, added from its sheet, or with the
     line that made it.
   An entry with `items` and no `kind` or `taskId` is a capture an older Pocket saved. The sender removes it.

   Entries, file bytes and the tasks Pocket has added live in IndexedDB. An entry and its files are saved together or
   not at all. The screen reads a copy in memory (`entries`). Sending always starts from the database's copy, so two
   tabs never work from a stale one. If the database can't be used or the phone is out of space, the entry waits in
   memory only, and Pocket tells the user to keep it open. */
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
      const r = indexedDB.open('pocket', 3);
      // Version 3 changed the format of an entry. The upgrade starts every store empty, and keeps nothing older.
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const [name, how] of [['files'], ['outbox', {keyPath: 'id'}], ['claims', {keyPath: 'id'}]]) {
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
          db.createObjectStore(name, how);
        }
      };
      // A newer Pocket in another tab may need to upgrade the database. Closing it here keeps that tab from waiting.
      r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); ok(r.result); };
      r.onerror = () => no(r.error);
    });
  },
  // Run `fn` in one transaction over `stores`. Resolves with what `fn` returned once the transaction commits, and
  // rejects if it doesn't.
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
  // Load the entries that are waiting, and the record of which task was added for which line.
  async start(){
    try {
      await this.reload();
      // A claim lasts a day, or while an entry still waits for its task: a line under a line, or an op on a new step.
      const day = Date.now() - 86400000, named = new Set([...this.entries.values()].flatMap(e => [e.task, e.under, e.after, ...e.ups || [], ...e.above || []])
        .filter(k => typeof k === 'string').map(k => k.replace(/^pending-/, '')));
      const claims = await this.tx(['claims'], 'readonly', s => s('claims').getAll()), kept = c => c.at > day || named.has(c.key);
      for (const c of claims) if (kept(c)) this.claimed.set(c.id, c);
      this.tx(['claims'], 'readwrite', s => { for (const c of claims) if (!kept(c)) s('claims').delete(c.id); }).catch(() => {});
    } catch {}
    this.channel?.addEventListener('message', async () => { await this.reload().catch(() => {}); app?.refreshPending(); });
  },
  // Reload the entries from the database, and keep those that exist in memory only.
  async reload(){
    const list = await this.tx(['outbox'], 'readonly', s => s('outbox').getAll());
    const keep = [...this.volatile].map(id => this.entries.get(id)).filter(Boolean);
    this.entries = new Map([...list, ...keep].map(e => [e.id, e]));
  },
  changed(){ this.channel?.postMessage('changed'); },
  // This user's entries, oldest first, so changes are sent in the order they were made (a tick, then its untick).
  all(user){ return [...this.entries.values()].filter(e => e.user === user).sort(older); },

  // Save a new entry and its files together. Returns {kept, full}. `kept` says whether it reached the database, and
  // `full` whether the phone is out of space.
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
  // Save an entry's progress and any new entries it made (`more`), and delete the bytes of files it has finished with
  // (`drop`), in one transaction.
  async save(entry, drop = [], more = []){
    const all = [entry, ...more];
    for (const e of all) this.entries.set(e.id, e);
    for (const k of drop) this.bytes.delete(k);
    if (this.volatile.has(entry.id)) { for (const e of more) this.volatile.add(e.id); return; }
    try {
      await this.tx(['files', 'outbox'], 'readwrite', s => { for (const k of drop) s('files').delete(k); for (const e of all) s('outbox').put(plain(e)); });
      this.changed();
    } catch { for (const e of all) this.volatile.add(e.id); }               // no space now, so keep it in memory
  },
  /* Remove an entry. For a line whose task is made, the task's id (`task`) takes the place of the line's waiting id in
     every entry that names it, in the same transaction. So a line under it keeps its parent in every tab. */
  async remove(id, task = null){
    const e = this.entries.get(id), keys = (e?.files || []).map(f => f.key), name = 'pending-' + id;
    this.entries.delete(id); this.volatile.delete(id);
    for (const k of keys) this.bytes.delete(k);
    if (task != null) for (const x of this.entries.values()) named(x, name, task);
    try {
      await this.tx(['files', 'outbox'], 'readwrite', s => {
        for (const k of keys) s('files').delete(k);
        s('outbox').delete(id);
        if (task != null) s('outbox').getAll().onsuccess = r => { for (const x of r.target.result) if (named(x, name, task)) s('outbox').put(x); };
      });
      this.changed();
    } catch {}
  },
  async drop(fn){ for (const e of [...this.entries.values()]) if (fn(e)) await this.remove(e.id); },
  // The entry to send from. It is the database's copy, which another tab may have changed. Null if that tab sent it.
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
  /* Remember which entry or line each task Pocket added was added for. A retry of a checklist's copy then never takes
     a task made for another entry for its own copy (findCopy), and taskOf turns a waiting id into the task's id. */
  claim(id, key){
    const c = {id, key, at: Date.now()};
    this.claimed.set(id, c);
    this.tx(['claims'], 'readwrite', s => s('claims').put(c)).catch(() => {});
  },
  claimedByOther(id, key){ const c = this.claimed.get(id); return !!c && c.key !== key; },
  // The id of the task added for entry `key`. Null until the task is in Vikunja.
  taskOf(key){ for (const [id, c] of this.claimed) if (c.key === key) return id; return null; },
  // Once an entry has to wait, ask the browser not to clear the database when the phone runs low on space.
  keep(){ if (!this.asked) { this.asked = true; navigator.storage?.persist?.().catch(() => {}); } },
  // Only one tab sends at a time, even with Pocket open in two tabs.
  lock(fn){ return navigator.locks ? navigator.locks.request('pocket-outbox', fn) : fn(); },
};
sync.ready = sync.start();
// A copy of an entry that the database can store. Parts of an entry can be Alpine's reactive proxies, which it can't.
const plain = o => JSON.parse(JSON.stringify(o));
// Put task id `id` where entry `e` names waiting id `name`. Returns whether anything changed.
function named(e, name, id){
  let changed = false;
  for (const k of ['task', 'under', 'after']) if (e[k] === name) { e[k] = id; changed = true; }
  for (const k of ['ups', 'above']) if (e[k]?.includes(name)) { e[k] = e[k].map(x => x === name ? id : x); changed = true; }
  return changed;
}
// The order entries are sent in (all).
export const older = (a, b) => a.at.localeCompare(b.at) || (a.n || 0) - (b.n || 0);
// What an op's merge returns when the new op cancels the earlier one, as an untick cancels a tick. Both leave the outbox.
export const CANCEL = 'cancel';
export const NO_ROOM = 'This phone\'s storage is full, so Pocket can\'t save this for later. Keep Pocket open until it is sent.';
export const KEPT = ' It\'s kept to try again.';
export const NOT_KEPT = 'This couldn\'t be saved on the phone. Keep Pocket open until it\'s sent.';
export const packParsed = p => ({title: p.title, due: p.due ? p.due.toISOString() : null, priority: p.priority, repeat: p.repeat,
  labels: p.labels, assignees: p.assignees, project: p.project ? {id: p.project.id, title: p.project.title} : null, remind: !!p.remind, done: !!p.done, pct: p.pct || 0});
export const unpackParsed = p => ({...p, due: p.due ? new Date(p.due) : null});
export const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
// A UUIDv7. Its first 48 bits are the time in milliseconds, which the plugin's relay reads to tell how old a key is.
export const uuid7 = () => {
  const b = crypto.getRandomValues(new Uint8Array(16)), ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const fileEntry = f => ({key: randomId(), name: f.name, size: f.size, type: f.type, tried: false, sent: false});
/* Turn the lines typed in a box into the lines an add op is made from (addLines, ops/add.js). `lines` is [{raw, p,
   under}], with `p` the parsed line and `under` the index of the line it goes under. A line with no title left (a
   date alone, say) is dropped, and the lines under it go under its parent. `more(k, under)` adds fields to kept line `k`. */
export function itemsOf(lines, more = () => null){
  const kept = lines.map(x => !!x.p.title), at = [];
  for (const ok of kept) at.push(ok ? at.filter(k => k >= 0).length : -1);
  const up = i => { let u = lines[i].under ?? null; while (u !== null && !kept[u]) u = lines[u].under ?? null; return u === null ? null : at[u]; };
  return lines.flatMap((x, i) => kept[i] ? [{raw: x.raw, p: {...packParsed(x.p), ...more(at[i], up(i))}, under: up(i)}] : []);
}
// Vikunja's codes for a label, a person or a link the task already has.
export const ALREADY = {label: 8001, assignee: 4021, link: 4008};
/* How a run (a started checklist) is set up from its template. As with a line, the outbox entry (`j`) keeps how far
   it got, so a cut-off try carries on where it stopped. If a copy reached Vikunja but its reply was lost, the copy is
   found again through the template's "copied to" links instead of being made twice. */
// Copy a task. `rec` records when the try began and, if it fails, when it ended. A copy made despite the failure was
// made between those two times, so it can be found.
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
    // The template's notes come with the copy, but its order line does not, because that line holds the ids of the
    // template's steps. A line is added that marks the copy as a run, so it stays a run if its template is deleted.
    j.desc = withRunMark(notesOnly(t.description));
  }},
  // The run is named after its template, the day, and the name typed when it was started. Without a typed name it
  // gets its number among the template's runs: "Startup · Oct 3 · Night shift" or "Startup · Oct 3 · #3".
  //
  // The run gets no due date, because its steps have their own. The exception is a start that ticks the template
  // (`tick`). Then the run gets the time the template was due, so a run left open shows on Today. The run does not
  // repeat or remind. The template does, and the copy would otherwise inherit that.
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
  // Each step of the template is handled in the template's order. Pocket copies the template's step and links the copy
  // under the run. It then removes T# and {#name} from the title, and gives the step its due time if it counts from
  // the start.
  //
  // A timed step gets a reminder at its due time. Vikunja emails the reminder to whoever started the run and anyone
  // on the step. Pocket's plugin moves the reminder along with the due date it sets. A step due less than a minute
  // after the step it waits on gets no reminder, because Vikunja checks for reminders once a minute and this one
  // would already be past.
  //
  // Each call does one part of one step, so progress is saved after each part.
  {name: 'step', done: j => j.steps.every(s => s.ready), async run(j, c){
    const s = j.steps.find(s => !s.ready);
    if (!s.taskId) {
      const t = (s.tried && await app.findCopy(s.from, s, j.at, c.taken, j.id, j.runId)) || await duplicate(s.from, s, c.save);
      sync.claim(t.id, j.id); c.taken.add(t.id); s.taskId = t.id; s.desc = t.description || '';
    } else if (!s.linked) {
      try { await app.linkSubtask(j.runId, s.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
      s.linked = true;
    } else {
      // The title is the template step's title, which the step's time was read from. Changing the template later
      // affects only runs started after the change.
      await patchTask(s.taskId, {title: s.title, done: false, due_date: s.due || ZERO, repeat_after: 0, repeat_mode: 0,
        ...(s.remind ?? s.timed) && {reminders: [{relative_to: 'due_date', relative_period: 0}]},
        ...s.tpl != null && s.desc != null && {description: withStepLine(copiedNotes(s.desc), s.tpl)}});
      s.ready = true;
    }
  }},
  // The run's own order line, holding the ids of the copied steps. From now on the run never reads its template's
  // order, and a step inserted during the run goes in this line. Writing it again after a lost reply gives the same
  // line.
  {name: 'order', done: j => !!j.ordered, async run(j){
    await patchTask(j.runId, {description: withOrder(j.desc ?? '', j.steps.map(s => s.taskId))});
    j.ordered = true;
  }},
  // Assign only the run to the people it is for, so Vikunja notifies them once and not once per step. A step assigned
  // in the template, say to QA, keeps its assignee, because the copy keeps it.
  {name: 'assign', done: j => !!j.assigned, async run(j){
    await api(`/tasks/${j.runId}/assignees/bulk`, {method: 'PUT', body: {assignees: j.for.map(u => ({id: u.id}))}});
    j.assigned = true;
  }},
  // The copy has the template's labels, including "template". That label is removed last. Until then the run is not a
  // run anywhere (roleOf), so teammates can't start on it before it is complete. The label is looked up first because
  // Vikunja refuses to remove a label that isn't there.
  {name: 'unlabel', done: j => !!j.unlabeled, async run(j){
    for (const l of (await api('/tasks/' + j.runId)).labels || []) if (isTemplateLabel(l)) await api(`/tasks/${j.runId}/labels/${l.id}`, {method: 'DELETE'});
    j.unlabeled = true;
  }},
  /* This step comes last, so a cancelled start ticks nothing. When the start is for the time the template was due
     (`tick`), the template is ticked, but only while it is not done at that time. So a start sent again after a lost
     reply doesn't tick it twice.

     Vikunja moves a repeating template to its next date. A template that doesn't repeat becomes done and loses its
     date, because its schedule is over. A template that repeats every month moves forward one month only. If it was
     left for months, it is moved on again to the first time after now on its schedule. That count starts from where
     this tick put it, so a change made since then stays.

     `ticked` records where the template went, for Undo. */
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
// How much of a run is set up, out of 6 parts plus 3 per step.
export const runProgress = j => [j.runId, j.unlabeled, j.named, j.ordered, j.assigned, j.ticked, ...j.steps.flatMap(s => [s.taskId, s.linked, s.ready])].filter(Boolean).length;
/* A step inserted in a run, or repeated, is set up the same way, and the entry (`j`) keeps how far it got. An
   inserted step is a new task under the run.

   A repeated step is a copy of the template step that the repeated step came from (`from`). So it has that step's
   notes and photos, but none from this run. If the reply was lost, the copy is found again through "copied to".

   Either kind is marked "pocket:added". A repeated step also keeps the "pocket:step" line of the step it repeats
   (`tpl`). Either kind goes in the run's order before the step it was inserted at (`before`). */
export const INSERT_STEPS = [
  {name: 'task', done: j => !!j.taskId, async run(j, c){
    if (j.from) {
      const t = (j.tried && await app.findCopy(j.from, j, j.at, c.taken, j.id, j.run)) || await duplicate(j.from, j, c.save);
      sync.claim(t.id, j.id); j.taskId = t.id; j.desc = t.description || '';
    } else {
      // A new task under the run, with what quick add parsed. Its requests' keys are made from the entry's id, so a
      // lost reply never makes it twice.
      j.job ||= {key: j.id};
      const t = await app.createTask(j.p ? unpackParsed(j.p) : {title: j.title, labels: [], assignees: []}, j.project, {job: j.job, save: c.save, parent: j.run});
      Object.assign(j, {taskId: t.id, linked: true, desc: j.desc ?? ''});
    }
  }},
  {name: 'link', done: j => !!j.linked, async run(j){
    try { await app.linkSubtask(j.run, j.taskId); } catch (e) { if (e.code !== ALREADY.link) throw e; }
    j.linked = true;
  }},
  // The step starts not done, with no due date, and it doesn't repeat or remind. It is done when someone does it.
  {name: 'mark', done: j => !!j.marked, async run(j){
    const notes = copiedNotes(j.desc), desc = withAdded(j.tpl != null ? withStepLine(notes, j.tpl) : notes);
    // A repeated step's title is its template step's title without T#. An inserted step's title is the one quick add
    // sent, without @people.
    await patchTask(j.taskId, {...(j.from || j.tpl != null) && {title: j.title}, done: false, due_date: ZERO, repeat_after: 0, repeat_mode: 0, reminders: [], description: desc});
    j.marked = true;
  }},
  // Put the step before the step it was inserted at. The run's order is read as it is now, so a step inserted in the
  // meantime stays. If the step it was inserted at was deleted in the meantime, put it after the step it was inserted
  // under.
  {name: 'order', done: j => !!j.ordered, async run(j){
    const after = typeof j.after === 'string' ? sync.taskOf(j.after.replace(/^pending-/, '')) : j.after ?? null;
    await app.saveTask(j.run, null, now => {
      if (stepOrder(now.description)?.includes(j.taskId)) return null;
      return {description: withOrder(now.description, placeBefore(stepsOf(now).map(s => s.id).filter(id => id !== j.taskId), j.taskId, j.before, after))};
    });
    j.ordered = true;
  }},
  // A new step at 0% lowers the run's progress. The progress is written once the step is in the run.
  {name: 'figure', done: j => !!j.figured, async run(j){ await app.writeFigure(j.run); j.figured = true; }},
];
/* Whether a deletion can still be restored. In the tab that made it, that lasts until its rows or its message leave
   the screen (sync.held). In another tab, or after a reload, it lasts until `until`. */
export const held = e => sync.held.has(e.id) || e.until > Date.now();
/* The value of <html data-sync>, which the tests wait on. It is 'sending' while a change is on its way. It is
   'waiting' while an entry is kept that can't be sent now (no connection, a restorable deletion, a refusal, Vikunja
   busy), or while the outbox isn't read yet (`unsent` is null). Otherwise it is 'idle'. */
export const sendState = ({busy, unsent}) => busy ? 'sending' : unsent === 0 ? 'idle' : 'waiting';
/* A change shows on screen at once. It looks like it is waiting (dotted, "waiting to send") only after WAIT_MS without
   an answer, or at once without a connection. Most changes are answered well within WAIT_MS, so a row doesn't flicker.
   Returns the ids of the entries that look waiting at `now`, and the time the next entry will look waiting (null for
   none). */
export const WAIT_MS = 2500;
export function slowness(entries, now, offline){
  const slow = [], later = [];
  for (const e of entries) { const at = Date.parse(e.at) + WAIT_MS; if (offline || !(at > now)) slow.push(e.id); else later.push(at); }
  return {slow, next: later.length ? Math.min(...later) : null};
}
// What a failed act holds back: the acts on its task, or for an add the lines under it and the acts on its task.
const holds = e => e.op === 'add' ? ['pending-' + e.id, ...e.taskId ? [e.taskId] : []] : [e.task];
// The tasks with an act that Vikunja rejected. Later acts on those tasks wait, so an untick never arrives before its
// tick.
export const heldTasks = entries => new Set(entries.filter(e => e.kind === 'act' && e.failed).flatMap(holds));
export const hold = (e, stopped) => { for (const k of holds(e)) stopped.add(k); };
// Whether act `e` waits behind a failed act (`stopped`, from heldTasks). A line waits only for a failed line it goes
// under, never for another op on its parent. Then the lines under it wait too.
export const waits = (e, stopped) => {
  if (e.op !== 'add') return stopped.has(e.task);
  const w = typeof e.under === 'string' && stopped.has(e.under);
  if (w) stopped.add('pending-' + e.id);
  return w;
};
