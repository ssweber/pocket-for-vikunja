// Queue a change as an op (src/js/ops/), and send the outbox's ops in order, each request with its own key.
import {taskDrafts} from '../util.js';
import {api, ApiError, passing, serverTime} from '../api.js';
import {htmlToText} from '../html.js';
import {parseStep, patiently} from '../checklists.js';
import {held, heldTasks, hold, KEPT, NO_ROOM, NOT_KEPT, sync, uuid7, waits} from '../sync.js';
import {saved} from '../lists.js';
import {notKnown, UNKNOWN} from '../messages.js';
import {OPS} from '../ops/index.js';
import {CREATED, opsId, TASK} from './tasks.js';

let actCount = 0;                                // orders things done in the same millisecond
export const nextN = () => ++actCount;
/* Keep local completion times for offline ticks so countdowns do not jump or chime again when Vikunja receives
   them. Map each step to {here, there, kept}, using Vikunja's completion time to identify the tick. Expire these
   records after a day. */
let ticks = null;
export const keptTicks = () => ticks ||= saved.get('ticks') || {};

/* What a stage is given to make its requests. `send` is a write with the next key: the entry's key, the stage's index,
   and the part, counted from 0 each time the stage runs. So a stage sent again after a lost reply sends each request
   with the key it had, and the relay answers the ones already made from what it stored. `once` keeps a body built from
   a read in the entry, so a retry sends the same body. `a.key` replaces the entry's id after Try again. A stage puts
   Vikunja's copy of the task in `task`, and a comment Vikunja made in `comment`. Both are kept in the entry (`a.got`),
   so the answer has them when a later stage finishes on another try. `start(at)` starts the parts at `at`, and `skip`
   counts a part without sending it, so the requests after it keep their keys. A job that is not in the outbox, such as
   the template editor's, passes its own `save` (createTask, sending.js). */
export function stageContext(a, app, save = () => sync.save(a)){
  let part = 0;
  return {app, save,
    get task(){ return a.got?.task ?? null; }, set task(t){ (a.got ||= {}).task = t; },
    get comment(){ return a.got?.comment ?? null; }, set comment(x){ (a.got ||= {}).comment = x; },
    start(at = 0){ part = at; return this; },
    skip(){ part++; },
    async send(path, opts){
      if (!a.sent) { a.sent = true; await save(); }                         // from now on Don't send it can't stop it
      return api(path, {...opts, key: `${a.key || a.id}:${a.stage}:${part++}`});
    },
    read: path => api(path),
    async once(name, build){
      const f = a.fixed ||= {};
      if (!(name in f)) { f[name] = await build() ?? null; await save(); }
      return f[name];
    }};
}

