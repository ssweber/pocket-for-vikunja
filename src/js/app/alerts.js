/* Alerts while Pocket is on screen: Today keeps itself up to date, and a run's countdown chimes at zero. Pocket promises
   only what always works, so there are no system notifications: these are toasts, with a chime, vibration (Android),
   the screen kept on during a countdown and the overdue count on the app's icon wherever the phone allows, each tried
   and quietly skipped where it doesn't. Reminders while Pocket is closed are Vikunja's, by email. */
import {store} from '../util.js';
import {serverTime} from '../api.js';
import {isLate, isSet, startOfDay} from '../dates.js';

let sound = null;                                // the AudioContext, made on a tap so the browser lets it play
let wakeLock = null, askingLock = false, lockFailed = 0;
let lastTick = Date.now();                       // when Today was last checked

// Steps that have chimed, by step and due time, so each does once, even after leaving its run and coming back.
const alerted = {
  all(){ try { return JSON.parse(store.get('alerted')) || {}; } catch { return {}; } },
  has(k){ return k in this.all(); },
  add(k){ const a = this.all(), old = Date.now() - 2 * 864e5; for (const [x, at] of Object.entries(a)) if (at < old) delete a[x]; a[k] = Date.now(); store.set('alerted', JSON.stringify(a)); },
};

export default {
  /* Today every minute while it's on screen: tasks move to Overdue as their time passes, without asking Vikunja again
     (a new day loads afresh), and one whose due time or reminder passes while you're looking says so. */
  tickToday(){
    const now = Date.now(), since = lastTick;
    lastTick = now;
    if (this.route.name !== 'today' || document.visibilityState !== 'visible' || this.view.loading || this.sheet.open) return;
    if (this.todayDay !== +startOfDay()) { this.render(); return; }
    const groups = this.view.groups, dated = groups.filter(g => ['overdue', 'today', 'week'].includes(g.key));
    this.placeDated(groups, dated.flatMap(g => g.tasks));
    const passed = (at) => at > since && at <= now;
    const due = [], reminded = [];
    for (const t of dated.flatMap(g => g.tasks)) {
      if (isSet(t.due_date) && passed(+new Date(t.due_date)) && isLate(t.due_date, new Date(now), this.dueTime)) due.push(t);
      else if ((t.reminders || []).some(r => isSet(r.reminder) && passed(+new Date(r.reminder)))) reminded.push(t);
    }
    const name = t => `“${t.title}”`, list = [...due, ...reminded];
    if (list.length === 1) this.notify(due.length ? `${name(list[0])} is due now` : `Reminder: ${name(list[0])}`);
    else if (list.length) this.notify(`${list.length} tasks are due now: ${name(list[0])} and ${list.length - 1} more`);
  },
  /* Today's dated tasks, each in its group: Overdue once its time has passed (one due on a day, with no time of its own,
     once that day is over), Today, or the next 7 days. The app's icon shows how many are overdue. */
  placeDated(groups, tasks){
    const [overdue, today, , , week] = groups, now = new Date(), t1 = +startOfDay() + 864e5;
    for (const g of [overdue, today, week]) g.tasks = [];
    for (const t of tasks) (isLate(t.due_date, now, this.dueTime) ? overdue : new Date(t.due_date) < t1 ? today : week).tasks.push(t);
    overdue.tasks.sort((a,b) => (b.priority||0) - (a.priority||0) || new Date(a.due_date) - new Date(b.due_date));
    today.tasks.sort((a,b) => new Date(a.due_date) - new Date(b.due_date));
    this.todayDay = +startOfDay();
    this.setBadge(overdue.tasks.length);
  },
  setBadge(n){
    try { (n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.())?.catch(() => {}); } catch {}
  },

  /* ---------- a run's countdowns ---------- */
  // Every second: a countdown on the run on screen that reaches zero chimes, once; and the screen stays on while one runs.
  tickRun(){
    const v = this.route.name === 'run' && document.visibilityState === 'visible' && this.view.run ? this.runView : null;
    this.keepAwake(!!v && !v.finished && v.steps.some(s => s.counting));
    if (!v) return;
    const now = serverTime(Date.now());
    for (const s of v.steps) {
      if (!s.counting || s.dueAt > now || now - s.dueAt > 6e4) continue;   // only as it happens, not long after
      const k = s.id + '@' + s.dueAt;
      if (alerted.has(k)) continue;
      alerted.add(k);
      this.chime();
      navigator.vibrate?.([200, 100, 200]);
      this.notify(`“${s.title}” is due now`);
    }
  },
  /* Browsers only play sound after a tap, so the tap that starts a run or marks a step done gets it ready, with a
     moment of silence, which is what lets an iPhone play later. */
  unlockSound(){
    try {
      sound ||= new (window.AudioContext || window.webkitAudioContext)();
      if (sound.state === 'suspended') sound.resume();
      const s = sound.createBufferSource(); s.buffer = sound.createBuffer(1, 1, 22050); s.connect(sound.destination); s.start();
    } catch {}
  },
  // Two short notes. With the audio session set to playback, an iPhone may play it with the silent switch on; that's
  // set only while it plays, so music playing elsewhere isn't stopped for longer than that.
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
  // The screen kept on (where the phone allows) while a countdown runs on screen. The phone lets go when Pocket is
  // hidden, so it's asked again on coming back.
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
