// Queue a change as an op (src/js/ops/), and send the outbox's ops in order, each request with its own key.
import { taskDrafts } from '../util.js';
import { api, ApiError, passing, serverTime } from '../api.js';
import { htmlToText } from '../html.js';
import { parseStep, patiently } from '../checklists.js';
import { CANCEL, held, KEPT, NO_ROOM, NOT_KEPT, older, sync, uuid7 } from '../sync.js';
import { saved } from '../lists.js';
import { notKnown, toOutbox, UNKNOWN } from '../messages.js';
import { checkFields, dropUnder, opOf, refuseLines, refusalOf, stageView, stagesOf } from '../ops/index.js';
import { CREATED, opsId, overlaps, sendingOp, started, TASK, writes } from './tasks.js';

let actCount = 0; // orders things done in the same millisecond
export const nextN = () => ++actCount;
/* For each op queued in this tab whose Undo can still be tapped, the op that undoes it (`inverts`), built from the
   entry as queued, and from Vikunja's answer once this tab sees it. An op a later op replaced (fold) moves to
   `folded`. Both forget an op once its Undo has gone (forgetUndo). */
const inverts = new Map(),
  folded = new Set();
// How many ops this tab keeps an Undo for, for the tests.
export const undosKept = () => inverts.size + folded.size;
/* Keep local completion times for offline ticks so countdowns do not jump or chime again when Vikunja receives
   them. Map each step to {here, there, kept}, using Vikunja's completion time to identify the tick. Expire these
   records after a day. */
let ticks = null;
export const keptTicks = () => (ticks ||= saved.get('ticks') || {});
/* Once a line's task is made, its photos still waiting move to an entry of their own, as a task's sheet makes one, in
   the save that records the task. So a photo that Vikunja keeps refusing never holds back the ops after the line. */
const filesOut = a => {
  const files = opOf(a).files(a);
  if (!files.length) return [];
  const f = { id: uuid7(), user: a.user, at: a.at, n: a.n, taskId: a.taskId, files };
  a.files = [];
  a.filed = f.id;
  return [f];
};

// A line typed in an add box. Its box shows and says what became of it (sendLines, reportSent), as its refusal says.
const boxed = e => !!e && refusalOf(e) === 'lines';
// The ids that failed acts hold back (their op's holds). Later acts on those ids wait, so an untick never arrives
// before its tick.
export const heldTasks = entries =>
  new Set(entries.filter(e => e.kind === 'act' && e.failed).flatMap(e => opOf(e).holds(e)));
export const hold = (e, stopped) => {
  for (const k of opOf(e).holds(e)) stopped.add(k);
};
// Whether act `e` waits behind a failed act (`stopped`, from heldTasks). An act that waits holds back what it would
// hold if it had failed, so the lines under a waiting line wait too.
export const waits = (e, stopped) => {
  const w = opOf(e)
    .waitsOn(e)
    .some(k => stopped.has(k));
  if (w) hold(e, stopped);
  return w;
};

/* When each request of an entry was first sent in this session, by the entry's id and the request's key. A reply the
   relay replayed counts from then. When another tab or an earlier session sent it, Pocket can't know when it reached
   Vikunja, and it counts from its send now, so the op's change still goes into the copy. A change an earlier try made
   counts from the entry's first request. The store orders what it learns by these times (tasks.js). */
const sends = new Map();
/* The fields of a task that a write to `path` changes, as Vikunja's API has them, so each field of an op's change
   counts from the request that made it. A PATCH changes the fields it sends, and deleting a task changes the related
   tasks of the tasks it was related to. */
const PATHS = [
  [/\/reactions(\/delete)?$/, 'reactions'],
  [/\/comments$/, 'comments'],
  [/\/assignees(\/\w+)?$/, 'assignees'],
  [/\/labels(\/\w+)?$/, 'labels'],
  [/\/position$/, 'position'],
  [/\/relations/, 'related_tasks'],
  [/^\/tasks\/\d+$/, 'related_tasks'],
];
const changes = (path, { method, body } = {}) =>
  method === 'PATCH'
    ? [...Object.keys(body || {}), ...('done' in (body || {}) ? ['done_at'] : [])]
    : PATHS.filter(([re]) => re.test(path)).map(([, k]) => k);
