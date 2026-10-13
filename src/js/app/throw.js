/* Hold a row or a card on Today to move its task to another day. Four dates draw as chips around the finger. Moving
   the finger towards one lights it, and letting go moves the task there at once, with an Undo. A flick picks by
   direction. Letting go without having moved leaves the chips open to tap, as a menu with Pick a date… in the middle
   for the phone's own date picker. Which dates, their days and where they sit are in ../throw.js. holdOf and cardHold
   (progress.js) hook this in through rescheduleOf. */
import {dateValue, THROW, THROW_STAYS, throwDate, throwEnd, throwFlick, throwLayout, throwPick, throwTargets} from '../throw.js';
import {hasTemplateLabel} from '../checklists.js';
import {isSet, repeats} from '../dates.js';
import {haptic} from '../haptics.js';
import {motion} from '../util.js';

const el = (tag, cls, text = '') => { const x = document.createElement(tag); x.className = cls; x.textContent = text; return x; };
// Position box `b` ({x, y}: its centre within the layout `lay`; w, h) in px.
const put =(x, lay, b) => Object.assign(x.style, {left: lay.x + b.x - b.w / 2 + 'px', top: lay.y + b.y - b.h / 2 + 'px', width: b.w + 'px', height: b.h + 'px'});
let shut = null;                                        // closes the chips open to tap, if any (one set at a time)

/* The chips for layout `lay` (throwLayout): each date's name over its day ("Tomorrow", "Sat 10"), dimmed where it
   would change nothing. When the task can't move, `why` (a THROW_STAYS key) dims them all and adds a line saying why.
   Positioned in px within a fixed parent. They are buttons from the start, so they sit in the same place whether
   flicked to or tapped, but hidden from screen readers and Tab until chipsOpen. Text only, never HTML. Pick a date…
   sits in the middle, where the finger is, and shows only once the chips are open to tap. Under it is the date input
   whose picker it opens: `from` is the first day offered, `at` the day it opens on. */
export function chipsEl(lay, why = null, {from = '', at = ''} = {}){
  const set = el('div', 'throw');
  set.setAttribute('aria-hidden', 'true');
  for (const t of lay.targets) {
    const b = el('button', `throw-t ${t.at}` + (t.day ? '' : ' none') + (t.dim || why ? ' dim' : ''));
    b.type = 'button'; b.tabIndex = -1; b.dataset.id = t.id;
    b.setAttribute('aria-label', t.date ? `${t.name}, ${t.date}` : t.name);
    if (t.dim || why) b.setAttribute('aria-disabled', 'true');
    b.append(el('b', '', t.name));
    if (t.date) b.append(el('span', '', t.date));
    put(b, lay, t); set.append(b);
  }
  const pick = el('button', 'throw-t pick' + (why ? ' dim' : ''), 'Pick a date…'), date = el('input', 'throw-date');
  pick.type = 'button'; pick.tabIndex = -1;
  if (why) pick.setAttribute('aria-disabled', 'true');
  Object.assign(date, {type: 'date', tabIndex: -1, min: from, value: at});
  date.setAttribute('aria-label', 'Pick a date');
  for (const x of [date, pick]) { put(x, lay, {x: 0, y: 0, ...lay.mid}); set.append(x); }
  if (why) {
    const p = el('p', 'throw-why', THROW_STAYS[why]);
    Object.assign(p.style, {left: lay.x + lay.why.x + 'px', top: lay.y + lay.why.y + 'px', maxWidth: lay.why.w + 'px'});
    set.append(p);
  }
  return set;
}
// Light date `p` among the chips, or none.
export function chipsLight(set, p){
  set.querySelector('.throw-t.on')?.classList.remove('on');
  if (p) set.querySelector(`.throw-t[data-id="${p.id}"]`)?.classList.add('on');
}
/* Turn the chips into a menu to tap, where they are: a dialog named for the task, each date reachable by Tab, a
   dimmed one announced as disabled, and the line saying why read with them. The screen behind dims slightly
   (.throw.open), since a tap on it only closes the menu. */
