// Send what was added through the outbox, and show the "Waiting to send" rows until it reaches Vikunja.
import { raw, userCache } from '../util.js';
import { api, ApiError, items, opening, passing, seenToken, sharedToken, TRANSIENT, upload } from '../api.js';
import { isSet, startOfDay } from '../dates.js';
import {
  addedPart,
  addedWhere,
  cancelName,
  doneRepeats,
  doneText,
  fileLost,
  fileNotKnown,
  KEPT,
  lineCancelled,
  lineNotSaved,
  lineRefused,
  NOT_KEPT,
  notKnown,
  notSaved,
  notUploaded,
  OPEN,
  photosLater,
  readOnly,
  SAID,
  SENT_FIRST,
  sentBut,
  subsNotUnder,
  textBack,
  toOutbox,
  UNDO,
  waitingWords,
  waitText,
} from '../messages.js';
import { fileEntry, held, itemsOf, older, slowness, sync, uuid7 } from '../sync.js';
import {
  dayGroup,
  gapIndex,
  intoGroup,
  intoKeys,
  keptGroups,
  listItems,
  nestSubtasks,
  sameGroup,
  saved,
  screenRows,
  todayAt,
  todayGroups,
  todayOrder,
  viewKey,
} from '../lists.js';
import { positionOrder, SPACING } from '../order.js';
import { addLines, cancelOf, linesUnder, movedFrom, noneWaiting, opOf, passUps } from '../ops/index.js';
import { heldTasks, hold, waits } from './acts.js';
import { opsId } from './tasks.js';

let waitTimer;
// A flush asked for while one runs, which runs once more when that one ends. The first may have passed by an entry
// queued meanwhile, or stopped for a connection that is back.
let again = false;
// Each waiting row's object, by its entry, kept while the row is unchanged (pendingTasks).
const waitingRows = new Map();
const lastGroups = new Map(); // each group as listGroups last returned it, by key
/* What became of the lines typed together (`entries`), from sendActs' results, as one result for their add box. It is
   'error' if Vikunja refused a line or can't tell whether it has one, 'offline' if a line or its photos still wait,
   'gone' if another tab sent them, and else 'sent'. `reached` says that what waits, waits for a busy Vikunja, and not
   for a connection. `unsent` is the text of the lines that go back to the box, and `title` names the refused line. A
   line kept in the Outbox once its task is made is not the box's error, because sendActs said what became of it. */
export const batchOf = (r, entries) => {
  const mine = (r.all || []).filter(x => x.batch === entries[0].batch),
    err = mine.find(x => x.status === 'error' && x.boxed),
    waiting = mine.filter(x => x.status === 'offline' || x.filesWait),
    all = k => mine.flatMap(x => x[k] || []);
  const status = err
    ? 'error'
    : waiting.length
      ? 'offline'
      : !mine.length
        ? entries.some(e => sync.entries.has(e.id))
          ? 'offline'
          : 'gone'
        : mine.every(x => x.status === 'gone')
          ? 'gone'
          : 'sent';
  return {
    status,
    // When an earlier entry stopped the outbox before this batch, that entry's result says why the batch waits.
    reached: waiting.length ? waiting.every(x => x.reached) : !!r.reached,
    error: err?.error,
    title: entries.find(e => e.id === err?.id)?.p?.title,
    ids: all('ids'),
    tasks: all('tasks'),
    problems: all('problems'),
    unsent: all('unsent'),
    photos: all('photos'),
    uploaded: mine.reduce((n, x) => n + (x.uploaded || 0), 0),
    projectId: mine.find(x => x.projectId)?.projectId,
  };
};

