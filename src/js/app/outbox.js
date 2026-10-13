// The waiting-to-send button and sheet, including rejected changes that can be retried or dropped.
import {cache, fmtSize} from '../util.js';
import {addedText, parseStep} from '../checklists.js';
import {htmlToText} from '../html.js';
import {isChild, itemDone, sendState, sync, underOf} from '../sync.js';

const byWhen = (a, b) => a.at.localeCompare(b.at) || (a.n || 0) - (b.n || 0);
const whenText = at => {
  const d = new Date(at), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString([], today ? {hour: 'numeric', minute: '2-digit'} : {weekday: 'short', hour: 'numeric', minute: '2-digit'});
};
const quoted = t => `“${parseStep(t).title}”`;

export default {
  /* Describe pending and rejected changes in time order. Each row supplies its key, text, time, failure and
     available retry or drop action. */
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
        rows.push({key: e.id, text: this.actText(e), when, failed: e.failed?.message || '', retry: !!e.failed,
          drop: e.failed || (!e.stage && !e.tried) ? ['dropAct', e.id] : null});
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
  // Show the waiting button after a delay, or immediately when a change is rejected.
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
  // Expose sending, waiting or idle to tests. A busy add box counts as sending before its entry is queued.
  get syncState(){ return sendState({busy: this.flushing || this.writing > 0 || this.cap.busy || this.cap.adding > 0 || this.sheet.sub.adding > 0, unsent: this.unsent}); },
  openOutbox(){ this.openSheet('outbox'); },
  tapRefresh(){ if (this.outboxShown) this.openOutbox(); else this.refresh(); },
  // Use Pocket's connection message when retrying offline.
  async tryNow(){
    await this.flush();
    if (this.pending.length && this.offline) { this.say('Still offline. Your changes are saved and go to Vikunja when you\'re back online.', {place: 'sheet:top', cls: 'failed'}); return; }
    this.refresh();
  },
  /* Describe a queued run action, including a skip reason and whether the step was repeated. */
  actText(a){
    const t = parseStep(a.label || this.actTitle(a.task) || 'a step').title + (this.isRepeat(a.task) ? ' (repeated)' : '');
    const why = a.op === 'skip' && htmlToText(a.html || '').replace(/^Skipped:?\s*/, '').trim();
    return {done: `Done: ${t}`, doneNote: `Done, with a comment: ${t}`, skip: `Skipped: ${t}` + (why ? ` (${why})` : ''), undone: `Not done: ${t}`, note: `A comment on “${t}”`,
      progress: `Progress: ${a.pct}% on “${t}”`, finish: `Finishing “${t}”`, reopen: `Reopening “${t}”`, claim: `Assigning “${t}” to you`, unclaim: `Unassigning you from “${t}”`,
      delete: `Deleting “${t}”` + (a.ids?.length > 1 ? `, with ${a.ids.length - 1} subtask${a.ids.length === 2 ? '' : 's'}` : ''), position: `Moving “${t}” in its list`}[a.op] || t;
  },
  // Whether a run's step is one repeated during the run, as last loaded.
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
  // Explain what dropping this action leaves in Vikunja before asking for confirmation.
  dropText(a){
    const t = quoted(a.label || this.actTitle(a.task) || 'it'), part = a.stage > 0;
    return {done: part ? `${t} stays marked done in Vikunja. The rest of the change is not sent.` : `${t} stays not done in Vikunja.`,
      undone: part ? `${t} stays not done in Vikunja. The rest of the change is not sent.` : `${t} stays done in Vikunja.`,
      finish: 'The checklist stays open in Vikunja.', reopen: 'The checklist stays finished in Vikunja.',
      claim: `You are not assigned to ${t}.`, unclaim: `${t} stays assigned to you.`, progress: `${t} keeps the progress it has in Vikunja.`,
      note: 'The comment isn\'t posted. Its text goes back into the comment box.', delete: `${t} stays in Vikunja.`, position: `${t} stays where it was in Vikunja's list.`}[{doneNote: 'done', skip: 'done'}[a.op] || a.op] || '';
  },
  // Retry a rejected action before sending the actions queued behind it.
  async retryAct(id){
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e?.failed) return;
      delete e.failed; e.fails = 0;
      await sync.save(e);
    });
    this.refreshPending();
    await this.flush();
  },
  // Drop an action only before sending starts or after rejection. Restore any text to its draft.
  async dropAct(id){
    const a = [...this.failed, ...this.pending].find(e => e.id === id);
    if (!a || !confirm(`Don't send it? ${this.dropText(a)}`)) return;
    let gone = false, started = false;
    await sync.lock(async () => {
      const e = await sync.fresh(id);
      if (!e) { gone = true; return; }
      if (!e.failed && (e.stage || e.tried)) { started = true; return; }
      await sync.remove(id);
    });
    this.refreshPending();
    if (gone || started) { this.say(gone ? 'It was sent before it could be stopped.' : 'It is being sent and can\'t be stopped now.', {place: 'sheet:top'}); return; }
    const said = {};
    this.giveBack(a, said);
    if (a.stage > 0 && this.view.run?.run.id === a.run) this.refreshRunTask(a.task);
    this.say('Not sent.' + (said.back ? ' Its text is back where you wrote it.' : ''), {place: 'sheet:top'});
    this.flush();                                                           // what waited behind it
  },
};
