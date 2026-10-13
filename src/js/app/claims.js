// Claims and assignee pictures on task and step rows. Claiming assigns the task to you.
import {cache} from '../util.js';
import {allPages, api, ApiError, NetError} from '../api.js';
import {comesRound, hasTemplateLabel, parseStep} from '../checklists.js';
import {saved} from '../lists.js';
import {claimsOnSlide} from '../progress.js';

const loading = new Set();                       // usernames whose picture is being fetched
const tried = new Map();                         // username -> when the last picture request failed
const DAY = 864e5;

export default {
  /* Build the row's claim slot from `people`, including pending claims. An empty open task shows "+ me". Your slot
     lets you release the task. Other people's slots and done tasks show assignees without an action. Anyone can
     still mark the task done or skip a step. Show up to two pictures, yours first, and count the rest. In a private
     project, hide your picture and "+ me", but keep other assignees from before the task was moved there. */
  claimSlot(t, people, done, run = null){
    if (this.onlyYou(t.project_id)) { people = people.filter(u => u.id !== this.user?.id); done = true; }
    const me = this.user, mine = people.some(u => u.id === me?.id), title = parseStep(t.title).title, id = t.id;
    const all = mine ? [me, ...people.filter(u => u.id !== me.id)] : people, users = all.slice(0, 2), more = all.length - users.length;
    const names = all.map(u => u.id === me?.id ? 'you' : this.nameOf(u)).join(', ');
    if (done || !this.canWrite(t.project_id)) return all.length ? {id, run, users, more, can: false, label: `Assigned to ${names}: ${title}`} : null;
    const others = all.filter(u => u.id !== me?.id).map(u => this.nameOf(u)).join(', ');
    if (mine) return {id, run, users, more, can: true, mine: true, label: `You're doing ${title}${others ? ', with ' + others : ''}. Tap to let it go`};
    if (all.length) return {id, run, users, more, can: false, label: `${names} ${all.length > 1 ? 'are' : 'is'} doing ${title}`};
    return {id, run, users: [], more: 0, can: true, label: `Tap to say you'll do ${title}`};
  },
  /* Show who a run or repeating template is for, using the same pictures as a done task. Change these assignees in
     the sheet, so the slot has no action. */
  forSlot(t){
    const slot = (t.assignees || []).length ? this.claimSlot(t, t.assignees, true) : null;
    return slot && {...slot, label: this.forText(t)};
  },
  // Hide claims only when project access is known. A token that can't read access keeps the usual slots.
  onlyYou(pid){ return !this.accessBlocked && this.seenBy?.[pid] === 0; },
  /* Show who completed or skipped a step, with `badge`, before its other assignees. Return null when no one is known. */
  doneSlot(by, people, badge){
    const all = [...by.map(u => ({...u, badge})), ...people.filter(u => !by.some(d => d.id === u.id))];
    return all.length ? {users: all.slice(0, 2), more: Math.max(0, all.length - 2), can: false} : null;
  },
  /* Apply the latest pending claim and the current progress gesture to Vikunja's assignees. Read both by task id
     so a claim redraws only that task's rows. */
  peopleOf(id, base){
    let list = base || [];
    const op = this.waiting.claims[id];
    if (op) list = [...list.filter(u => u.id !== this.user?.id), ...op === 'claim' ? [this.user] : []];
    if (this.slideClaim[id] && this.user && !list.some(u => u.id === this.user.id)) list = [...list, this.user];
    return list;
  },
  /* Claim an unassigned task when a progress gesture changes it. Show your picture during the gesture, then queue
     the claim on release. Return end(changed) so a cancelled gesture removes the picture without claiming. */
  claimOnSlide(slot){
    if (!claimsOnSlide(slot)) return () => {};
    this.slideClaim[slot.id] = true;
    return async changed => {
      try { if (changed) await this.act({op: 'claim', task: slot.id, run: slot.run}); }
      finally { delete this.slideClaim[slot.id]; }                             // the outbox or Vikunja now supplies the claim
    };
  },
  // Queue the claim or release so it shows immediately and survives a lost connection.
  async toggleClaim(slot){
    if (!slot?.can) return;
    navigator.vibrate?.(10);
    await this.act({op: slot.mine ? 'unclaim' : 'claim', task: slot.id, run: slot.run});
    if (this.sheet.open && this.sheet.kind === 'task') this.sheet.dirty = true;   // Today shows what's assigned to you
  },
  /* Load all subtask assignees in one request because Vikunja omits them from related tasks. Offline, use the cache. */
  async loadSubPeople(t){
    const ids = (t.related_tasks?.subtask || []).map(s => s.id), mine = this.sheet;
    if (!ids.length) return;
    try {
      const list = await allPages('/tasks?' + new URLSearchParams({filter: `id in ${ids.join(', ')}`}));
      if (this.sheet !== mine) return;
      for (const s of list) { this.sheet.subPeople[s.id] = s.assignees || []; this.sheet.subLabels[s.id] = s.labels || []; if (cache.has(s.id)) cache.get(s.id).assignees = s.assignees; }
    } catch (e) {
      if (!(e instanceof NetError) || this.sheet !== mine) return;
      for (const id of ids) if (cache.get(id)?.assignees) this.sheet.subPeople[id] ??= cache.get(id).assignees;
    }
  },
  /* Choose the claim slot for a task, subtask or run step. Runs and repeating templates show who they are for.
     Keep the previous slot while a ticked row waits for the batch, with taps disabled, so its title doesn't move. */
  rowSlot(t, g){
    if (g.run) return t.done ? null : t.slot;
    if (g.sheet) return g.step && this.sheet.stepEdit?.id === t.id ? null : this.subSlots[t.id] || null;   // the step's edit box needs this space
    if (t.pending) return null;
    if (g.top || this.isRunTask(t)) return this.forSlot(t);
    if (this.checklistIds.has(t.project_id) && hasTemplateLabel(t)) return comesRound(t) ? this.forSlot(t) : null;
    const mark = this.leaving[t.id], was = mark === 'done' ? false : mark === 'open' ? true : t.done;
    const slot = this.claimSlot(t, this.peopleOf(t.id, t.assignees), was, this.stepRun(t));
    return slot && was !== t.done ? {...slot, can: false, label: (t.done ? 'Done: ' : 'Not done: ') + t.title} : slot;
  },
  // Index the open task's subtask slots by id for each row to read.
  get subSlots(){
    const out = {};
    const run = this.checklistRole === 'run' ? this.sheet.task.id : null;
    for (const st of this.subtasks) out[st.id] = this.claimSlot(st, this.peopleOf(st.id, this.sheet.subPeople[st.id]), st.done, run);
    return out;
  },
  // Apply a sent claim or release to every copy on screen and in the cache.
  claimSent(a){
    const was = this.sheet.subPeople?.[a.task] ?? null, step = this.view.run?.steps.find(s => s.id === a.task);
    const set = list => [...(list || []).filter(u => u.id !== this.user?.id), ...a.op === 'claim' ? [this.user] : []];
    if (was !== null) this.sheet.subPeople[a.task] = set(was);
    if (this.sheet.task?.id === a.task) this.sheet.task.assignees = set(this.sheet.task.assignees);
    if (step) step.assignees = set(step.assignees);
    const c = cache.get(a.task); if (c) c.assignees = set(c.assignees);
    if (this.tasks[a.task]) this.syncTask({id: a.task, assignees: set(this.tasks[a.task].assignees)});
  },

  /* ---------- people's pictures ---------- */
  nameOf(u){ return u?.name || u?.username || 'Someone'; },
  initials(u){ return (this.nameOf(u).match(/[\p{L}\p{N}]+/gu) || ['?']).slice(0, 2).map(w => w[0].toUpperCase()).join(''); },
  /* Return a picture as a data URL, or '' while loading or when none exists. Vikunja requires authentication for
     avatars, so fetch them before using them in an <img> and cache them for a day to show offline. */
  avatarUrl(u){
    const k = u?.username;
    if (!k) return '';
    const got = this.avatars[k];
    if ((!got || Date.now() - got.at > DAY) && !loading.has(k) && !(Date.now() - (tried.get(k) || 0) < 3e5)) this.loadAvatar(k);
    return got?.url || '';
  },
  async loadAvatar(k){
    loading.add(k);
    try {
      const blob = await api(`/avatar/${encodeURIComponent(k)}?size=64`, {raw: true}).then(res => res.blob(), e => { if (e instanceof ApiError) return null; throw e; });
      const url = blob && /^image\//.test(blob.type) && blob.size < 64e3 ? await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => ok(''); r.readAsDataURL(blob); }) : '';
      this.avatars[k] = {url, at: Date.now()};
      saved.set('avatars', this.avatars);
    } catch { tried.set(k, Date.now()); }      // show initials and delay the next request after a failure
    finally { loading.delete(k); }
  },
};
