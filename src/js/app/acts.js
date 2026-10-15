// Queue a change as an op (src/js/ops/), and send the outbox's ops in order, each request with its own key.
import {raw, taskDrafts} from '../util.js';
import {api, ApiError, passing, serverTime} from '../api.js';
import {htmlToText} from '../html.js';
import {DONE_MARK, parseStep, patiently, SKIP_MARK} from '../checklists.js';
import {actTaskId, held, heldTasks, KEPT, NO_ROOM, NOT_KEPT, sync, uuid7} from '../sync.js';
import {saved} from '../lists.js';
import {notKnown, UNKNOWN} from '../messages.js';
import {OPS} from '../ops/index.js';
import {copyOf, put} from './tasks.js';

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
   Vikunja's copy of the task in `task`, and a comment Vikunja made in `comment`. */
export function stageContext(a, app){
  let part = 0;
  const save = () => sync.save(a);
  return {app, save, comment: null, task: null,
    start(){ part = 0; return this; },
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
  /* Queue every run action behind earlier pending actions so Vikunja receives them in order. Returns how sending went,
     with the entry's id (`entry`). */
  async act(fields){
    const run = fields.run ?? this.view.shownRun?.id;
    if (this.toast.show && this.toast.startOf && this.toast.startOf === run) this.toast.show = false;
    if (this.places.run?.startOf === run) this.endPlace('run', this.places.run, false);
    // Store the task's title so Waiting to send can name the action after a reload.
    const entry = {id: uuid7(), kind: 'act', user: this.user?.id, at: new Date().toISOString(), n: nextN(), items: [], files: [], stage: 0, fails: 0,
      run: this.view.shownRun?.id, label: this.actTitle(fields.task), ...fields};
    const {kept, full} = await sync.add(entry, []);
    return {...await this.sendActs(entry.id, kept, full), entry: entry.id};
  },
  // Send through action `id` in order. Keep deletions held while Restore is still available.
  async sendActs(id, kept = true, full = false){
    this.refreshPending();
    let last = {status: 'gone'};
    await sync.lock(async () => {
      const all = sync.all(this.user?.id).filter(e => e.kind === 'act' && (e.id === id || !held(e))), stopped = heldTasks(all);
      for (const e of all) {
        if (e.failed || stopped.has(e.task)) {                               // waits behind an earlier action Vikunja refused
          if (e.id !== id) continue;
          this.say(`Not sent. Vikunja refused an earlier change to “${parseStep(e.label || 'it').title}”. Tap the warning sign at the top to try that change again.`, {place: 'step', cls: 'failed'});
          last = {status: 'offline', reached: true};
          break;
        }
        last = await this.sendEntry(e.id);
        if (last.kept) stopped.add(e.task);
        // A failed move shows its own message on the row (reorder), so none here.
        const err = last.error;
        if (last.status === 'error' && e.op !== 'position') this.say(err.code === 'unknown' ? notKnown(err.what)
          : `${err.what || 'It'} couldn't be saved${err.saved ? ` in full (${err.saved})` : ''}: ${err.message}.` + (last.kept ? KEPT : this.wordsBack(err)), {place: 'step', cls: 'failed'});
        if (last.status === 'offline' || e.id === id) break;
      }
    });
    this.refreshPending();
    if (last.status === 'offline') { sync.keep(); if (!kept) this.say(full ? NO_ROOM : NOT_KEPT, {place: 'step', cls: 'failed'}); }
    return last;
  },
  // Send an act's stages from where an earlier try stopped, saving the entry after each.
  async sendAct(a){
    const op = OPS[a.op], c = stageContext(a, this), none = {ids: [], tasks: [], problems: [], uploaded: 0};
    try {
      // Wait for an offline step's real id. Reject its action if the step was never created.
      if (typeof a.task === 'string') {
        const key = a.task.replace(/^pending-/, ''), id = sync.taskOf(key);
        if (!id && sync.entries.has(key)) return {...none, status: 'offline', reached: true};
        if (!id) throw new ApiError(404, 'the step it was for couldn\'t be added');
        a.task = id; await c.save();
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
      this.answered(a, c.task);
      this.applyAct(a, c.comment);
      await sync.remove(a.id);
      if (!a.run && a.op === 'note' && this.sheet.id === a.task) this.loadComments(a.task);   // a comment from a task's sheet
      if (a.op !== 'finish' && a.op !== 'reopen' && this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
      return {...none, status: 'sent', changed: 1};
    } catch (error) {
      if (passing(error) || (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++a.fails < 5)))) {
        await c.save();
        return {...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401};
      }
      // The relay can't tell whether Vikunja made the change. Only the user can check, so it is kept for Try again.
      const unknown = error.code === 'unknown';
      if (unknown) error.message = UNKNOWN;
      // A refused move is reverted on screen at once instead of being retried later.
      if (a.op === 'position' && !unknown) error.drop = true;
      // If part of the action saved before rejection, show that result from Vikunja and explain the partial save.
      if (a.stage > 0 && op.saved) error.saved = op.saved;
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
      a.failed = {message: error.message, at: new Date().toISOString()}; a.fails = 0;
      await c.save();
      return {...none, status: 'error', error, kept: true};
    }
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
  /* Put what a sent action did on the checklist on screen into Vikunja's copies, so the screen does not revert while
     waiting for a reload. */
  applyAct(a, comment){
    if (a.op === 'claim' || a.op === 'unclaim') { this.claimSent(a); return; }
    if (a.op === 'delete') { this.forgetTree(a.ids); return; }
    if (a.op === 'position') { this.positionSent(a); return; }
    const r = this.view.shownRun;
    if (!r || r.id !== a.run) return;
    if (a.op === 'finish' || a.op === 'reopen') { put([{id: r.id, done: a.op === 'finish'}], ['done']); return; }
    const s = r.steps.includes(a.task) ? copyOf(a.task) || {} : null, me = raw(this.user);
    if (s && a.op === 'progress') { put([{id: a.task, percent_done: a.pct / 100}], ['percent_done']); return; }
    if (s && a.op !== 'note' && a.op !== 'answer') {
      const rs = {...s.reactions}, without = m => (rs[m] || []).filter(u => u.id !== me?.id);
      rs[DONE_MARK] = without(DONE_MARK); rs[SKIP_MARK] = without(SKIP_MARK);
      if (a.op !== 'undone') rs[a.op === 'skip' ? SKIP_MARK : DONE_MARK].push(me);
      put([{id: a.task, done: a.op !== 'undone', done_at: a.doneAt || new Date(serverTime(Date.now())).toISOString(), reactions: rs}], ['done', 'done_at', 'reactions']);
    }
    if (comment) { const on = s ? a.task : r.id; put([{id: on, comments: [...copyOf(on)?.comments || [], comment]}], ['comments']); }
  },
  actTask(a){ return actTaskId(a); },
};
