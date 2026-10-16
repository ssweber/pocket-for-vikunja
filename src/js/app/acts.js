// Queue a change as an op (src/js/ops/), and send the outbox's ops in order, each request with its own key.
import {taskDrafts} from '../util.js';
import {api, ApiError, passing, serverTime} from '../api.js';
import {htmlToText} from '../html.js';
import {parseStep, patiently} from '../checklists.js';
import {CANCEL, held, heldTasks, hold, KEPT, NO_ROOM, NOT_KEPT, older, sync, uuid7, waits} from '../sync.js';
import {saved} from '../lists.js';
import {notKnown, toOutbox, UNKNOWN} from '../messages.js';
import {OPS} from '../ops/index.js';
import {CREATED, opsId, TASK} from './tasks.js';

let actCount = 0;                                // orders things done in the same millisecond
export const nextN = () => ++actCount;
/* For each op queued in this tab whose Undo can still be tapped, the op that undoes it (`inverts`), built from the
   entry as queued, and from Vikunja's answer once this tab sees it. An op a later op replaced (fold) moves to
   `folded`. Both forget an op once its Undo has gone (forgetUndo). */
const inverts = new Map(), folded = new Set();
// How many ops this tab keeps an Undo for, for the tests.
export const undosKept = () => inverts.size + folded.size;
/* Keep local completion times for offline ticks so countdowns do not jump or chime again when Vikunja receives
   them. Map each step to {here, there, kept}, using Vikunja's completion time to identify the tick. Expire these
   records after a day. */
let ticks = null;
export const keptTicks = () => ticks ||= saved.get('ticks') || {};
/* Once a line's task is made, its photos still waiting move to an entry of their own, as a task's sheet makes one, in
   the save that records the task. So a photo that Vikunja keeps refusing never holds back the ops after the line. */