// Each reply a stage got, with when its request started, whether the relay replayed it, and the tasks another write
// crossed it on (writes, tasks.js), for answer.
const heard = new WeakMap();
// Where each entry's kept task (`c.task`) came from, as heard has it. A task kept before a reload has no entry here.
const told = new Map();

/* What a stage is given to make its requests. `send` is a write with the next key: the entry's key, the stage's index,
   and the part, counted from 0 each time the stage runs. So a stage sent again after a lost reply sends each request
   with the key it had, and the relay answers the ones already made from what it stored. A write to a task the op
   doesn't change, such as its checklist's progress, names it in `on` (writes), which joins it to the op's write.
   `once` keeps a body built from a read in the entry, so a retry sends the same body. `a.key` replaces the entry's id
   after Try again. A stage puts Vikunja's copy of the task in `task`, and a comment Vikunja made in `comment`. Both
   are kept in the entry (`a.got`), so the answer has them when a later stage finishes on another try. `reply` is the
   task with where it came from, for answer, and `from(t)` where any reply came from. `start(at)` starts the parts at
   `at`, and `skip` counts a part without sending it, so the requests after it keep their keys. A job that is not in
   the outbox, such as the template editor's, passes its own `save` (createTask, sending.js). */
export function stageContext(a, app, save = () => sync.save(a)) {
  let part = 0;
  const id = a.id ?? a.key,
    none = { at: 0, replayed: true, crossed: new Map() };
  const c = {
    app,
    save,
    // The write of this try (writes, tasks.js), which `begin` starts with its first request, and for each field the
    // earliest start of a request of it that Vikunja made and that changed the field.
    write: null,
    begin: null,
    fieldsAt: new Map(),
    // Where reply `t` came from. A reply Pocket doesn't know counts as replayed, as old as anything.
    from: t => (t && heard.get(t)) || none,
    get task() {
      return a.got?.task ?? null;
    },
    set task(t) {
      (a.got ||= {}).task = t;
      told.set(id, c.from(t));
    },
    get reply() {
      const t = c.task;
      return t && { ...(told.get(id) || none), task: t };
    },
    get comment() {
      return a.got?.comment ?? null;
    },
    set comment(x) {
      (a.got ||= {}).comment = x;
    },
    start(at = 0) {
      part = at;
      return c;
    },
    skip() {
      part++;
    },
    async send(path, { on, ...opts } = {}) {
      if (!a.sent) {
        a.sent = true;
        await save();
      } // from now on Cancel can't stop it
      c.write ||= c.begin?.() ?? null;
      const key = `${a.key || a.id}:${a.stage}:${part++}`,
        keys = sends.get(id) ?? sends.set(id, new Map()).get(id),
        first = keys.get(key),
        own = on && !c.write ? writes(on) : null,
        w = own ?? c.write;
      if (on && c.write) for (const [t, fields] of Object.entries(on)) c.write.add(+t, fields);
      const at = started();
      if (first === undefined) keys.set(key, at);
      let replayed = false,
        got;
      try {
        got = await api(path, { ...opts, key, replayed: r => (replayed = r) });
      } finally {
        own?.end();
      }
      const from = { at: replayed ? (first ?? at) : at, replayed, crossed: w?.crossed ?? new Map(), fields: w?.fields };
      for (const k of changes(path, opts)) c.fieldsAt.set(k, Math.min(c.fieldsAt.get(k) ?? Infinity, from.at));
      if (got && typeof got === 'object') heard.set(got, from);
      return got;
    },
    // A read kept as the op's task is thrown away, as any read is, if it ran while another write to the task was in
    // flight (overlaps).
    async read(path) {
      const at = started(),
        got = await api(path),
        id = +(path.match(/^\/tasks\/(\d+)/) || [])[1],
        mine = c.write?.crossed ?? new Map(),
        crossed = id && overlaps(id, at, c.write) ? new Map([...mine, [id, new Set()]]) : mine;
      if (got && typeof got === 'object') heard.set(got, { at, replayed: false, crossed });
      return got;
    },
    async once(name, build) {
      const f = (a.fixed ||= {});
      if (!(name in f)) {
        f[name] = (await build()) ?? null;
        await save();
      }
      return f[name];
    },
  };
  return c;
}

