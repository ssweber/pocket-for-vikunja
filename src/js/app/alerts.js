/* Alerts while Pocket is on screen. Today regroups its tasks as time passes, and a countdown on a checklist chimes at
   zero. Pocket sends no system notifications. A task that becomes due is highlighted on Today, and a countdown at zero
   shows a toast with a chime. Vibration, keeping the screen on and the overdue count on the app icon are tried where
   the phone allows them. Reminders while Pocket is closed are Vikunja's emails. */
import {store} from '../util.js';
import {serverTime} from '../api.js';
import {isLate, isSet, startOfDay} from '../dates.js';
import {dayGroup, todayAt, todayOrder} from '../lists.js';
import {runShows} from '../checklists.js';

let sound = null;                                // the AudioContext, made on a tap so the browser lets it play
let wakeLock = null, askingLock = false, lockFailed = 0;
let lastTick = Date.now();                       // when Today was last checked

// Steps that have chimed, keyed by step id and due time, so each chimes once even if the user leaves the checklist and
// comes back.
const alerted = {
  all(){ try { return JSON.parse(store.get('alerted')) || {}; } catch { return {}; } },
  has(k){ return k in this.all(); },
  add(k){ const a = this.all(), old = Date.now() - 2 * 864e5; for (const [x, at] of Object.entries(a)) if (at < old) delete a[x]; a[k] = Date.now(); store.set('alerted', JSON.stringify(a)); },
};

export default {
  /* Runs every minute while Today is on screen. Tasks move to Overdue as their time passes, without asking Vikunja
     again. A new day reloads the screen. Pocket announces a task whose due time or reminder has just passed. */
  tickToday(){
    const now = Date.now(), since = lastTick;
    if (this.sheet.open && this.route.name === 'today') return;            // announced once the sheet closes
    lastTick = now;
    if (this.route.name !== 'today' || document.visibilityState !== 'visible' || this.view.loading) return;
    if (this.todayDay !== +startOfDay()) { this.render(); return; }
    const dated = this.regroupToday();
    const passed = (at) => at > since && at <= now;
    const due = [], reminded = [];
    for (const t of dated) {
      if (isSet(t.due_date) && passed(+new Date(t.due_date)) && isLate(t.due_date, new Date(now))) due.push(t);
      else if ((t.reminders || []).some(r => isSet(r.reminder) && passed(+new Date(r.reminder)))) reminded.push(t);
    }
    // Flash their rows where they are now, and announce them to a screen reader.
    const name = t => `“${this.rowTitle(t)}”`, list = [...due, ...reminded];
    if (!list.length) return;
    this.flash(list.map(t => t.id), 'due');
    this.said = list.length === 1 ? (due.length ? `${name(list[0])} is due now` : `Reminder: ${name(list[0])}`)
      : `${list.length} tasks are due ${reminded.length ? 'or have a reminder ' : ''}now: ${name(list[0])} and ${list.length - 1} more`;
  },
  // Regroup Today's dated tasks for the time now, without asking Vikunja. Returns them.
  regroupToday(){
    const groups = this.view.groups, dated = groups.filter(g => ['overdue', 'today', 'week'].includes(g.key)).flatMap(g => g.tasks);
    if (['overdue', 'today', 'week'].every(k => groups.some(g => g.key === k))) this.placeDated(groups, dated);
    return dated;
  },
  /* Put each dated task in its group: Overdue once its time has passed (for a task due on a day with no time, once that
     day is over), Today, or the next 7 days. A card goes by the earliest date among its task and its open subtasks
     (`cards`). The app icon shows the overdue count. */
  placeDated(groups, tasks, cards = this.view.cards || {}){
    const [overdue, today, week] = ['overdue', 'today', 'week'].map(k => groups.find(g => g.key === k)), now = new Date();
    const at = todayAt(cards), order = todayOrder(at);
    for (const g of [overdue, today, week]) g.tasks = [];
    for (const t of tasks) ({overdue, today}[dayGroup(at(t).due_date, now)] || week).tasks.push(t);
    for (const g of [overdue, today, week]) g.tasks.sort(order[g.key]);
    this.groupedAt = +now;
    this.setBadge(overdue.tasks.length);
  },
  setBadge(n){
    try { (n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.())?.catch(() => {}); } catch {}
  },

  /* ---------- a checklist's countdowns ---------- */
  // Runs every second. A countdown on the checklist on screen chimes once when it reaches zero. The screen stays on
  // while a countdown runs.
  tickRun(){
    const v = this.route.name === 'run' && document.visibilityState === 'visible' && this.view.shownRun ? this.runView : null;
    this.keepAwake(!!v && !v.finished && v.steps.some(s => s.counting));
    if (!v) return;
    const now = serverTime(Date.now());
    // Recompute the checklist only when the time has changed something it shows (runShows): a countdown's text, a
    // step's time arriving, or the day.
    if (runShows(v.steps, now) !== runShows(v.steps, serverTime(this.runNow))) this.runNow = Date.now();
    for (const s of v.steps) {
      if (!s.counting || s.dueAt > now || now - s.dueAt > 6e4) continue;   // chime within a minute of the time, not long after
      const k = s.id + '@' + s.dueAt;
      if (alerted.has(k)) continue;
      alerted.add(k);
      this.chime();
      navigator.vibrate?.([200, 100, 200]);
      this.notify(`“${s.title}” is due now`);
    }
  },
  /* Browsers only play sound after a tap, so the tap that starts a checklist or ticks a step plays a moment of silence.
     That lets an iPhone play sounds later. */
  unlockSound(){
    try {
      sound ||= new (window.AudioContext || window.webkitAudioContext)();
      if (sound.state === 'suspended') sound.resume();
      const s = sound.createBufferSource(); s.buffer = sound.createBuffer(1, 1, 22050); s.connect(sound.destination); s.start();
    } catch {}
  },
  // Play two short notes. The audio session is set to playback only while they play. That lets an iPhone play them
  // with the silent switch on, without pausing other music for longer than needed.
  chime(){
    if (!sound) return;
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
      if (sound.state === 'suspended') sound.resume();
      const t = sound.currentTime + 0.05;
      [[880, 0], [660, 0.22]].forEach(([hz, at]) => {
        const o = sound.createOscillator(), g = sound.createGain();
        o.frequency.value = hz; o.connect(g); g.connect(sound.destination);
        g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(0.4, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.2);
        o.start(t + at); o.stop(t + at + 0.21);
      });
      setTimeout(() => { try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {} }, 800);
    } catch {}
  },
  // Keep the screen on while a countdown runs on screen, where the phone allows. The phone releases the lock when
  // Pocket is hidden, so Pocket asks for it again on return.
  keepAwake(want){
    if (want && !wakeLock && !askingLock && 'wakeLock' in navigator && Date.now() - lockFailed > 3e4) {
      askingLock = true;
      navigator.wakeLock.request('screen').then(l => {
        wakeLock = l;
        l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
      }, () => { lockFailed = Date.now(); }).finally(() => { askingLock = false; });
    } else if (!want && wakeLock) { const l = wakeLock; wakeLock = null; l.release().catch(() => {}); }
  },
};