export default {
  /* Queue every run action behind earlier pending actions so Vikunja receives them in order. The op shows on its task
     at once, before it is saved on the phone. Returns how sending went, with the entry's id (`entry`). */
  async act(fields){
    const run = fields.run ?? this.view.shownRun?.id;
    if (this.toast.show && this.toast.startOf && this.toast.startOf === run) this.toast.show = false;
    if (this.places.run?.startOf === run) this.endPlace('run', this.places.run, false);
    const entry = this.actEntry(fields), {kept, full} = await this.queue([entry]);
    return {...await this.sendActs(entry.id, kept, full), entry: entry.id};
  },
  // An op's outbox entry. It stores the task's title so Waiting to send can name the action after a reload, and the
  // user as /user gave them, for the ✅, the comment or the claim the op shows.
  actEntry(fields){
    const me = this.user;
    return {id: uuid7(), kind: 'act', user: me?.id, who: me && {id: me.id, username: me.username, name: me.name || ''}, at: new Date().toISOString(), n: nextN(),
      items: [], files: [], stage: 0, fails: 0, run: this.view.shownRun?.id, label: this.actTitle(fields.task), ...fields};
  },
  // Save `entries` in the outbox, the first with `files`, and show them at once. Returns whether all of them reached
  // the database (`kept`), and whether the phone is out of space (`full`).
  async queue(entries, files = []){
    const adding = Promise.all(entries.map((e, i) => sync.add(e, i ? [] : files)));
    this.refreshPending();
    const r = await adding;
    return {kept: r.every(x => x.kept), full: r.some(x => x.full)};
  },
  /* Send through action `id` in order. Keep deletions held while Restore is still available. Returns the last one's
     result, with every result in `all`, each with its line's `batch`. An add box reads its own lines' results there.
     The lines of other batches sent on the way are reported as flush reports them (reportSent). */
  async sendActs(id, kept = true, full = false){
    // An add box shows what it sent itself, swapping each waiting row for its task in one go (submitCapture). A
    // refresh here would draw the list without either in between.
    const lines = sync.entries.get(id)?.op === 'add';
    if (!lines) this.refreshPending();
    let last = {status: 'gone'}, batch;
    const out = [];
    await sync.lock(async () => {
      const all = sync.all(this.user?.id).filter(e => e.kind === 'act' && (e.id === id || !held(e))), stopped = heldTasks(all);
      batch = all.find(e => e.id === id)?.batch;
      for (const e of all) {
        if (e.failed || waits(e, stopped)) {                                 // waits behind an earlier action Vikunja refused
          if (e.id !== id) continue;
          this.say(`Not sent. Vikunja refused an earlier change to “${parseStep(e.label || 'it').title}”. Tap the warning sign at the top to try that change again.`, {place: 'step', cls: 'failed'});
          last = {status: 'offline', reached: true};
          break;
        }
        last = await this.sendEntry(e.id);
        out.push({...last, batch: e.batch, add: e.op === 'add'});
        if (last.kept) hold(e, stopped);
        // A failed move shows its own message on the row (reorder), and a line in its add box, so none here.
        const err = last.error;
        if (last.status === 'error' && e.op !== 'position' && e.op !== 'add') this.say(err.code === 'unknown' ? notKnown(err.what)
          : `${err.what || 'It'} couldn't be saved${err.saved ? ` in full (${err.saved})` : ''}: ${err.message}.` + (last.kept ? KEPT : this.wordsBack(err)), {place: 'step', cls: 'failed'});
        if (last.status === 'offline' || e.id === id) break;
      }
    });
    if (!lines) this.refreshPending();
    const others = out.filter(x => x.add && x.batch !== batch);
    if (others.length) this.reportSent(others);
    if (last.status === 'offline') { sync.keep(); if (!kept) this.say(full ? NO_ROOM : NOT_KEPT, {place: 'step', cls: 'failed'}); }
    return {...last, all: out};
  },
  /* Send an act's stages from where an earlier try stopped, saving the entry after each. An add also gives the tasks it
     made (`tasks`, for placeSent) and its problems, and uploads its photos once its task is made. When Vikunja refuses
     an add, it and the later lines of its batch leave the outbox (refuseLines). */
  async sendAct(a){
    const op = OPS[a.op], c = stageContext(a, this), add = a.op === 'add', none = {ids: [], tasks: [], problems: add ? a.problems ||= [] : [], uploaded: 0};
    const got = () => ({...none, ids: add && a.stage >= op.stages.length ? [a.taskId] : [], projectId: a.projectId});
    if (add) {
      c.made = t => { this.change(w => w.answer([t], CREATED)); none.tasks.push({...t, child: a.under != null, parent: a.under, was: 'pending-' + a.id, place: a.p.position || 0}); };
      // A task that arrived done, or with progress, shows that on its row (placeSent).
      c.arrive = x => { this.change(w => w.answer([x.now], TASK)); for (const t of none.tasks) t.arrived = x; };
    }
    try {
      // Wait for the real id of an offline step, or of the line this line goes under. Reject a step's action if the
      // step was never created. A line whose line is gone becomes a task of its own, as Cancel makes it.
      for (const k of ['task', 'under']) if (typeof a[k] === 'string') {
        const key = a[k].replace(/^pending-/, ''), id = sync.taskOf(key);
        if (!id && sync.entries.has(key)) return {...got(), status: 'offline', reached: true};
        if (!id && k === 'task') throw new ApiError(404, 'the step it was for couldn\'t be added');
        a[k] = id; await c.save();
      }
      // A request that gets no answer may still have reached Vikunja, and after it the act can't be dropped. So an act
      // not yet sent waits while Pocket knows it is offline, and flush sends it once a read gets through. Flush runs
      // now, outside the outbox lock, so a tick made after a brief drop doesn't wait for the 30-second timer.
      if (!a.sent && (this.offline || navigator.onLine === false)) {
        if (navigator.onLine !== false) setTimeout(() => this.flush());
        this.offline = true; return {...none, status: 'offline', reached: false};
      }
      // A busy Vikunja is retried a few times. With keys, sending a stage again is safe.
      while (a.stage < op.stages.length) {
        await patiently(() => op.stages[a.stage](a, c.start()));
        a.stage++;
        await c.save();
      }
      this.change(w => w.answered(a, c.task, c.comment));
      if (a.op === 'position') this.positionSent(a);
      const uploaded = add ? await this.sendFiles(a, a.taskId, none.tasks) : (await sync.remove(a.id), 0);
      if (!a.run && a.op === 'note' && this.sheet.id === a.task) this.loadComments(a.task);   // a comment from a task's sheet
      if (a.op !== 'finish' && a.op !== 'reopen' && this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
      return {...got(), status: 'sent', changed: add ? 0 : 1, uploaded};
    } catch (error) {
      // A file Vikunja was busy with (sendFile) waits too.
      if (passing(error) || error.again || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++a.fails < 5)))) {
        await c.save();
        return {...got(), status: 'offline', reached: error instanceof ApiError && error.status !== 401};
      }
      // The relay can't tell whether Vikunja made the change. Only the user can check, so it is kept for Try again.
      const unknown = error.code === 'unknown';
      if (unknown) error.message = UNKNOWN;
      // A refused move is reverted on screen at once instead of being retried later.
      if (a.op === 'position' && !unknown) error.drop = true;
      // If part of the action saved before rejection, show that result from Vikunja and explain the partial save.
      if (a.stage > 0 && op.saved) error.saved = op.saved;
      if (c.task) this.change(w => w.answer([c.task], TASK));
      if (a.stage > 0 && this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
      error.what = op.refused(a, a.label || this.actTitle(a.task));
      // Reload after a permanent rejection when no retry remains queued.
      if (error.drop) {
        await sync.remove(a.id);
        if (this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
        if (this.sheetTask && this.sheet.kind === 'task') this.loadSubPeople(this.sheetTask);
        return {...none, status: 'error', error};
      }
      // Restore rejected note text to its draft. Keep other rejected actions under Waiting to send so a missed
      // toast does not lose the retry.
      if (a.op === 'note' && !unknown) { await sync.remove(a.id); this.giveBack(a, error); return {...none, status: 'error', error}; }
      if (add && !unknown) return {...got(), ...await this.refuseLines(a), status: 'error', error};
      a.failed = {message: error.message, at: new Date().toISOString()}; a.fails = 0;
      await c.save();
      return {...got(), status: 'error', error, kept: true};
    }
  },
  /* A refused line, and the lines typed after it that are not sent yet, leave the outbox. Each of them goes under it or
     was meant to come after it. Returns their text for the box they were typed in (`unsent`), the photos added with
     them, and the task the box added to (`parent`). Runs inside the outbox's lock. */
  async refuseLines(a){
    const rest = sync.all(a.user).filter(e => e.op === 'add' && e.batch === a.batch && (e.id === a.id || (!e.sent && (e.n || 0) > (a.n || 0))));
    const photos = (await Promise.all(rest.flatMap(e => (e.files || []).filter(f => !f.sent).map(f => sync.file(f.key))))).filter(Boolean);
    for (const e of rest) await sync.remove(e.id);
    return {unsent: rest.filter(e => !e.taskId).map(e => e.raw), photos, parent: a.parent || null};
  },
  /* Restore text from an unsent action and set error.back. If its task was deleted, put the text in error.words so
     the message can preserve it. */
  giveBack(a, error){
    const text = a.html ? htmlToText(a.html).replace(/^Skipped:?\s*/, '').trim() : '';
    if (!text) return;
    if (error.status === 404) { error.words = text; return; }
    const add = (was = '') => [was.trim(), text].filter(Boolean).join('\n');
    if (!a.run) {
      taskDrafts.set('comment:' + a.task, add(taskDrafts.get('comment:' + a.task)));
      if (this.sheet.id === a.task) this.sheet.commentDraft = add(this.sheet.commentDraft);
    } else this.runDrafts[a.task] = add(this.runDrafts[a.task]);
    error.back = true;
  },
  wordsBack(e){ return e.back ? ' Its text is back in the box.' : e.words ? ` It said: “${e.words}”` : ''; },
  keepTick(a, there){
    const here = serverTime(+new Date(a.at));
    if (Date.parse(there) - here < 5000) return;                           // sent as it was done
    ticks = Object.fromEntries(Object.entries(keptTicks()).filter(([, x]) => Date.now() - x.kept < 864e5));
    ticks[a.task] = {here: new Date(here).toISOString(), there, kept: Date.now()};
    saved.set('ticks', ticks);
    this.runNow = Date.now();                                              // Recompute the run because Alpine does not watch the saved local tick times.
  },
  actTask(a){ return opsId(a.task); },
};