export default {
  /* Queue every run action behind earlier pending actions so Vikunja receives them in order. The op shows on its task
     at once, before it is saved on the phone. Returns how sending went, with the entry's id (`entry`). With `quiet`,
     the caller says what became of it. */
  async act(fields, quiet = false) {
    const run = fields.run ?? this.view.shownRun?.id;
    if (this.toast.show && this.toast.startOf && this.toast.startOf === run) this.toast.show = false;
    if (this.places.run?.startOf === run) this.endPlace('run', this.places.run, false);
    return this.actAll([fields], quiet);
  },
  /* Queue ops (their fields) together, so their rows show in one change (rule 10), fold each into an earlier op it
     replaces, and send through the last. Returns how sending went, with the last entry's id (`entry`) and every
     result (`all`). A caller that shows an Undo for an op with an invert calls forgetUndo once that Undo has gone. */
  async actAll(list, quiet = false) {
    const entries = list.map(f => this.actEntry(f)),
      last = entries.at(-1).id;
    for (const e of entries) if (opOf(e).invert) inverts.set(e.id, opOf(e).invert(e));
    const { kept, full } = await this.queue(entries);
    await sync.lock(() => this.fold(entries));
    return { ...(await this.sendActs(last, kept, full, quiet ? new Set(entries.map(e => e.id)) : null)), entry: last };
  },
  /* Fold each of `entries`, just queued, into the op before it on its task, if that op has sent nothing, isn't held,
     hasn't failed and isn't an Undo. The new op's merge decides what becomes of the two. Only the op just before it
     counts, so a fold never moves an op past another op on its task. An Undo is never folded, so its check is never
     lost. Runs inside the outbox's lock, so the sender can't start the earlier op meanwhile. */
  async fold(entries) {
    const on = new Map();
    for (const x of sync.all(entries[0]?.user))
      if (x.kind === 'act') on.set(opsId(x.task), [...(on.get(opsId(x.task)) || []), x]);
    for (const e of entries) {
      const merge = !e.undo && opOf(e).merge;
      if (!merge) continue;
      let x = null;
      for (const y of (on.get(opsId(e.task)) || []).filter(y => older(y, e) < 0).reverse())
        if ((x = await sync.fresh(y.id))) break;
      const m = x && !x.sent && !x.failed && !x.undo && !held(x) && merge(x, e);
      if (!m) continue;
      if (inverts.delete(x.id)) folded.add(x.id);
      if (m === CANCEL) {
        if (inverts.delete(e.id)) folded.add(e.id);
        await sync.remove(e.id);
        await sync.remove(x.id);
        continue;
      }
      Object.assign(e, m);
      if (inverts.has(e.id)) inverts.set(e.id, opOf(e).invert(e));
      await sync.save(e);
      await sync.remove(x.id);
    }
  },
  /* Undo the ops queued from `list` (their fields, with each entry's id). The rows show the Undo at once, though the
     outbox may be busy sending. Then, in the outbox's lock, an op that has sent nothing, or that Vikunja refused at
     its first stage, leaves the outbox, and its rows show the task without it. An op whose answer is unknown, or that
     Vikunja refused after an earlier stage was made, leaves too, and its invert is queued, checked against what it
     sent. Any other op's invert is queued, built from Vikunja's answer when this tab saw it. An op that a later op
     replaced (fold) counts as changed since, and stays. Returns `left`, which resolves to how many Undos were left
     alone: changed since, or refused. */
  undoOps(list) {
    const now = list.filter(f => !folded.has(f.id)),
      invert = (f, e) => (e ? opOf(f).invert(e) : (inverts.get(f.id) ?? opOf(f).invert(f)));
    const shown = this.change(w =>
      now.flatMap(f => {
        const i = invert(f, sync.entries.get(f.id)),
          id = i && opsId(i.task),
          t = i && this.tasks[id];
        if (!t) return [];
        const to = opOf(i).apply(t, i);
        return [w.edit(id, Object.fromEntries(Object.entries(to).filter(([k, v]) => v !== t[k])))];
      }),
    );
    const undo = async () => {
      const back = [];
      let left = list.length - now.length;
      await sync.lock(async () => {
        for (const f of now) {
          if (folded.has(f.id)) {
            left++;
            continue;
          } // replaced while Undo waited for the lock
          const e = await sync.fresh(f.id),
            unknown = e?.failed?.message === UNKNOWN;
          if (e && (!e.sent || e.failed)) await sync.remove(f.id);
          const inv = (!e || (e.sent && (!e.failed || unknown || e.stage > 0))) && invert(f, e);
          if (inv) back.push({ ...inv, run: null, undo: true });
        }
      });
      this.forgetUndo(list);
      const entries = back.map(f => this.actEntry(f)),
        ids = new Set(entries.map(e => e.id)),
        { kept, full } = entries.length ? await this.queue(entries) : {};
      if (!entries.length) this.refreshPending();
      // The rows now show the Undo through the outbox.
      this.change(() => {
        for (const x of shown) x.undo();
      });
      const r = entries.length ? await this.sendActs(entries.at(-1).id, kept, full, ids) : { all: [] };
      return left + r.all.filter(x => ids.has(x.id) && x.status === 'error').length;
    };
    return { left: undo() };
  },
  // Forget the Undos of the ops queued from `list`, once they can't be tapped: their message has gone, or Undo ran.
  forgetUndo(list) {
    for (const f of list) {
      inverts.delete(f.id);
      folded.delete(f.id);
    }
  },
  // An op's outbox entry. It stores the task's title so the Outbox can name the action after a reload, and the
  // user as /user gave them, for the ✅, the comment or the claim the op shows.
  actEntry(fields) {
    const me = this.user;
    checkFields(fields, true);
    return checkFields({
      id: uuid7(),
      kind: 'act',
      user: me?.id,
      who: me && { id: me.id, username: me.username, name: me.name || '' },
      at: new Date().toISOString(),
      n: nextN(),
      files: [],
      stage: 0,
      fails: 0,
      run: this.view.shownRun?.id,
      label: this.actTitle(fields.task),
      ...fields,
    });
  },
  // Save `entries` in the outbox, the first with `files`, and show them at once. Returns whether all of them reached
  // the database (`kept`), and whether the phone is out of space (`full`).
  async queue(entries, files = []) {
    const adding = Promise.all(entries.map((e, i) => sync.add(e, i ? [] : files)));
    this.refreshPending();
    const r = await adding;
    return { kept: r.every(x => x.kept), full: r.some(x => x.full) };
  },
  /* Send through action `id` in order. Keep deletions held while Restore is still available. Returns the last one's
     result, with every result in `all`, each with its entry's `id` and its line's `batch`. An add box reads its own
     lines' results there. The lines of other batches sent on the way are reported as flush reports them (reportSent).
     The entries in `quiet` get no message here, because their caller says what became of them. */
  async sendActs(id, kept = true, full = false, quiet = null) {
    // An add box shows what it sent itself, swapping each waiting row for its task in one go (submitCapture). A
    // refresh here would draw the list without either in between.
    const lines = boxed(sync.entries.get(id));
    if (!lines) this.refreshPending();
    let last = { status: 'gone' },
      batch;
    const out = [];
    await sync.lock(async () => {
      const all = sync.all(this.user?.id).filter(e => e.kind === 'act' && (e.id === id || !held(e))),
        stopped = heldTasks(all);
      batch = all.find(e => e.id === id)?.batch;
      for (const e of all) {
        if (e.failed || waits(e, stopped)) {
          // waits behind an earlier action Vikunja refused
          if (e.id !== id) continue;
          if (!boxed(e))
            this.say(`Not sent. Vikunja refused an earlier change to “${parseStep(e.label || 'it').title}”.`, {
              place: 'step',
              cls: 'failed',
              action: toOutbox(this),
            });
          last = { status: 'offline', reached: true };
          break;
        }
        last = await this.sendEntry(e.id);
        // A line whose task is made is kept when refused, and reported here rather than by its box. The entry as sent
        // has its task, and the entry as queued may not.
        const now = sync.entries.get(e.id) ?? e,
          inBox = boxed(now);
        out.push({ ...last, id: e.id, batch: e.batch, boxed: inBox });
        if (last.kept) hold(e, stopped);
        // A refusal that puts the screen back says why itself (putBack), and a line says so in its add box (refusal).
        const err = last.error,
          op = opOf(e);
        // A stage that knows the whole sentence gives it (`said`). An op that names a place in its task's open sheet
        // says it there until the sheet closes (sheetPlace).
        const inSheet = op.sheetPlace && this.sheet.open && this.sheet.kind === 'task' && this.sheet.id === e.task;
        if (last.status === 'error' && !quiet?.has(e.id) && (last.kept || refusalOf(now) !== 'undone') && !inBox)
          this.say(
            err.said ||
              (err.code === 'unknown'
                ? notKnown(err.what)
                : `${err.what || 'It'} couldn't be saved${err.saved ? ` in full (${err.saved})` : ''}: ${err.message}.` +
                  (last.kept ? KEPT : this.wordsBack(err))),
            {
              place: inSheet ? op.sheetPlace : 'step',
              cls: 'failed',
              action: last.kept ? toOutbox(this) : null,
              ...(inSheet && { ms: null }),
            },
          );
        if (last.status === 'offline' || e.id === id) break;
      }
    });
    if (!lines) this.refreshPending();
    const others = out.filter(x => x.boxed && x.batch !== batch);
    if (others.length) this.reportSent(others);
    if (last.status === 'offline') {
      sync.keep();
      if (!kept) this.say(full ? NO_ROOM : NOT_KEPT, { place: 'step', cls: 'failed' });
    }
    return { ...last, all: out };
  },
  /* Send an act's stages from where an earlier try stopped, saving the entry after each. An op that makes a task (its
     entry then has `taskId`) also gives the task (`ids`, and `tasks` for placeSent) and its problems, and uploads its
     photos once it is sent (`filesWait` while they wait). What a refusal does is the op's (refusal). */
  async sendAct(a) {
    const op = opOf(a),
      stages = stagesOf(a),
      c = stageContext(a, this),
      seen = stageView(a),
      none = { ids: [], tasks: [], problems: a.problems || [], uploaded: 0 };
    const got = () => ({
      ...none,
      ids: a.taskId && a.stage >= stages.length ? [a.taskId] : [],
      projectId: a.projectId,
    });
    // A stage that makes a task puts it on screen at once, and shows on its row that it arrived done, or with progress.
    // A new task's first reply comes before its labels, people and parent, so it is trusted for CREATED only.
    c.made = t => {
      c.write.add(t.id);
      this.change(w => w.answer([t], CREATED, c.from(t)));
      none.tasks.push({
        ...t,
        child: a.under != null,
        parent: a.under,
        was: 'pending-' + a.id,
        place: a.p.position || 0,
      });
    };
    c.arrive = (x, body) => {
      this.change(w => {
        w.made(x.now.id, body, c.from(x.now));
        w.answer([x.now], TASK, c.from(x.now));
      });
      for (const t of none.tasks) t.arrived = x;
    };
    try {
      // Wait for the real id of an offline step, or of the line this line goes under. Reject a step's action if the
      // step was never created. A line whose line is gone without a task leaves with the lines under it, and their
      // text goes back to their box, as after Cancel.
      for (const k of ['task', 'under'])
        if (typeof a[k] === 'string') {
          const key = a[k].replace(/^pending-/, ''),
            id = sync.taskOf(key);
          if (!id && sync.entries.has(key)) return { ...got(), status: 'offline', reached: true };
          if (!id && k === 'task') throw new ApiError(404, "the step it was for couldn't be added");
          if (!id) {
            this.linesBack(await dropUnder(a[k], a.user), {});
            return { ...none, status: 'gone' };
          }
          a[k] = id;
          await c.save();
        }
      // A request that gets no answer may still have reached Vikunja, and after it the act can't be dropped. So an act
      // not yet sent waits while Pocket knows it is offline, and flush sends it once a read gets through. Flush runs
      // now, outside the outbox lock, so a tick made after a brief drop doesn't wait for the 30-second timer.
      if (!a.sent && (this.offline || navigator.onLine === false)) {
        if (navigator.onLine !== false) setTimeout(() => this.flush());
        this.offline = true;
        return { ...none, status: 'offline', reached: false };
      }
      // A busy Vikunja is retried a few times. With keys, sending a stage again is safe. The op's write starts with its
      // first request (sendingOp), so an op that stops before sending one crosses no other write.
      c.begin = () => sendingOp(a);
      while (a.stage < stages.length) {
        await patiently(() => stages[a.stage](seen, c.start()));
        a.stage++;
        await sync.save(a, [], filesOut(a));
      }
      /* Each field of the op's change counts from the earliest request of this try that Vikunja made and that changed
         it. A field an earlier try changed counts from the op's first request in this session, or from now. */
      const r = c.reply,
        w = (c.write ||= sendingOp(a)),
        at = k => c.fieldsAt.get(k) ?? Math.min(...(sends.get(a.id)?.values() ?? []), w.at);
      this.change(x => x.answered(a, { at, crossed: w.crossed, fields: w.fields }, r, c.comment));
      if (inverts.has(a.id)) inverts.set(a.id, op.invert(a));
      await sync.remove(a.id, a.taskId ?? null);
      // A line's photos upload now, from their own entry (filesOut). If Vikunja is busy they wait there, and the add box
      // says so.
      const f = a.filed ? await sync.fresh(a.filed) : null,
        files = f ? await this.sendFileEntry(f, none.tasks) : null;
      op.answered(this, a, c);
      return {
        ...got(),
        status: 'sent',
        changed: a.taskId ? 0 : 1,
        uploaded: files?.uploaded || 0,
        problems: [...none.problems, ...(files?.problems || [])],
        filesWait: files?.status === 'offline',
      };
    } catch (error) {
      if (
        passing(error) ||
        (error instanceof ApiError && (error.status === 401 || (error.status >= 500 && ++a.fails < 5)))
      ) {
        await c.save();
        return { ...got(), status: 'offline', reached: error instanceof ApiError && error.status !== 401 };
      }
      // The relay can't tell whether Vikunja made the change. Only the user can check, so it is kept for Try again.
      const unknown = error.code === 'unknown',
        refusal = unknown ? 'kept' : refusalOf(a);
      if (unknown) error.message = UNKNOWN;
      if (refusal === 'undone') error.drop = true;
      // If part of the action saved before rejection, show that result from Vikunja and explain the partial save.
      if (a.stage > 0 && op.saved) error.saved = op.saved;
      // Vikunja's copy of the op's own task, as a stage before the refusal kept it. A line's task has it already (made).
      const r = c.reply;
      if (r && r.task.id === opsId(a.task)) this.change(w => w.answer([r.task], TASK, r));
      if (a.stage > 0 && this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
      error.what = op.refused(a, a.label || this.actTitle(a.task));
      // A stage can't read the title the row showed (stageView), so a sentence that names it is a function of the entry.
      if (typeof error.said === 'function') error.said = error.said(a);
      // Reload after a permanent rejection when no retry remains queued.
      if (error.drop) {
        await sync.remove(a.id);
        op.putBack(this, a, error);
        if (this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
        if (this.sheetTask && this.sheet.kind === 'task') this.loadSubPeople(this.sheetTask);
        return { ...none, status: 'error', error };
      }
      // Keep a refused op in the Outbox unless it gives its text back, so a missed toast does not lose the retry.
      if (refusal === 'back') {
        await sync.remove(a.id);
        this.giveBack(a, error);
        return { ...none, status: 'error', error };
      }
      if (refusal === 'lines') return { ...got(), ...(await refuseLines(a)), status: 'error', error };
      a.failed = { message: error.message, at: new Date().toISOString() };
      a.fails = 0;
      await c.save();
      return { ...got(), status: 'error', error, kept: true };
    } finally {
      c.write?.end();
      if (!sync.entries.has(a.id)) {
        sends.delete(a.id);
        told.delete(a.id);
      }
    }
  },
  /* Restore text from an unsent action and set error.back. If its task was deleted, put the text in error.words so
     the message can preserve it. */
  giveBack(a, error) {
    const text = a.html
      ? htmlToText(a.html)
          .replace(/^Skipped:?\s*/, '')
          .trim()
      : '';
    if (!text) return;
    if (error.status === 404) {
      error.words = text;
      return;
    }
    const add = (was = '') => [was.trim(), text].filter(Boolean).join('\n');
    if (!a.run) {
      taskDrafts.set('comment:' + a.task, add(taskDrafts.get('comment:' + a.task)));
      if (this.sheet.id === a.task) this.sheet.commentDraft = add(this.sheet.commentDraft);
    } else this.runDrafts[a.task] = add(this.runDrafts[a.task]);
    error.back = true;
  },
  wordsBack(e) {
    return e.back ? ' Its text is back in the box.' : e.words ? ` It said: “${e.words}”` : '';
  },
  keepTick(a, there) {
    const here = serverTime(+new Date(a.at));
    if (Date.parse(there) - here < 5000) return; // sent as it was done
    ticks = Object.fromEntries(Object.entries(keptTicks()).filter(([, x]) => Date.now() - x.kept < 864e5));
    ticks[a.task] = { here: new Date(here).toISOString(), there, kept: Date.now() };
    saved.set('ticks', ticks);
    this.runNow = Date.now(); // Recompute the run because Alpine does not watch the saved local tick times.
  },
  actTask(a) {
    return opsId(a.task);
  },
};