export function chipsOpen(set, title){
  set.removeAttribute('aria-hidden');
  set.classList.add('open');
  set.setAttribute('role', 'dialog'); set.setAttribute('aria-modal', 'true'); set.setAttribute('aria-label', `Move “${title}” to another day`);
  const why = set.querySelector('.throw-why');
  if (why) { why.id = 'throw-why'; set.setAttribute('aria-describedby', why.id); }
  for (const b of set.querySelectorAll('.throw-t')) b.tabIndex = 0;
}

export default {
  /* What a hold on Today does to task `t` (`el` is the row or card held). Nothing for a task that is done, leaving
     after its batch, replaced by a line, waiting to be sent, or in a project this person can't write to. A repeating
     task, a checklist that comes round, a checklist run or one of its steps gets every date dimmed, with a line saying
     why. */
  rescheduleOf(t, el){
    if (!t || t.pending || t.done || this.leaving[t.id] || this.lines[t.id] || !this.canWrite(t.project_id)) return null;
    const why = this.isRunTask(t) || this.stepRun(t) ? 'run' : hasTemplateLabel(t) ? 'checklist' : repeats(t) ? 'repeats' : null;
    return this.throwOf(t, el, why);
  },
  /* The hold as holdToSlide (progress.js) drives it: lift(x, y) as soon as the hold is felt, so a flick that follows
     counts; move(_, y, x) with the finger; end(commit) when it is let go. The pick depends only on how far the finger
     has moved from where it was held (throwPick), not on what is drawn where. throwEnd decides what letting go does:
     move the task, do nothing, or leave the chips open to tap. */
  throwOf(t, held, why){
    const app = this, targets = throwTargets(t.due_date);
    let v = null, x0 = 0, y0 = 0, on = null, out = false, dx = 0, dy = 0, moves = [];
    // A date that can be picked: not dimmed, and not on a task that can't move.
    const can = p => p && !p.dim && !why ? p : null;
    /* The finger's speed as it was let go, in px/ms over its last moves: from where it was at least 16ms before its last
       move (or where it was held, a frame before the first) to its last move. 0 if it had stopped before it lifted. This
       tells a flick from a slow move let go near where it started. */
    const speed = () => {
      const last = moves.at(-1);
      if (!last || performance.now() - last.t > 80) return 0;
      const ref = moves.findLast(m => last.t - m.t >= 16) || {t: moves[0].t - 16, dx: 0, dy: 0};
      return Math.hypot(last.dx - ref.dx, last.dy - ref.dy) / (last.t - ref.t);
    };
    return {el: held,
      lift(x, y){ x0 = x; y0 = y; v = app.throwView(t, held, targets, why, x, y); },
      move(_, y, x){
        if (!v) return;
        dx = x - x0; dy = y - y0;
        moves.push({t: performance.now(), dx, dy}); if (moves.length > 12) moves.shift();
        const p = throwPick(targets, dx, dy, !!on);
        if (p) out = true;
        if (p?.id === on?.id) return;
        on = p; v.light(can(p));
        if (can(p)) haptic('tick');
      },
      end(commit){
        if (!v) return;
        const was = v, e = throwEnd({commit, on, out, why, flick: on ? null : throwFlick(targets, dx, dy, speed())});
        v = null;
        // Open to tap: a tapped date moves the task, and so does a day picked in the picker, unless it is the day the task already has.
        if (e.then === 'open') { was.open(id => app.moveHeld(t, targets.find(x => x.id === id), true), day => { const to = throwDate(t.due_date, day); if (to && !to.dim) app.moveHeld(t, to, true); }); return; }
        was.close();
        if (e.to) app.moveHeld(t, e.to);
      },
    };
  },
  /* Move the held task to the date picked (`to`, one of throwTargets') at once, with an Undo, and flash its row where
     it lands. `tapped` means it was picked from the open chips, which had the focus, so the focus goes back to the
     row. */
  moveHeld(t, to, tapped = false){
    this.reschedule(t, {due: to.due, label: to.label});
    this.flash([t.id], 'arrived');
    if (tapped) this.$nextTick(() => this.rowEl(t.id)?.querySelector('.card-open, .body')?.focus({preventScroll: true}));
  },
  /* Draw the dates for task `t` around the finger at (x, y), with `held` (a row or a card) lifted in place
     (.throw-from). Returns {light(p), close(), open(pick, picked)}. open leaves the chips to tap and calls pick(id) with
     the date tapped, or picked(day) with the day chosen in the phone's picker. The chips centre on the strip the
     finger is on (the row, or a card's header or row), so the dates above and below lie over its neighbours and the
     row shows between them, and stay clear of the header and the add box (throwLayout). The chips scale and fade in,
     or with reduced motion are simply there. */
  throwView(t, held, targets, why, x, y){
    shut?.();
    const top = Math.max(0, document.querySelector('header.top')?.getBoundingClientRect().bottom || 0);
    const bottom = document.getElementById('capture')?.getBoundingClientRect().top || innerHeight;
    const strip = [...held.querySelectorAll('.card-head, .row'), held].map(s => s.getBoundingClientRect()).find(r => y >= r.top && y <= r.bottom && r.height <= 2 * THROW.mid.h);
    const lay = throwLayout(targets, {x, y: strip ? strip.top + strip.height / 2 : y, width: innerWidth, height: innerHeight, top, bottom: Math.min(bottom, innerHeight), why: !!why});
    // The picker's first day is today, and it opens on the task's own day unless that has passed.
    const today = dateValue(null), day = isSet(t.due_date) ? dateValue(t.due_date) : '';
    const set = chipsEl(lay, why, {from: today, at: day >= today ? day : ''});
    document.body.append(set);
    held.classList.add('throw-from');
    if (motion()) {
      for (const c of set.querySelectorAll('.throw-t[data-id]')) c.animate([{opacity: 0, transform: 'scale(.9)'}, {opacity: 1, transform: 'none'}], {duration: THROW.ms, easing: 'ease-out'});
      set.querySelector('.throw-why')?.animate([{opacity: 0}, {opacity: 1}], {duration: THROW.ms});
    }
    const off = [], close = () => { for (const f of off.splice(0)) f(); if (shut === close) shut = null; set.remove(); held.classList.remove('throw-from'); };
    return {light: p => chipsLight(set, p), close,
      /* Open to tap. Only a press that starts on the chips counts, or a key: not the click that may follow the hold's
         own release, with the finger still over Pick a date…. A dimmed date does nothing. Pick a date… opens the
         phone's picker straight from the tap, because a phone allows it only then (as the sheet's Due does: propTap),
         and the day chosen there closes it all. A tap anywhere else, Escape, or the page scrolled, turned or left
         closes the menu, changes nothing, and puts the focus back on the row. The arrow keys move to the date in that
         direction, and Tab stays among the chips. */
      open(pick, picked){
        chipsOpen(set, t.title);
        chipsLight(set, null);
        let pressed = false;
        const chips = () => [...set.querySelectorAll('.throw-t')], date = set.querySelector('.throw-date');
        const leave = () => { close(); held.querySelector('.card-open, .body')?.focus({preventScroll: true}); };
        const on = (target, type, fn, how) => { target.addEventListener(type, fn, how); off.push(() => target.removeEventListener(type, fn, how)); };
        on(set, 'pointerdown', () => { pressed = true; });
        // The release's own mouse events, and a press beside the dates, must not take the focus from the chips.
        on(set, 'mousedown', e => { if (!pressed || !e.target.closest('.throw-t')) e.preventDefault(); });
        on(set, 'click', e => {
          if (!pressed && e.detail) return;
          const b = e.target.closest('.throw-t');
          if (!b) { leave(); return; }
          if (b.getAttribute('aria-disabled') === 'true') return;
          if (b.matches('.pick')) { date.focus({preventScroll: true}); try { date.showPicker(); } catch {} return; }
          close(); pick(b.dataset.id);
        });
        on(date, 'change', () => { const day = date.value; if (!day) return; close(); picked(day); });
        on(document, 'keydown', e => {
          const to = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'}[e.key];
          if (e.key === 'Escape') leave();
          else if (to) set.querySelector('.throw-t.' + to)?.focus();
          else if (e.key === 'Tab') { const all = chips(), i = all.indexOf(document.activeElement); all[(i + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus(); }
          else return;
          e.preventDefault(); e.stopPropagation();
        }, true);
        for (const type of ['scroll', 'resize', 'hashchange', 'popstate']) on(window, type, leave, {passive: true});
        shut = close;
        chips()[0]?.focus({preventScroll: true});
      }};
  },
};
