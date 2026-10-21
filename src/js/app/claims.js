// Claims and assignee pictures on task and step rows. Claiming assigns the task to you.
import { allPages, api, ApiError } from '../api.js';
import { comesRound, parseStep } from '../checklists.js';
import { saved } from '../lists.js';
import { claimsOnSlide } from '../progress.js';
import { started } from './tasks.js';
import { TASK } from '../tasks.js';

const loading = new Set(); // usernames whose picture is being fetched
const tried = new Map(); // username -> when the last picture request failed
const DAY = 864e5;

export default {
  /* Build a row's claim slot from `people`, including pending claims. An open task with no assignee shows "+ me".
     The user's own slot lets them release the task. Another person's slot, and the slot on a done task, show the
     assignees with no action. Anyone can still mark the task done or skip a step. A slot shows up to two pictures,
     the user's first, and counts the rest. In a private project the user's picture and "+ me" are hidden, but other
     assignees from before the task was moved there stay. */
  claimSlot(t, people, done, run = null) {
    if (this.onlyYou(t.project_id)) {
      people = people.filter(u => u.id !== this.user?.id);
      done = true;
    }
    const me = this.user,
      mine = people.some(u => u.id === me?.id),
      title = parseStep(t.title).title,
      id = t.id;
    const all = mine ? [me, ...people.filter(u => u.id !== me.id)] : people,
      users = all.slice(0, 2),
      more = all.length - users.length;
    const names = all.map(u => (u.id === me?.id ? 'you' : this.nameOf(u))).join(', ');
    if (done || !this.canWrite(t.project_id))
      return all.length ? { id, run, users, more, can: false, label: `Assigned to ${names}: ${title}` } : null;
    const others = all
      .filter(u => u.id !== me?.id)
      .map(u => this.nameOf(u))
      .join(', ');
    if (mine)
      return {
        id,
        run,
        users,
        more,
        can: true,
        mine: true,
        label: `${title} is assigned to you${others ? ' and ' + others : ''}. Tap to unassign yourself.`,
      };
    if (all.length)
      return { id, run, users, more, can: false, label: `${names} ${all.length > 1 ? 'are' : 'is'} doing ${title}` };
    return { id, run, users: [], more: 0, can: true, label: `Tap to assign ${title} to yourself` };
  },
  /* Show who a checklist or a repeating template is for, using the same pictures as a done task. These assignees
     are changed in the sheet, so the slot has no action. */
  forSlot(t) {
    const slot = (t.assignees || []).length ? this.claimSlot(t, t.assignees, true) : null;
    return slot && { ...slot, label: this.forText(t) };
  },
  // Claims are hidden only when the project's access is known.
  onlyYou(pid) {
    return this.seenBy?.[pid] === 0;
  },
  /* Show who completed or skipped a step, marked with `badge`, before its other assignees. Returns null when no one
     is known. */
  doneSlot(by, people, badge) {
    const all = [...by.map(u => ({ ...u, badge })), ...people.filter(u => !by.some(d => d.id === u.id))];
    return all.length ? { users: all.slice(0, 2), more: Math.max(0, all.length - 2), can: false } : null;
  },
  /* The task's assignees `base`, with the user added while a progress gesture claims it. The gesture is read by task
     id, so it redraws only that task's rows. A waiting claim is in the row's own assignees already. */
  peopleOf(id, base) {
    const list = base || [];
    return this.slideClaim[id] && this.user && !list.some(u => u.id === this.user.id) ? [...list, this.user] : list;
  },
  /* Claim an unassigned task when a progress gesture changes it. The user's picture shows during the gesture, and
     the claim is queued on release. Returns end(changed), so a cancelled gesture removes the picture without
     claiming. */
  claimOnSlide(slot) {
    if (!claimsOnSlide(slot)) return () => {};
    this.slideClaim[slot.id] = true;
    return async changed => {
      try {
        if (changed) await this.act({ op: 'claim', task: slot.id, run: slot.run });
      } finally {
        delete this.slideClaim[slot.id];
      } // the outbox or Vikunja now supplies the claim
    };
  },
  // Queue the claim or release, so it shows at once and survives a lost connection.
  async toggleClaim(slot) {
    if (!slot?.can) return;
    navigator.vibrate?.(10);
    await this.act({ op: slot.mine ? 'unclaim' : 'claim', task: slot.id, run: slot.run });
    if (this.sheet.open && this.sheet.kind === 'task') this.sheet.dirty = true; // Today shows what's assigned to you, so the list needs a refresh
  },
  /* Read the subtasks of `t` in one request, because Vikunja leaves their assignees and labels out of related tasks.
     The read goes into their copies, so the sheet's subtask rows show them. Offline, the rows keep Vikunja's last
     copies. */
  async loadSubPeople(t) {
    const ids = (t.related_tasks?.subtask || []).map(s => s.id);
    if (!ids.length) return;
    try {
      const at = started(),
        list = await allPages('/tasks?' + new URLSearchParams({ filter: `id in ${ids.join(', ')}` }));
      this.change(w => w.read(list, TASK, at));
    } catch {}
  },
  /* Choose the claim slot for a task, a subtask or a checklist step. A checklist and a repeating template show who
     they are for. While a ticked row waits for the batch, it keeps its previous slot with taps disabled, so its
     title doesn't move. */
  rowSlot(t, g) {
    if (g.run) return t.done ? null : t.slot;
    if (g.sheet) return g.step && this.sheet.stepEdit?.id === t.id ? null : this.subSlot(t); // the step's edit box needs this space
    if (t.pending) return null;
    if (g.top || this.isRunTask(t)) return this.forSlot(t);
    if (this.role(t) === 'template') return comesRound(t) ? this.forSlot(t) : null;
    const mark = this.leaving[t.id],
      was = mark === 'done' ? false : mark === 'open' ? true : t.done;
    const slot = this.claimSlot(t, this.peopleOf(t.id, t.assignees), was, this.stepRun(t));
    return slot && was !== t.done ? { ...slot, can: false, label: (t.done ? 'Done: ' : 'Not done: ') + t.title } : slot;
  },
  /* The claim slot of subtask `st` in its parent's sheet. It reads that subtask's row only, so ticking one subtask
     doesn't work out every subtask's slot again (rule 10). A New template's rows have none. */
  subSlot(st) {
    if (this.sheet.kind !== 'task') return null;
    return this.claimSlot(
      st,
      this.peopleOf(st.id, st.assignees),
      st.done,
      this.checklistRole === 'run' ? this.sheet.id : null,
    );
  },

  /* ---------- people's pictures ---------- */
  nameOf(u) {
    return u?.name || u?.username || 'Someone';
  },
  initials(u) {
    return (this.nameOf(u).match(/[\p{L}\p{N}]+/gu) || ['?'])
      .slice(0, 2)
      .map(w => w[0].toUpperCase())
      .join('');
  },
  /* Returns a picture as a data URL, or '' while it loads or when there is none. Vikunja requires authentication
     for avatars, so Pocket fetches each one itself instead of giving an <img> the address. The pictures are cached
     for a day, so they show offline. */
  avatarUrl(u) {
    const k = u?.username;
    if (!k) return '';
    const got = this.avatars[k];
    if ((!got || Date.now() - got.at > DAY) && !loading.has(k) && !(Date.now() - (tried.get(k) || 0) < 3e5))
      this.loadAvatar(k);
    return got?.url || '';
  },
  async loadAvatar(k) {
    loading.add(k);
    try {
      const blob = await api(`/avatar/${encodeURIComponent(k)}?size=64`, { raw: true }).then(
        res => res.blob(),
        e => {
          if (e instanceof ApiError) return null;
          throw e;
        },
      );
      const url =
        blob && /^image\//.test(blob.type) && blob.size < 64e3
          ? await new Promise(ok => {
              const r = new FileReader();
              r.onload = () => ok(r.result);
              r.onerror = () => ok('');
              r.readAsDataURL(blob);
            })
          : '';
      this.avatars[k] = { url, at: Date.now() };
      saved.set('avatars', this.avatars);
    } catch {
      tried.set(k, Date.now());
    } finally {
      // shows initials and waits before the next request
      loading.delete(k);
    }
  },
};
