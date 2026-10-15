// The waiting-to-send button and sheet, including rejected changes that can be retried or dropped.
import {cache, fmtSize} from '../util.js';
import {addedText, parseStep} from '../checklists.js';
import {isChild, itemDone, sendState, sync, underOf, uuid7} from '../sync.js';
import {OPS} from '../ops/index.js';
import {UNKNOWN} from '../messages.js';

const byWhen = (a, b) => a.at.localeCompare(b.at) || (a.n || 0) - (b.n || 0);
const whenText = at => {
  const d = new Date(at), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? {hour: 'numeric', minute: '2-digit'} : {weekday: 'short', hour: 'numeric', minute: '2-digit'});
};
const quoted = t => `“${parseStep(t).title}”`;

export default {
  /* List the waiting and rejected changes in time order. Each row has a key, text and time. It also has the failure
     message, and a retry or drop action, where they apply. */
  get outboxRows(){
    const rows = [];
    for (const e of [...this.failed, ...this.pending].sort(byWhen)) {
      const when = whenText(e.at);
      if (e.kind === 'run') {
        const what = (e.cancelled ? 'Cancelling the start of ' : 'Starting ') + e.template.title;
        rows.push({key: e.id, text: what, when, drop: e.cancelled ? null : ['cancelStart', e.id]});
      } else if (e.kind === 'step') {
        const text = e.cancelled ? `Removing ${quoted(e.title)}, because its insert was cancelled` : `${e.from || e.tpl != null ? 'Repeated' : 'Inserted'} in ${e.runTitle}: ${quoted(e.title)}`;
        rows.push({key: e.id, text, when, drop: e.cancelled ? null : ['dropStep', e.id]});
      } else if (e.kind === 'act') {
        // A change the relay can't vouch for wasn't refused, so its reason stands alone.
        const why = e.failed?.message, failed = !why ? '' : why === UNKNOWN ? why : 'Vikunja refused it: ' + why;
        rows.push({key: e.id, text: OPS[e.op].text(e, e.label || this.actTitle(e.task), this.isRepeat(e.task)), when, failed, retry: !!e.failed,
          drop: e.failed || !e.sent ? ['dropAct', e.id] : null});
      } else {
        e.items.forEach((x, i) => {
          if (itemDone(x, isChild(e, i))) return;
          const u = underOf(e, i), under = u !== null ? e.items[u].p.title : e.parent?.title || null;
          const text = x.taskId ? `Finishing ${quoted(x.p.title)}` : under ? `Subtask of ${quoted(under)}: ${x.p.title}` : `New task: ${x.p.title}`;
          rows.push({key: `${e.id}-${i}`, text, when, drop: x.taskId ? null : ['cancelPending', e.id, i]});
        });
        const to = cache.get(e.taskId || e.items[0]?.taskId)?.title || e.items[0]?.p.title;
        for (const f of e.files || []) if (!f.sent && !this.dropping.includes(f.key))
          rows.push({key: f.key, text: `${/^image\//.test(f.type) ? 'Photo' : 'File'}${to ? ' for ' + quoted(to) : ''}, ${fmtSize(f.size)}`, when, drop: ['cancelFile', e.id, f.key]});
      }
    }
    return rows;
  },
  // The waiting button shows after a delay, or at once when a change is rejected.
  get outboxShown(){ return !!this.failed.length || (this.waitShown && !!this.pending.length); },
  get outboxLabel(){
    const failed = this.outboxRows.filter(r => r.failed).length, waiting = this.outboxRows.length - failed;
    return [failed && `${failed} couldn't be sent`, waiting && `${waiting} waiting to send`].filter(Boolean).join(', ') || 'Nothing waiting to send';
  },
  get outboxStatus(){
    if (this.flushing) return 'Sending…';
    if (this.pending.length) return this.offline ? 'No connection. Pocket sends these when it reaches Vikunja.' : 'Waiting for Vikunja. Pocket tries again every 30 seconds.';
    if (this.failed.length) return 'Vikunja refused these. Fix what its message says, then tap Try again. Or tap Don\'t send it.';
    return 'Everything has reached Vikunja.';
  },
  // Tells tests whether Pocket is sending, waiting or idle. A busy add box counts as sending before its entry is
  // queued.
  get syncState(){ return sendState({busy: this.flushing || this.writing > 0 || this.cap.busy || this.cap.adding > 0 || this.sheet.sub.adding > 0, unsent: this.unsent}); },
  openOutbox(){ this.openSheet('outbox'); },
  tapRefresh(){ if (this.outboxShown) this.openOutbox(); else this.refresh(); },
  // Retry sending. If Pocket is still offline, show its own connection message.
  async tryNow(){
    await this.flush();
    if (this.pending.length && this.offline) { this.say('Still offline. Your changes are saved and go to Vikunja when you\'re back online.', {place: 'sheet:top', cls: 'failed'}); return; }
    this.refresh();
  },
  // Whether a step was repeated during its checklist, as last loaded.
  isRepeat(id){
    if (typeof id === 'string') return !!this.pending.find(e => 'pending-' + e.id === id && (e.from || e.tpl != null));
    const s = this.view.run?.steps.find(x => x.id === id) || cache.get(id);
    return !!s && /repeated/i.test(addedText(s.description) || '');
  },
  actTitle(id){
    const r = this.view.run;
    if (typeof id === 'string') return this.pending.find(e => 'pending-' + e.id === id)?.title || '';   // a step still being inserted
    return cache.get(id)?.title || r?.steps.find(x => x.id === id)?.title || (r?.run.id === id ? r.run.title : '') || '';
  },
  /* Retry a rejected action before sending the actions queued behind it. It goes with a new key, because the relay
     would answer the old one with the refusal it stored. After Idempotency-Unknown, tapping Try again is the user
     saying the change wasn't made. Bodies built from a read are built again, from Vikunja's copy as it is now. */
  async retryAct(id){
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e?.failed) return;
      delete e.failed; delete e.fixed; e.fails = 0; e.key = uuid7();
      await sync.save(e);
    });
    this.refreshPending();
    await this.flush();
  },
  // Drop an action, but only before sending starts or after it was rejected. Any text it held goes back to its draft.
  async dropAct(id){
    const a = [...this.failed, ...this.pending].find(e => e.id === id);
    if (!a || !confirm(`Don't send it? ${OPS[a.op].dropped(a, a.label || this.actTitle(a.task))}`)) return;
    let gone = false, started = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) { gone = true; return; }
      if (!e.failed && e.sent) { started = true; return; }
      await sync.remove(id);
    });
    this.refreshPending();
    if (gone || started) { this.say(gone ? 'It was sent before it could be stopped.' : 'It is being sent and can\'t be stopped now.', {place: 'sheet:top'}); return; }
    const said = {};
    this.giveBack(a, said);
    if (a.stage > 0 && this.view.run?.run.id === a.run) this.refreshRunTask(a.task);
    this.say('Not sent.' + (said.back ? ' Its text is back where you wrote it.' : ''), {place: 'sheet:top'});
    this.flush();                                                           // sends the actions that waited behind it
  },
};
