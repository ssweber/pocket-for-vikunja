// The Outbox: the header's button and its sheet, including rejected changes that can be retried or dropped.
import { fmtSize, taskDrafts } from '../util.js';
import { addedText, parseStep } from '../checklists.js';
import { older, sendState, sync, uuid7 } from '../sync.js';
import { cancelling, cancelOf, dropUnder, opOf, passUps, photosOf } from '../ops/index.js';
import { cancelled, notStopped, OUTBOX, outboxLabel, refusedNote, STILL_OFFLINE, UNDO } from '../messages.js';
import { copyOf } from './tasks.js';

const whenText = at => {
  const d = new Date(at),
    today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(
    [],
    today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' },
  );
};
const quoted = t => `“${parseStep(t).title}”`;

export default {
  /* List the waiting and rejected changes in time order. Each row has a key, text and time. It also has the failure
     message, and a retry or drop action, where they apply. */
  get outboxRows() {
    const rows = [];
    for (const e of [...this.failed, ...this.pending].sort(older)) {
      const when = whenText(e.at);
      if (e.kind === 'act') {
        // A change the relay can't vouch for wasn't refused, so its reason stands alone. A line is cancelled as its
        // waiting row's Cancel does it, until its first request is sent.
        const why = e.failed?.message,
          failed = why ? refusedNote(why) : '',
          op = opOf(e);
        rows.push({
          key: e.id,
          text: op.text(e, e.label || this.actTitle(e.task), this.isRepeat(e.task)),
          when,
          failed,
          retry: !!e.failed,
          drop: e.failed
            ? ['dropAct', e.id]
            : e.sent
              ? null
              : [cancelOf(e) === 'lines' ? 'cancelPending' : 'dropAct', e.id],
        });
      }
      // The photos and files of a line, or added from a task's sheet.
      const to = copyOf(e.taskId)?.title || e.p?.title;
      for (const f of e.files || [])
        if (!f.sent && !this.dropping.includes(f.key))
          rows.push({
            key: f.key,
            text: `${/^image\//.test(f.type) ? 'Photo' : 'File'}${to ? ' for ' + quoted(to) : ''}, ${fmtSize(f.size)}`,
            when,
            drop: ['cancelFile', e.id, f.key],
          });
    }
    return rows;
  },
  // The Outbox button shows after a delay, or at once when a change is rejected.
  get outboxShown() {
    return !!this.failed.length || (this.waitShown && !!this.pending.length);
  },
  get outboxLabel() {
    const failed = this.outboxRows.filter(r => r.failed).length,
      waiting = this.outboxRows.length - failed;
    return outboxLabel(failed, waiting);
  },
  get outboxStatus() {
    if (this.flushing) return OUTBOX.sending;
    if (this.pending.length) return this.offline ? OUTBOX.offline : OUTBOX.busy;
    if (this.failed.length) return OUTBOX.refused;
    return OUTBOX.sent;
  },
  // Tells tests whether Pocket is sending, waiting or idle. A busy add box counts as sending before its entry is
  // queued.
  get syncState() {
    return sendState({
      busy: this.flushing || this.writing > 0 || this.cap.busy || this.cap.adding > 0 || this.sheet.sub.adding > 0,
      unsent: this.unsent,
    });
  },
  openOutbox() {
    this.openSheet('outbox');
  },
  tapRefresh() {
    if (this.outboxShown) this.openOutbox();
    else this.refresh();
  },
  // Retry sending. If Pocket is still offline, show its own connection message.
  async tryNow() {
    await this.flush();
    if (this.pending.length && this.offline) {
      this.say(STILL_OFFLINE, { place: 'sheet:top', cls: 'failed' });
      return;
    }
    this.refresh();
  },
  /* Put the text of lines that weren't sent back in the box they were typed in: quick add, or the subtask box of the
     task they were added to. That box keeps it as a draft until the task's sheet opens. Sets said.back. */
  linesBack(lines, said) {
    const text = lines.filter(x => !x.taskId).map(x => x.raw),
      p = lines[0]?.parent,
      add = (was = '') => [was.trim(), ...text].filter(Boolean).join('\n');
    if (!text.length) return;
    if (!p) this.cap.text = add(this.cap.text);
    else if (this.sheet.id === p.id) this.sheet.sub.text = add(this.sheet.sub.text);
    else taskDrafts.set('sub:' + p.id, add(taskDrafts.get('sub:' + p.id) || ''));
    said.back = true;
  },
  // Whether a step was repeated during its checklist, as last loaded.
  isRepeat(id) {
    if (typeof id === 'string') return !!this.pending.find(e => 'pending-' + e.id === id && (e.from || e.tpl != null));
    const s = (this.view.shownRun?.steps.includes(id) && this.tasks[id]) || copyOf(id);
    return !!s && /repeated/i.test(addedText(s.description) || '');
  },
  actTitle(id) {
    const r = this.view.shownRun;
    if (typeof id === 'string') return this.pending.find(e => 'pending-' + e.id === id)?.title || ''; // a step still being inserted
    return copyOf(id)?.title || (r && (r.steps.includes(id) || r.id === id) && this.tasks[id]?.title) || '';
  },
  /* Retry a rejected action before sending the actions queued behind it. It goes with a new key, because the relay
     would answer the old one with the refusal it stored. After Idempotency-Unknown, tapping Try again is the user
     saying the change wasn't made. Bodies built from a read are built again, from Vikunja's copy as it is now, unless
     the op keeps its reads (keepReads, ops/index.js). */
  async retryAct(id) {
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e?.failed) return;
      const keep = opOf(e).keepReads;
      if (Array.isArray(keep) && e.fixed)
        e.fixed = Object.fromEntries(Object.entries(e.fixed).filter(([k]) => keep.includes(k)));
      else if (!keep) delete e.fixed;
      delete e.failed;
      e.fails = 0;
      e.key = uuid7();
      // A line made now writes the progress of every parent above it, which its batch may have written without it.
      if (e.above?.length) e.ups = e.above;
      await sync.save(e);
    });
    this.refreshPending();
    await this.flush();
  },
  /* Cancel an action, but only before sending starts or after it was rejected. It asks nothing, because the message
     says what Vikunja keeps and has an Undo. Text the action held goes back to its box instead, with no Undo, so
     the text is never both in the box and sent. What goes back is the op's (cancel). The lines under a cancelled line
     wait behind it, so they are refused, and their text goes back to their box. The photos of a line whose task isn't
     made go back to quick add. The lines under a line whose task is made are sent under that task. */
  async dropAct(id) {
    const a = [...this.failed, ...this.pending].find(e => e.id === id);
    if (!a) return;
    const how = cancelOf(a);
    if (how === 'unmade') return this.cancelMade(id);
    let gone = false,
      started = false,
      under = [],
      photos = [],
      kept = null;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) {
        gone = true;
        return;
      }
      if (!e.failed && e.sent) {
        started = true;
        return;
      }
      if (how === 'lines') {
        photos = await photosOf([e]);
        under = await dropUnder('pending-' + id, e.user);
        await passUps(e, under);
      }
      if (how === 'made') await passUps(e);
      kept = JSON.parse(JSON.stringify(e));
      await sync.remove(id, e.taskId ?? null);
      this.unmade(id);
    });
    this.refreshPending();
    if (gone || started) {
      this.say(notStopped(gone), { place: 'sheet:top' });
      return;
    }
    const said = {};
    if (photos.length && !a.parent) this.capPhotos = [...this.capPhotos, ...photos];
    if (how === 'lines') this.linesBack(under, said);
    else if (how === 'text' || how === 'back') this.giveBack(a, said);
    if (a.stage > 0 && this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
    // The op's words say what Vikunja keeps, from Pocket's copies, or what may still be there after an unknown answer.
    const words = opOf(a).dropped(a, a.label || this.actTitle(a.task), copyOf),
      back = said.back && how !== 'back' ? (how === 'lines' ? 'lines' : 'text') : '';
    // Undo puts the entry back as it was, so it keeps its key and its place in the order. A refused one waits for Try
    // again, as before.
    const undo =
      said.back || ['lines', 'back', 'made'].includes(how)
        ? null
        : {
            label: UNDO,
            fn: async () => {
              const e = kept;
              kept = null;
              if (!e) return;
              await sync.lock(() => sync.add(e, []));
              if (e.failed) this.refreshPending();
              else await this.sendActs(e.id);
            },
          };
    this.say(cancelled(words, back), {
      place: 'sheet:top',
      action: undo,
      gone: () => {
        kept = null;
      },
    });
    this.flush(); // sends the actions that waited behind it
  },
  /* Cancel an op that makes tasks (its cancel is 'unmade'): a checklist's start, or a step added to a checklist. Its
     row's × cancels it at any point, and the Outbox does before it is sent or once it is refused. Not sent yet, it
     leaves the outbox. Sent, what it made is deleted by its own stages (cancelling), now or once Pocket reaches
     Vikunja. The ops waiting on a step it was adding leave with it. With `quiet`, Pocket says nothing. Returns whether
     it had been sent in full. */
  async cancelMade(id, quiet = false) {
    const a = [...this.failed, ...this.pending].find(e => e.id === id);
    let was = null;
    await sync.lock(async () => {
      const e = (was = await sync.fresh(id));
      if (e) await this.unmake(e);
    });
    if (was?.sent) await sync.lock(() => this.sendEntry(id));
    this.refreshPending();
    if (!quiet)
      this.say(!was ? (a && opOf(a).gone) || notStopped(true) : cancelled(opOf(was).dropped(was, '', copyOf)), {
        place: ['sheet:top', 'checklists', 'step'],
      });
    this.render();
    this.flush(); // sends the ops that waited behind it
    return !was;
  },
  /* Cancel op `e`, whose cancel is 'unmade', inside the outbox's lock. Not sent yet, it leaves the outbox. Sent, it is
     marked to delete what it made (cancelling). The ops waiting on a step it was adding leave with it. */
  async unmake(e) {
    // A second tap, from a list read before the first, finds the op cancelled already, and its stages stay as they are.
    if (e.sent) {
      if (!e.cancelled) await sync.save(cancelling(e));
    } else {
      await sync.remove(e.id);
      this.unmade(e.id);
    }
    for (const x of sync.all(e.user))
      if (x.kind === 'act' && x.task === 'pending-' + e.id) {
        await sync.remove(x.id);
        this.unmade(x.id);
      }
  },
};