export default {
  async findUser(name) {
    const key = name.toLowerCase();
    if (userCache.has(key)) return userCache.get(key);
    const u =
      items(await api('/users?q=' + encodeURIComponent(name))).find(x => x.username.toLowerCase() === key) || null;
    if (u) userCache.set(key, u);
    return u;
  },
  // A link changes the related tasks of both tasks, so an op's write names both (`on`, stageContext).
  linkSubtask(parentId, childId, send) {
    return send(`/tasks/${parentId}/relations`, {
      method: 'POST',
      body: { other_task_id: childId, relation_kind: 'subtask' },
      on: { [parentId]: {}, [childId]: {} },
    });
  },
  // Queue the lines typed in an add box, each as an add op (addLines), with the photos on the first, and send them.
  // Returns what became of them (batchOf), and whether they were kept on the phone (`kept`, as queue gives).
  async sendLines(entries, photos = []) {
    const { kept } = await this.queue(entries, photos);
    return { ...batchOf(await this.sendActs(entries.at(-1).id), entries), kept };
  },
  /* Everything typed in quick add goes through the outbox: online it is sent straight away, offline it waits. */
  async submitCapture() {
    const lines = this.capLines,
      parsed = this.parsed;
    if (!parsed.title || this.cap.busy) return;
    // A single task can go to the project picked for its @usernames. A pasted list goes to the default project.
    const pid = lines.length === 1 ? this.boxPid('cap') : this.defaultProjectId();
    const first = parsed.project?.id || pid;
    if (!first) {
      this.say(SAID.noProject, { place: 'cap', cls: 'failed' });
      return;
    }
    if (!this.canWrite(first)) {
      this.say(readOnly(this.projById.get(first)?.title), { place: 'cap', cls: 'failed' });
      return;
    }
    // Parse every line now, so dates mean what they meant when typed. Each line records which line it is under. Lines
    // under another line get positions in the project's List view, each after the line before it, because Vikunja
    // would otherwise put each new one first. When the box has been moved out a level (boxOut, quickadd.js), the
    // top-level lines go where the box is. That is after the task the box was moved out from and everything under it,
    // each after the line before it.
    const places =
      this.boxOut && first === this.view.project?.id
        ? this.outPlaces(itemsOf(this.boxItems('cap')).filter(x => x.under === null).length)
        : null;
    let top = 0;
    const items = itemsOf(this.boxItems('cap'), (k, under) =>
        under !== null ? { position: k * SPACING } : places && { position: places[top++] },
      ),
      subs = items.filter(x => x.under !== null).length;
    const photos = this.capPhotos.map(f => Alpine.raw(f));
    const entries = addLines(items, { pid }).map(f => this.actEntry(f)),
      mine = new Set(entries.map(e => e.id));
    entries[0].files = photos.map(fileEntry);
    if (this.boxOut) this.aimAddedOut(entries[items.findLastIndex(x => x.under === null)]); // the box moves under the last of them
    this.cap.busy = true;
    this.cap.text = '';
    this.cap.nest = false;
    this.cap.flat = false;
    this.capPhotos = [];
    if (this.cap.focus) this.$nextTick(() => this.$refs.capture.focus()); // so the user can type the next one
    try {
      // Save it first, with its photos, and show it at once where it will land. It looks waiting only if sending takes a while.
      const r = await this.sendLines(entries, photos),
        { kept } = r;
      if (r.ids?.length) this.flash(r.ids);
      this.refreshPending(); // swap the waiting row for the sent one at once
      this.placeSent(r.tasks || []);
      /* New rows flash in the list when they are added, and no message is shown. The exception is tasks that aren't on
         this screen (a task due next month added on Today, or a task for another project). Then the add box shows
         where they went, with an Open button. It also shows anything that didn't go as asked or couldn't be added. */
      const n = items.length,
        np = photos.length,
        cap = { place: 'cap' },
        err = { place: 'cap', cls: 'failed' };
      const but = r.problems?.length ? `, but ${r.problems.join('; ')}` : '';
      const open = { label: OPEN, fn: () => this.openTask(r.ids[0]) };
      if (r.status === 'offline') {
        // The task shows in the list as waiting, unless this list wouldn't include it (such as a task due next month on
        // Today).
        this.refreshPending();
        sync.keep();
        if (!kept) this.say(NOT_KEPT, err);
        else if (np && r.ids.length === n)
          // the task was added, and its photos are still waiting
          this.say(photosLater(this.projById.get(r.projectId)?.title, np, r.reached), { ...cap, action: open });
        else if (np) this.say(waitText(r, n, np), cap);
        else if (!this.pendingTasks.some(t => mine.has(t.entry) && this.belongsIn(t))) this.say(waitText(r, n), cap);
      } else if (r.status === 'error') {
        // A line whose answer is unknown stays in the Outbox, so only the refused lines come back.
        if (r.unsent.length) this.cap.text = r.unsent.join('\n'); // keep what wasn't added
        this.capPhotos = r.photos;
        // Undo deletes the tasks just added, each with no Restore, the last added first.
        const undo = r.ids.length ? { label: UNDO, fn: () => this.deleteNow(r.ids.map(id => [id]).reverse()) } : null;
        // A message has one button. After some lines were added, Undo keeps it, because the header's button still
        // opens the Outbox.
        if (r.error.code === 'unknown')
          this.say((undo ? addedPart(r.ids.length, n, but) + ' ' : '') + notKnown(r.error.what), {
            ...err,
            action: undo || toOutbox(this),
          });
        else this.say(lineRefused(r.ids.length, n, but, r.title, r.error.message), { ...err, action: undo });
      } else if (r.status === 'sent') {
        const away = (r.tasks || []).filter(t => !this.belongsIn(t));
        if (away.length || but)
          this.say(
            addedWhere({
              n,
              subs,
              project: this.projById.get(r.projectId)?.title,
              due: items[0].p.due,
              photos: r.uploaded,
              but,
            }),
            {
              ...(but ? err : cap),
              action: away.length ? { label: OPEN, fn: () => this.openTask(away[0].id) } : null,
            },
          );
      } // status 'gone': another tab sent it and its rows already show
    } finally {
      this.cap.busy = false;
      this.refreshPending();
      this.render();
    }
  },
  /* Send one outbox entry, carrying on where an earlier try stopped. Returns {status: sent|offline|error|gone, ...}
     with the ids of its tasks, the tasks created this time, and how many files were uploaded. `offline` means the entry
     is kept to try again. `reached` means Vikunja answered, but not usefully yet (busy, or a server error on a file). */
  async sendEntry(id) {
    const entry = await sync.fresh(id);
    if (!entry) return { status: 'gone', ids: [], tasks: [] }; // another tab sent it
    if (entry.kind === 'act') return this.sendAct(entry);
    // What an older Pocket saved before each change was an op: a capture, or a checklist's start or step. It is dropped.
    if (entry.kind || !entry.taskId) {
      await sync.remove(entry.id);
      return { ids: [], tasks: [], status: 'gone' };
    }
    return this.sendFileEntry(entry);
  },
  // Send the photos and files for a task, added from its sheet or with a line (filesOut, acts.js). Vikunja busy, or no
  // connection, keeps them for later. `tasks` are the tasks that show while they upload (sendFiles).
  async sendFileEntry(entry, tasks = []) {
    const none = { ids: [], tasks: [], problems: (entry.problems ||= []), uploaded: 0 };
    try {
      return { ...none, status: 'sent', uploaded: await this.sendFiles(entry, entry.taskId, tasks) };
    } catch (error) {
      if (passing(error) || error.again || error.status === 401)
        return { ...none, status: 'offline', reached: error instanceof ApiError && error.status !== 401 };
      await sync.remove(entry.id);
      return { ...none, status: 'error', error };
    }
  },
  /* Upload an entry's waiting photos and files to task `id`, then take the entry out of the outbox and read the task
     again with its new attachments, for its rows, its sheet and a checklist's screen. `tasks` are the tasks a line
     made, which show while the files upload. Returns how many were uploaded. */
  async sendFiles(entry, id, tasks = []) {
    const files = (entry.files || []).filter(f => !f.sent);
    let uploaded = 0;
    if (files.length) {
      this.placeSent(tasks);
      this.refreshPending();
    }
    for (const f of files) if (await this.sendFile(entry, id, f)) uploaded++;
    await sync.remove(entry.id);
    if (files.length) {
      this.refreshPending();
      const t = await this.readCopy(id).catch(() => null);
      if (t) {
        for (const x of tasks) if (x.id === t.id) Object.assign(x, t);
        if (this.sheet.id === t.id) {
          this.showTask(t);
          this.sheet.dirty = true;
        }
      }
    }
    return uploaded;
  },
  /* Upload one waiting file with a key of its own (`upload`), kept in the entry before it is first sent, so an upload
     sent again after a lost reply is made once. A file Vikunja rejects (for example because it is too big, or the task
     is gone) is reported and dropped. After a server error the file is kept to try again, and `trouble` makes its row
     show that. `sent` marks the file as dealt with. Returns whether the file is on the task. */
  async sendFile(entry, taskId, f) {
    const problems = (entry.problems ||= []);
    let ok = false;
    try {
      const file = await sync.file(f.key);
      if (!file) problems.push(fileLost(f.name));
      else {
        if (!f.upload) {
          f.upload = uuid7();
          await sync.save(entry);
        }
        const r = await upload(taskId, file, f.name, f.upload);
        // Vikunja answers OK even when it rejects a file, and puts the reasons in `errors`.
        if (r?.errors?.length) problems.push(notUploaded(f.name, r.errors.map(e => e.message).join('; ')));
        else ok = true;
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status >= 500 || TRANSIENT.has(e.status))) {
        f.trouble = true;
        await sync.save(entry);
        e.again = true;
      }
      if (passing(e) || e.again || e.status === 401) throw e;
      // The relay can't tell whether Vikunja has the file, and only the user can check.
      problems.push(e.code === 'unknown' ? fileNotKnown(f.name) : notUploaded(f.name, e.message));
    }
    f.sent = true;
    await sync.save(entry, [f.key]);
    return ok;
  },
  // Put tasks that just reached Vikunja into the list on screen, where they belong, without waiting for the list to
  // reload. On a patchy connection the reload can fail, and the list would otherwise stay as it was, without them.
  placeSent(tasks) {
    this.aimSent(tasks); // the add box's cursor follows a task from its waiting row (quickadd.js)
    if (this.view.loading || this.view.route !== location.hash) return;
    let placed = false;
    for (const { child, problems, arrived, was, place, ...t } of tasks) {
      // A subtask sent with a position among its siblings keeps that position, wherever it was added, including from
      // a card on Today.
      if (t.parent && place > 0) this.positions[t.id] = t.position > 0 ? t.position : place;
      const key = this.belongsIn({ ...t, child });
      if (!key || this.view.groups.some(g => g.tasks.some(x => x.id === t.id))) continue;
      // A task marked done, or given a percentage, shows that on its row, from Vikunja's copy (`arrived.now`).
      const now = arrived?.now,
        g = this.view.groups.find(g => g.key === key);
      // On a project's list a new task goes first, where Vikunja puts it, until the list is read again. The exception
      // is a task sent with its own position (`place`, from a box moved out a level), which Vikunja keeps.
      if (g && this.route.name === 'project' && this.view.listView && !child && !t.parent && place > 0)
        this.positions[t.id] = place;
      else if (g && this.route.name === 'project' && this.view.listView && !child && !t.parent)
        this.positions[t.id] = Math.min(2 * SPACING, ...g.tasks.map(x => this.positions[x.id]).filter(p => p > 0)) / 2;
      // A subtask keeps the position it was sent with.
      else if (g && this.view.listView && t.position > 0) this.positions[t.id] = t.position;
      // A repeating line that arrived done is at its next date in Vikunja's copy, so its row is made from the task as
      // the line made it, marked done, until the batch clears (arrivedDone).
      const rolled = !!arrived?.done && !now.done;
      this.change(w => {
        w.base(rolled ? { ...t, done: true } : t);
        if (rolled) w.leave(t.id, 'done');
      });
      const row = this.tasks[t.id];
      if (g) g.tasks.push(row);
      else
        this.view.groups.push({
          ...(this.route.name === 'today' ? todayGroups().find(x => x.key === key) : { key, cls: '', title: 'Open' }),
          tasks: [row],
        });
      if (arrived?.done) this.arrivedDone(row, now, t);
      placed = true;
    }
    // Also update the copy kept for opening offline.
    const k = viewKey(this.route),
      s = saved.get(k);
    if (placed && s) this.keepScreen(k, { ...s, groups: keptGroups(this.view.groups) }, false);
  },
  /* A task that arrived done (its line was marked done in quick add) is ticked on its row and goes where it belongs
     with the batch, the same as a task the user ticks there (toggleDone, actions.js). Tapping its tick before then
     undoes the tick, as for a tick in the list (undoTicks).

     A repeating task is open again at its next date in `now`, Vikunja's copy. Its row shows it done, with the dates it
     was created with (`made`), until the batch clears, since placeSent made the row from those and marked it done.
     Then it shows as open at its next date. Tapping its tick before then puts its dates back. */
  arrivedDone(t, now, made) {
    const said = doneText(0, 0, t.title),
      // The line's tick, as a done op that Vikunja has answered, for its Undo.
      tick = {
        id: uuid7(),
        op: 'done',
        task: t.id,
        run: null,
        ...(typeof made.parent === 'number' && { up: made.parent }),
        ...(!now.done && { was: movedFrom(made) }),
        got: { task: now },
      };
    this.markRow(t.id, {
      kind: 'done',
      said: now.done ? said : doneRepeats(t.title),
      undo: () => this.undoTicks([tick]),
    });
  },
  // Send whatever is waiting. Called when Pocket opens, comes back to the front, reconnects, and every 30 seconds.
  async flush() {
    if (opening) return; // Pocket is still opening on the saved screen, and boot sends what's waiting once Vikunja says who is signed in
    // In a shared session, nothing is sent until Pocket knows the session still belongs to this user.
    if (this.signedIn && this.user && sharedToken.get() !== seenToken) {
      this.sessionChanged();
      return;
    }
    if (this.flushing) {
      again = true;
      return;
    }
    if (!this.signedIn || !this.user || !sync.all(this.user.id).length) return;
    this.flushing = true;
    again = false;
    const results = [];
    try {
      // While Pocket knows it is offline, an act's first request isn't tried (sendAct). A plain read finds out whether
      // Vikunja can be reached, and any answer clears `offline`.
      if (this.offline) await api('/user').catch(() => {});
      if (!this.offline && this.signedIn)
        await sync.lock(async () => {
          let actsWait = false; // after an act is kept offline, later acts wait behind it
          const all = sync.all(this.user?.id),
            stopped = heldTasks(all); // acts on a task whose earlier act failed wait too
          for (const e of all) {
            if (e.failed || held(e) || (e.kind === 'act' && (actsWait || waits(e, stopped)))) continue;
            const r = await this.sendEntry(e.id);
            results.push(r);
            if (e.kind === 'act' && r.status === 'offline') actsWait = true;
            if (r.kept) hold(e, stopped);
            if (r.status === 'offline' && !r.reached) break; // no connection, so the rest wait too
          }
        });
    } finally {
      this.flushing = false;
      this.refreshPending();
    }
    this.reportSent(results);
    if (again) await this.flush();
  },
  /* What sending did (`rs`, sendEntry's results). The tasks it made go on screen. The text of lines Vikunja refused goes
     back into the box it came from: quick add, or the subtask box if the task's sheet is open. Subtasks of a task whose
     sheet isn't open are named in the message instead, so they aren't lost. Then Pocket says what went wrong. */
  reportSent(rs) {
    const tasks = rs.flatMap(r => r.tasks || []),
      problems = rs.flatMap(r => r.problems || []),
      errors = rs.filter(r => r.status === 'error');
    // A line refused after its task was made is kept in the Outbox, so it is reported as any other change.
    const failed = errors.filter(r => r.unsent?.length || r.photos?.length),
      other = errors.filter(r => !failed.includes(r));
    const sent = rs.some(r => r.status === 'sent' && ((r.ids || []).length || r.uploaded || r.changed));
    this.placeSent(tasks);
    // Subtasks that waited to be sent for the task whose sheet is open now show in that sheet.
    const open = this.sheet.id;
    if (open && tasks.some(t => t.parent === open))
      this.readCopy(open)
        .then(t => {
          if (t && this.sheet.id === t.id) {
            this.showTask(t);
            this.sheet.dirty = true;
          }
        })
        .catch(() => {});
    const subs = failed.filter(f => f.parent),
      lost = subs.filter(f => this.sheet.id !== f.parent.id),
      back = failed.filter(f => !f.parent);
    for (const f of subs)
      if (!lost.includes(f)) this.sheet.sub.text = [this.sheet.sub.text, ...f.unsent].filter(Boolean).join('\n');
    if (back.length) {
      this.cap.text = [this.cap.text, ...back.flatMap(f => f.unsent)].filter(Boolean).join('\n');
      this.capPhotos = [...this.capPhotos, ...back.flatMap(f => f.photos)];
    }
    if (lost.length) {
      const f = lost[0];
      this.notify(
        subsNotUnder(
          f.parent.title,
          f.error.message,
          (f.tasks || []).map(t => t.title),
          f.unsent,
        ),
      );
    } else if (failed.length) {
      // The message shows in the box the text went back to: quick add, or the subtask box in the task's sheet.
      this.say(lineNotSaved(subs.length > 0, failed[0].error.message), {
        place: back.length ? 'cap' : 'sheet:subtasks',
        cls: 'failed',
      });
    } else if (other.length) {
      const e = other[0].error,
        what = e.what || 'A change made offline';
      this.notify(
        e.said ||
          (e.code === 'unknown'
            ? notKnown(what)
            : notSaved(what, e.message, { next: other[0].kept ? KEPT : textBack(e) })),
        other[0].kept ? toOutbox(this) : null,
      );
    } else if (problems.length) this.notify(sentBut(problems));
    if (sent || errors.length) this.render();
  },

  /* ---------- what's waiting to be sent ---------- */
  // Sort the outbox into entries that are waiting and entries Vikunja rejected (kept to retry or drop). A waiting task
  // shows on screen at once. It looks waiting, and the header's button says so, only after it has waited a while
  // (markSlow).
  refreshPending() {
    const all = this.user ? sync.all(this.user.id) : [];
    this.pending = all.filter(e => !e.failed && !sync.held.has(e.id));
    this.failed = all.filter(e => e.failed);
    this.unsent = this.user ? all.length : null;
    this.keyWaiting();
    this.keyOutbox();
    this.markSlow();
  },
  /* How many photos and files wait to upload for each task, by task id (`waiting.files`), and the tasks whose op has
     waited a while, under the key the op names (`waiting.dues`, an op's `waiting`). Each key is written separately
     (intoKeys) when the outbox changes, so a row that reads its own task's entry (rowMeta) redraws only when that entry
     changes. Without this, every row searched the whole outbox whenever anything in it changed, and adding a task to a
     long list made every row search it twice. The ops waiting on a task are in opsOn (keyOps, tasks.js). */
  keyWaiting() {
    const out = noneWaiting(),
      slow = new Set(this.slow);
    for (const e of this.pending) {
      const w = e.kind === 'act' && opOf(e).waiting;
      if (w && slow.has(e.id)) out[w][opsId(e.task)] = true;
      if (e.taskId)
        for (const f of e.files || [])
          if (!f.sent && !this.dropping.includes(f.key)) out.files[e.taskId] = (out.files[e.taskId] || 0) + 1;
    }
    for (const k in out) intoKeys(this.waiting[k], out[k], raw);
  },
  // Decide which entries have waited long enough to look waiting (slowness), and schedule the next check for when
  // another entry will have. An entry that looks waiting keeps looking waiting until it is sent.
  markSlow() {
    clearTimeout(waitTimer);
    const was = new Set(this.slow),
      still = this.pending.filter(e => was.has(e.id)).map(e => e.id);
    const { slow: more, next } = slowness(
        this.pending.filter(e => !was.has(e.id)),
        Date.now(),
        this.offline,
      ),
      slow = [...still, ...more];
    if (slow.join() !== this.slow.join()) {
      this.slow = slow;
      this.keyWaiting();
    }
    this.waitShown = slow.length > 0;
    if (next !== null) waitTimer = setTimeout(() => this.markSlow(), next - Date.now());
  },
  // The words under a change still on its way, by its entry's id. A change answered within WAIT_MS shows none, so
  // the words don't flash up on every quick add or comment.
  waitNote(id) {
    return this.slow.includes(id) ? waitingWords(this.offline) : '';
  },
  // The label of a waiting row's Cancel, which says what becomes of the lines waiting under it.
  cancelLabel(t) {
    return cancelName(
      t.title,
      this.pending.filter(x => x.under === t.id).length,
      [...this.pending, ...this.failed].find(x => x.id === t.entry)?.over,
    );
  },
  /* The waiting rows of the ops in the outbox (their op's row), shaped like tasks so they can sit in the lists where
     they'll land once sent. A waiting row is the same object while nothing in it changes, so a group with a waiting
     row compares as unchanged (sameGroup, lists.js). A line whose answer is unknown keeps its row, so the lines under
     it stay under it. */
  get pendingTasks() {
    const out = [],
      seen = new Set(),
      rowOf = e => opOf(e).row(e);
    for (const e of this.failed.some(rowOf) ? [...this.pending, ...this.failed].sort(older) : this.pending) {
      const row = rowOf(e);
      if (!row) continue;
      const t = { ...row, waits: !!e.failed || this.slow.includes(e.id) };
      const k = t.id,
        had = waitingRows.get(k);
      seen.add(k);
      if (had && JSON.stringify(had) === JSON.stringify(t)) out.push(had);
      else {
        waitingRows.set(k, t);
        out.push(t);
      }
    }
    for (const k of waitingRows.keys()) if (!seen.has(k)) waitingRows.delete(k);
    return out;
  },

  // Photos and files on their way to tasks already in Vikunja: task id -> [{entry, key, name, ...}].
  get waitingByTask() {
    const m = new Map();
    for (const e of this.pending) {
      const id = e.taskId;
      if (id)
        for (const f of e.files || [])
          if (!f.sent && !this.dropping.includes(f.key)) m.set(id, [...(m.get(id) || []), { ...f, entry: e.id }]);
    }
    return m;
  },
  /* The group of the screen on show that task `t` belongs in, by the rules its load follows, or null when it belongs
     on none. `from` is the group its row is in now. Without it the task is new to the screen, as a task waiting to be
     sent is: search lists only what it found, and on Today a subtask waits on its card (cardRows, cards.js). Undefined
     on a screen whose rows don't move (regroup, views.js). A row is judged as it shows:
     - In a project, by its project and whether it is done. A done task stays on the open list while subtasks of it are
       still open there (makeHead), and a step of a finished checklist leaves (onProjectList).
     - In search, by whether it is done.
     - On Today, by its date (dayGroup), or a card's (todayDates). A task with no date goes under "Added today, no date"
       when the user made it today, and a checklist or a step under Checklists when it is the user's or has a step of
       theirs (todayItems, cards.js). A done task goes under Done today when the user did it (doneByMe). */
  belongsIn(t, from = null) {
    const r = this.route,
      fresh = from === null;
    if (r.name === 'project')
      return t.project_id !== r.id || (!fresh && this.ofFinished(t))
        ? null
        : fresh || !t.done || (from === 'open' && this.keepsHead(t))
          ? 'open'
          : 'done';
    if (r.name === 'search') return fresh ? null : t.done ? 'done' : 'open';
    if (r.name !== 'today') return fresh ? null : undefined;
    if (fresh) return t.child || t.parent ? null : dayGroup(t.due_date);
    const t0 = startOfDay(),
      me = this.user?.id,
      mine = us => (us || []).some(u => u.id === me);
    if (t.done)
      return this.doneByMe(t) && !this.stepRun(t) && (!isSet(t.done_at) || new Date(t.done_at) >= t0)
        ? 'donetoday'
        : null;
    if (this.ofFinished(t)) return null;
    const { when, made, card } = this.todayDates(t);
    if (isSet(when)) return dayGroup(when);
    // A step shows as a row when its checklist can't be read (todayFrom).
    if (this.isRunTask(t) || this.stepRun(t) != null)
      return t.created_by?.id === me ||
        mine(t.assignees) ||
        this.cardSubs(t, true).some(s => !s.done && mine(s.assignees))
        ? 'runs'
        : null;
    return new Date(made) >= t0 && (card || !t.created_by || t.created_by.id === me) ? 'nodate' : null;
  },
  /* The dates Today places task `t` by, as its load does (todayItems, cards.js). A card goes by the earliest date in the
     next seven days among its task and its open subtasks, or by its own date when none is, and by when it was made
     (`made`). `card` says whether `t` is a card or becomes one. */
  todayDates(t) {
    const c = this.view.cards?.[t.id],
      subs = !t.done && this.role(t) !== 'template' ? this.cardSubs(t).filter(s => !s.done) : [];
    if (!c && !subs.length) return { when: t.due_date, made: t.created, card: false };
    const near = [t.due_date, ...subs.map(s => s.due_date)]
      .filter(d => isSet(d) && dayGroup(d) !== null)
      .reduce((a, b) => (!a || Date.parse(b) < Date.parse(a) ? b : a), null);
    return { when: near ?? (isSet(t.due_date) ? t.due_date : null), made: c?.made || t.created, card: true };
  },
  // Whether task `t` is a step of a checklist that is finished.
  ofFinished(t) {
    const run = this.stepRun(t);
    return run != null && !!this.tasks[run]?.done;
  },
  // Whether done task `t` stays on a project's open list, above its subtasks still open there (loadProject).
  keepsHead(t) {
    return (
      !!this.view.groups.find(g => g.key === 'open')?.heads?.includes(t.id) && this.leftOpenUnder(this.tasks[t.id])
    );
  },
  /* The current list's groups, with waiting tasks added where they belong and subtasks nested under their parents. A
     project's open tasks are in List view order. Each group carries the gestures its rows allow on this screen
     (screenRows). A group with cards (every group except done tasks) also has `items`, each a row or a card
     (listItems). `before` is the number of rows above the group on the screen, so a long screen can be drawn a batch
     at a time (drawn, views.js). A group that is unchanged since the last call is returned as the same object
     (sameGroup), so its rows have nothing to redraw. */
  get listGroups() {
    const hidden = this.hiddenRows,
      order = this.route.name === 'project' ? positionOrder(this.positions) : null,
      can = screenRows(this.route.name);
    let before = 0;
    return this.listBase.map(g => {
      const out = {
        ...g,
        ...can,
        ...nestSubtasks(
          g.tasks.filter(t => !hidden.has(t.id)),
          g.key === 'open' ? order : null,
          t => this.hasOwnOrder(t),
        ),
        before,
      };
      if (g.key === 'done') out.cards = null;
      // Done today's rows are plain rows with their count in the heading. A done task has no date to hold it to.
      if (g.key === 'donetoday') Object.assign(out, { cards: null, reschedule: false, count: out.tasks.length });
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
  get shownGroups() {
    const r = this.route,
      at = r.name + ':' + (r.id ?? '');
    if (raw(this.shown).at !== at) this.shown = { at, groups: {} };
    const kept = this.shown.groups;
    return this.listGroups.map(g => {
      if (!raw(kept)[g.key]) kept[g.key] = { depth: {}, kids: new Map() };
      return intoGroup(kept[g.key], g, raw);
    });
  },
  get listBase() {
    const extra = this.pendingTasks.map(t => [this.belongsIn(t), t]).filter(([k]) => k);
    let base = this.view.groups;
    if (this.route.name === 'today') {
      // Show every group, even in a list saved offline before the "Added today, no date" group existed. In a list
      // saved on an earlier day, that group keeps only tasks created today (for a card, judged by the task that
      // brought it), and Done today only tasks done today. A task just ticked may not have its time yet.
      const t0 = startOfDay(),
        at = todayAt(this.view.cards);
      base = todayGroups().map(g => {
        const b = base.find(x => x.key === g.key) || g;
        return g.key === 'nodate'
          ? { ...b, tasks: b.tasks.filter(t => new Date(at(t).created) >= t0) }
          : g.key === 'donetoday'
            ? { ...b, tasks: b.tasks.filter(t => !isSet(t.done_at) || new Date(t.done_at) >= t0) }
            : b;
      });
    } else if (!extra.length) return base;
    if (!base.length && this.route.name === 'project' && this.view.project)
      base = [{ key: 'open', cls: '', title: 'Open', tasks: [] }];
    // Each of Today's groups has its own order. listGroups puts a project's tasks in List view order.
    const today = this.route.name === 'today',
      order = today ? todayOrder(todayAt(this.view.cards)) : {};
    return base.map(g => {
      const tasks = [...g.tasks, ...extra.filter(([k]) => k === g.key).map(([, t]) => t)];
      if (order[g.key]) tasks.sort(order[g.key]);
      // A row moved to another date leaves a gap where it was. The gaps are kept apart from view.groups, which is
      // saved for opening offline.
      for (const gap of (today && this.movedGaps[g.key]) || []) tasks.splice(gapIndex(tasks, gap), 0, gap);
      return { ...g, tasks };
    });
  },
  /* Cancel one waiting line. Its text goes back into the box it was added from, to change or add again. The lines
     under it move up to what the cancelled line was under, and the message says so. If the cancelled line was under
     nothing, those lines become separate tasks. Cancelling the first line of a pasted list does this. The photos added
     with it are dropped too. A line whose first request was sent can't be cancelled, because Vikunja may have its
     task. Its row has no Cancel then, but a tap can still arrive while the request goes out. A step waiting to be added
     to a template is cancelled as the Outbox cancels it (cancelMade). */
  async cancelPending(id) {
    const a = this.pending.find(e => e.id === id);
    if (a && cancelOf(a) === 'unmade') return this.cancelMade(id);
    let raw = '',
      title = '',
      rest = 0,
      over = '',
      parent = null,
      sent = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e || e.sent) {
        sent = true;
        return;
      } // sent while this call waited for the lock
      raw = e.raw.trim();
      title = e.p?.title || raw;
      parent = e.parent || null;
      over = e.over || '';
      const kids = linesUnder('pending-' + id, sync.all(e.user));
      rest = kids.length;
      for (const x of kids) await sync.save(Object.assign(x, { under: e.under, over: e.over, pid: e.pid }));
      await passUps(e);
      await sync.remove(id);
    });
    this.refreshPending();
    if (!sent) this.aimCancelled(id); // the add box's cursor adjusts to the cancelled line (aimCancelled, quickadd.js)
    // The message shows in the box the text went back to: quick add, or the subtask box in the parent's sheet.
    const place = !parent ? 'cap' : this.sheet.id === parent.id ? 'sheet:subtasks' : null;
    if (sent) {
      this.say(SENT_FIRST, { place });
      this.render();
      return;
    }
    const box = parent ? (this.sheet.id === parent.id ? this.sheet.sub : null) : this.cap;
    if (raw && box) box.text = [box.text.trim(), raw].filter(Boolean).join('\n');
    this.say(lineCancelled(raw && box ? title : '', rest, over), { place });
  },
  // Cancel the upload of a waiting photo or file. Its row disappears at once, but an upload already running finishes
  // first.
  async cancelFile(entryId, key) {
    this.dropping.push(key);
    this.keyWaiting();
    await sync.lock(async () => {
      const e = await sync.fresh(entryId);
      if (!e) return;
      const was = e.files.length;
      e.files = e.files.filter(f => f.key !== key || f.sent);
      if (e.files.length === was) return; // already uploaded while waiting
      await sync.save(e, [key]);
      // The files for a task, with none left, are done.
      if (!e.kind && !e.files.some(f => !f.sent)) await sync.remove(e.id);
    });
    this.dropping = this.dropping.filter(k => k !== key);
    this.refreshPending();
  },
};
