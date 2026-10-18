// The Outbox: the header's button and its sheet, including rejected changes that can be retried or dropped.
import { fmtSize, taskDrafts } from '../util.js';
import { addedText, parseStep } from '../checklists.js';
import { older, sendState, sync, uuid7 } from '../sync.js';
import { cancelOf, dropUnder, opOf, passUps, photosOf } from '../ops/index.js';
import { UNKNOWN } from '../messages.js';
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
      if (e.kind === 'run') {
        const what = (e.cancelled ? 'Cancelling the start of ' : 'Starting ') + e.template.title;
        rows.push({ key: e.id, text: what, when, drop: e.cancelled ? null : ['cancelStart', e.id] });
      } else if (e.kind === 'step') {
        const text = e.cancelled
          ? `Removing ${quoted(e.title)}, because its insert was cancelled`
          : `${e.from || e.tpl != null ? 'Repeated' : 'Inserted'} in ${e.runTitle}: ${quoted(e.title)}`;
        rows.push({ key: e.id, text, when, drop: e.cancelled ? null : ['dropStep', e.id] });
      } else if (e.kind === 'act') {
        // A change the relay can't vouch for wasn't refused, so its reason stands alone. A line is cancelled as its
        // waiting row's Cancel does it, until its first request is sent.
        const why = e.failed?.message,
          failed = !why ? '' : why === UNKNOWN ? why : 'Vikunja refused it: ' + why,
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
    return (
      'Outbox, ' +
      ([failed && `${failed} couldn't be sent`, waiting && `${waiting} waiting to send`].filter(Boolean).join(', ') ||
        'nothing waiting to send')
    );
  },
  get outboxStatus() {
    if (this.flushing) return 'Sending…';
    if (this.pending.length)
      return this.offline
        ? 'No connection. Pocket sends these when it reaches Vikunja.'
        : 'Waiting for Vikunja. Pocket tries again every 30 seconds.';
    if (this.failed.length)
      return 'Vikunja refused these. Fix what its message says, then tap Try again. Or tap Cancel.';
    return 'Everything has reached Vikunja.';
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
      this.say("Still offline. Your changes are saved and go to Vikunja when you're back online.", {
        place: 'sheet:top',
        cls: 'failed',
      });
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
      if (!opOf(e).keepReads) delete e.fixed;
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
      this.say(gone ? 'It was sent before it could be stopped.' : "It is being sent and can't be stopped now.", {
        place: 'sheet:top',
      });
      return;
    }
    const said = {};
    if (photos.length && !a.parent) this.capPhotos = [...this.capPhotos, ...photos];
    if (how === 'lines') this.linesBack(under, said);
    else if (how === 'text' || how === 'back') this.giveBack(a, said);
    if (a.stage > 0 && this.view.shownRun?.id === a.run) this.refreshRunTask(a.task);
    // The op's words say what Vikunja keeps, from Pocket's copies, or that it may or may not have a change whose answer
    // is unknown.
    const words = [opOf(a).dropped(a, a.label || this.actTitle(a.task), copyOf)];
    const back =
      said.back &&
      how !== 'back' &&
      (how === 'lines' ? 'The lines under it are back where you typed them.' : 'Its text is back where you typed it.');
    // Undo puts the entry back as it was, so it keeps its key and its place in the order. A refused one waits for Try
    // again, as before.
    const undo =
      said.back || ['lines', 'back', 'made'].includes(how)
        ? null
        : {
            label: 'Undo',
            fn: async () => {
              const e = kept;
              kept = null;
              if (!e) return;
              await sync.lock(() => sync.add(e, []));
              if (e.failed) this.refreshPending();
              else await this.sendActs(e.id);
            },
          };
    this.say(['Cancelled.', ...words, back].filter(Boolean).join(' '), {
      place: 'sheet:top',
      action: undo,
      gone: () => {
        kept = null;
      },
    });
    this.flush(); // sends the actions that waited behind it
  },
};