const filesOut = a => {
  if (a.op !== 'add' || !a.taskId || !a.files?.some(f => !f.sent)) return [];
  const f = {id: uuid7(), user: a.user, at: a.at, n: a.n, taskId: a.taskId, files: a.files.filter(x => !x.sent)};
  a.files = []; a.filed = f.id;
  return [f];
};

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
      if (!a.sent) { a.sent = true; await save(); }                         // from now on Cancel can't stop it
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
     at once, before it is saved on the phone. Returns how sending went, with the entry's id (`entry`). With `quiet`,
     the caller says what became of it. */
  async act(fields, quiet = false){
    const run = fields.run ?? this.view.shownRun?.id;
    if (this.toast.show && this.toast.startOf && this.toast.startOf === run) this.toast.show = false;
    if (this.places.run?.startOf === run) this.endPlace('run', this.places.run, false);
    return this.actAll([fields], quiet);
  },
  /* Queue ops (their fields) together, so their rows show in one change (rule 10), fold each into an earlier op it
     replaces, and send through the last. Returns how sending went, with the last entry's id (`entry`) and every
     result (`all`). A caller that shows an Undo for an op with an invert calls forgetUndo once that Undo has gone. */
  async actAll(list, quiet = false){
    const entries = list.map(f => this.actEntry(f)), last = entries.at(-1).id;
    for (const e of entries) if (OPS[e.op].invert) inverts.set(e.id, OPS[e.op].invert(e));
    const {kept, full} = await this.queue(entries);
    await sync.lock(() => this.fold(entries));
    return {...await this.sendActs(last, kept, full, quiet ? new Set(entries.map(e => e.id)) : null), entry: last};
  },
  /* Fold each of `entries`, just queued, into the op before it on its task, if that op has sent nothing, isn't held,
     hasn't failed and isn't an Undo. The new op's merge decides what becomes of the two. Only the op just before it
     counts, so a fold never moves an op past another op on its task. An Undo is never folded, so its check is never
     lost. Runs inside the outbox's lock, so the sender can't start the earlier op meanwhile. */
  async fold(entries){
    const on = new Map();
    for (const x of sync.all(entries[0]?.user)) if (x.kind === 'act') on.set(opsId(x.task), [...on.get(opsId(x.task)) || [], x]);
    for (const e of entries) {
      const merge = !e.undo && OPS[e.op].merge;
      if (!merge) continue;
      let x = null;
      for (const y of (on.get(opsId(e.task)) || []).filter(y => older(y, e) < 0).reverse()) if ((x = await sync.fresh(y.id))) break;
      const m = x && !x.sent && !x.failed && !x.undo && !held(x) && merge(x, e);
      if (!m) continue;
      if (inverts.delete(x.id)) folded.add(x.id);
      if (m === CANCEL) {
        if (inverts.delete(e.id)) folded.add(e.id);
        await sync.remove(e.id); await sync.remove(x.id);
        continue;
      }
      Object.assign(e, m);
      if (inverts.has(e.id)) inverts.set(e.id, OPS[e.op].invert(e));
      await sync.save(e); await sync.remove(x.id);
    }
  },
  /* Undo the ops queued from `list` (their fields, with each entry's id). The rows show the Undo at once, though the
     outbox may be busy sending. Then, in the outbox's lock, an op that has sent nothing, or that Vikunja refused,
     leaves the outbox, and its rows show the task without it. An op whose answer is unknown leaves too, and its
     invert is queued, checked against what it sent. Any other op's invert is queued, built from Vikunja's answer when
     this tab saw it. An op that a later op replaced (fold) counts as changed since, and stays. Returns `left`, which
     resolves to how many Undos were left alone: changed since, or refused. */
  undoOps(list){
    const now = list.filter(f => !folded.has(f.id)), invert = (f, e) => e ? OPS[f.op].invert(e) : inverts.get(f.id) ?? OPS[f.op].invert(f);
    const shown = this.change(w => now.flatMap(f => {
      const i = invert(f, sync.entries.get(f.id)), id = i && opsId(i.task), t = i && this.tasks[id];
      if (!t) return [];
      const to = OPS[i.op].apply(t, i);
      return [w.edit(id, Object.fromEntries(Object.entries(to).filter(([k, v]) => v !== t[k])))];
    }));
    const undo = async () => {
      const back = [];
      let left = list.length - now.length;
      await sync.lock(async () => {
        for (const f of now) {
          if (folded.has(f.id)) { left++; continue; }                     // replaced while Undo waited for the lock
          const e = await sync.fresh(f.id), unknown = e?.failed?.message === UNKNOWN;
          if (e && (!e.sent || e.failed)) await sync.remove(f.id);
          const inv = (!e || (e.sent && (!e.failed || unknown))) && invert(f, e);
          if (inv) back.push({...inv, run: null, undo: true});
        }
      });
      this.forgetUndo(list);
      const entries = back.map(f => this.actEntry(f)), ids = new Set(entries.map(e => e.id)), {kept, full} = entries.length ? await this.queue(entries) : {};
      if (!entries.length) this.refreshPending();
      // The rows now show the Undo through the outbox.
      this.change(() => { for (const x of shown) x.undo(); });
      const r = entries.length ? await this.sendActs(entries.at(-1).id, kept, full, ids) : {all: []};
      return left + r.all.filter(x => ids.has(x.id) && x.status === 'error').length;
    };
    return {left: undo()};
  },
  // Forget the Undos of the ops queued from `list`, once they can't be tapped: their message has gone, or Undo ran.
  forgetUndo(list){ for (const f of list) { inverts.delete(f.id); folded.delete(f.id); } },
  // An op's outbox entry. It stores the task's title so the Outbox can name the action after a reload, and the
  // user as /user gave them, for the ✅, the comment or the claim the op shows.
  actEntry(fields){
    const me = this.user;
    return {id: uuid7(), kind: 'act', user: me?.id, who: me && {id: me.id, username: me.username, name: me.name || ''}, at: new Date().toISOString(), n: nextN(),
      files: [], stage: 0, fails: 0, run: this.view.shownRun?.id, label: this.actTitle(fields.task), ...fields};
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
     result, with every result in `all`, each with its entry's `id` and its line's `batch`. An add box reads its own
     lines' results there. The lines of other batches sent on the way are reported as flush reports them (reportSent).
     The entries in `quiet` get no message here, because their caller says what became of them. */
  async sendActs(id, kept = true, full = false, quiet = null){
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
          // The add box and flush say what became of a line.
          if (e.op !== 'add') this.say(`Not sent. Vikunja refused an earlier change to “${parseStep(e.label || 'it').title}”.`, {place: 'step', cls: 'failed', action: toOutbox(this)});
          last = {status: 'offline', reached: true};
          break;
        }
        last = await this.sendEntry(e.id);
        out.push({...last, id: e.id, batch: e.batch, add: e.op === 'add'});
        if (last.kept) hold(e, stopped);
        // A failed move shows its own message on the row (reorder), and a line in its add box, so none here.
        const err = last.error;
        // A stage that knows the whole sentence gives it (`said`).
        if (last.status === 'error' && !quiet?.has(e.id) && e.op !== 'position' && e.op !== 'add') this.say(err.said || (err.code === 'unknown' ? notKnown(err.what)
          : `${err.what || 'It'} couldn't be saved${err.saved ? ` in full (${err.saved})` : ''}: ${err.message}.` + (last.kept ? KEPT : this.wordsBack(err))),
          {place: 'step', cls: 'failed', action: last.kept ? toOutbox(this) : null});
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
     made (`tasks`, for placeSent) and its problems, and uploads its photos once it is sent (`filesWait` while they
     wait). When Vikunja refuses an add, it and the later lines of its batch leave the outbox (refuseLines). */
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
      // step was never created. A line whose line is gone without a task leaves with the lines under it, and their
      // text goes back to their box, as after Cancel.
      for (const k of ['task', 'under']) if (typeof a[k] === 'string') {
        const key = a[k].replace(/^pending-/, ''), id = sync.taskOf(key);
        if (!id && sync.entries.has(key)) return {...got(), status: 'offline', reached: true};
        if (!id && k === 'task') throw new ApiError(404, 'the step it was for couldn\'t be added');
        if (!id) { this.linesBack(await this.dropUnder(a[k], a.user), {}); return {...none, status: 'gone'}; }
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
        await sync.save(a, [], filesOut(a));
      }
      this.change(w => w.answered(a, c.task, c.comment));
      if (inverts.has(a.id)) inverts.set(a.id, op.invert(a));
      if (a.op === 'position') this.positionSent(a);
      await sync.remove(a.id, add ? a.taskId : null);
      // A line's photos upload now, from their own entry. If Vikunja is busy they wait there, and the add box says so.
      const f = add && a.filed ? await sync.fresh(a.filed) : null, files = f ? await this.sendFileEntry(f, none.tasks) : null;
      if (!a.run && a.op === 'note' && this.sheet.id === a.task) this.loadComments(a.task);   // a comment from a task's sheet
      if (a.op !== 'finish' && a.op !== 'reopen' && this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
      return {...got(), status: 'sent', changed: add ? 0 : 1, uploaded: files?.uploaded || 0, problems: [...none.problems, ...files?.problems || []], filesWait: files?.status === 'offline'};
    } catch (error) {
      if (passing(error) || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++a.fails < 5)))) {
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
      // Restore rejected note text to its draft. Keep other rejected actions in the Outbox so a missed
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
    const photos = await this.photosOf(rest);
    for (const e of rest) await sync.remove(e.id, e.taskId ?? null);
    return {unsent: rest.filter(e => !e.taskId).map(e => e.raw), photos, parent: a.parent || null};
  },
  // The photos waiting on `lines`, read before the lines leave the outbox and their bytes with them.
  async photosOf(lines){ return (await Promise.all(lines.flatMap(e => (e.files || []).filter(f => !f.sent).map(f => sync.file(f.key))))).filter(Boolean); },
  // Remove the lines under waiting id `name`, at every level, and return them. Runs inside the outbox's lock.
  async dropUnder(name, user){
    const names = new Set([name]), out = [];
    for (const x of sync.all(user)) if (x.op === 'add' && names.has(x.under)) { names.add('pending-' + x.id); out.push(x); await sync.remove(x.id); }
    return out;
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
