/* Holding a row or a card on Today moves its task to another day. Four date chips appear around the touch. Dragging
   towards a chip highlights it, and releasing moves the task there at once, with an Undo. A flick picks the chip in
   its direction. Releasing without having dragged leaves the chips open to tap, as a menu with Pick a date… in the
   middle, which opens the phone's own date picker. ../throw.js decides which dates are offered and where the chips
   sit. holdOf and cardHold (progress.js) use this file through rescheduleOf. */
import {dateValue, THROW, THROW_STAYS, throwDate, throwEnd, throwFlick, throwLayout, throwPick, throwTargets} from '../throw.js';
import {hasTemplateLabel} from '../checklists.js';
import {isSet, repeats} from '../dates.js';
import {haptic} from '../haptics.js';
import {motion} from '../util.js';

const el = (tag, cls, text = '') => { const x = document.createElement(tag); x.className = cls; x.textContent = text; return x; };
// Position box `b` in px. `b.x` and `b.y` are its centre within the layout `lay`, and `b.w` and `b.h` its size.
const put =(x, lay, b) => Object.assign(x.style, {left: lay.x + b.x - b.w / 2 + 'px', top: lay.y + b.y - b.h / 2 + 'px', width: b.w + 'px', height: b.h + 'px'});
let shut = null;                                        // closes the chips open to tap (only one set is open at a time)

/* Build the chips for layout `lay` (throwLayout). Each chip shows the date's name over its day ("Tomorrow", "Sat 10"),
   and is dimmed if choosing it would change nothing. When the task can't move, `why` (a THROW_STAYS key) dims every
   chip and adds a message that gives the reason.
   The chips are positioned in px inside a fixed parent. They are buttons from the start, so they sit in the same place
   whether the user flicks to one or taps it. Screen readers and Tab skip them until chipsOpen. They hold text only,
   never HTML.
   Pick a date… sits in the middle, under the touch, and shows only once the chips are open to tap. Beneath it is the
   date input whose picker it opens. `from` is the first day offered, and `at` is the day the picker opens on. */
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
// Highlight the chip for date `p`, or clear the highlight if `p` is null.
export function chipsLight(set, p){
  set.querySelector('.throw-t.on')?.classList.remove('on');
  if (p) set.querySelector(`.throw-t[data-id="${p.id}"]`)?.classList.add('on');
}
/* Turn the chips into a menu to tap, where they are. The menu is a dialog named for the task. Tab reaches each date,
   a dimmed chip is announced as disabled, and the message that gives the reason is read with the dialog. The screen
   behind dims slightly (.throw.open), because a tap on it only closes the menu. */
export function chipsOpen(set, title){
  set.removeAttribute('aria-hidden');
  set.classList.add('open');
  set.setAttribute('role', 'dialog'); set.setAttribute('aria-modal', 'true'); set.setAttribute('aria-label', `Move “${title}” to another day`);
  const why = set.querySelector('.throw-why');
  if (why) { why.id = 'throw-why'; set.setAttribute('aria-describedby', why.id); }
  for (const b of set.querySelectorAll('.throw-t')) b.tabIndex = 0;
}

export default {
  /* What holding task `t` on Today does. `el` is the row or card held. A task does nothing if it is done, marked to
     leave with its batch, replaced by a message, waiting to be sent, or in a project the user can't write to.
     A repeating task, a template that repeats, a started checklist and a checklist's step get every date dimmed, with
     a message that gives the reason. */
  rescheduleOf(t, el){
    if (!t || t.pending || t.done || this.leaving[t.id] || this.lines[t.id] || !this.canWrite(t.project_id)) return null;
    const why = this.isRunTask(t) || this.stepRun(t) ? 'run' : hasTemplateLabel(t) ? 'checklist' : repeats(t) ? 'repeats' : null;
    return this.throwOf(t, el, why);
  },
  /* The hold gesture that holdToSlide (progress.js) drives. It calls lift(x, y) as soon as the phone vibrates for the
     hold, so a flick right after still counts. It calls move(_, y, x) as the touch moves, and end(commit) on release.
     The chip chosen depends only on how far the touch has moved from where the hold began (throwPick), not on what is
     drawn where. On release, throwEnd decides whether to move the task, do nothing or leave the chips open to tap. */
  throwOf(t, held, why){
    const app = this, targets = throwTargets(t.due_date);
    let v = null, x0 = 0, y0 = 0, on = null, out = false, dx = 0, dy = 0, moves = [];
    // Returns date `p` if it can be picked, which means it is not dimmed and the task can move. Otherwise null.
    const can = p => p && !p.dim && !why ? p : null;
    /* The touch's speed at release, in px/ms. It is measured from the position at least 16ms before the last move (or
       the position where the hold began, a frame before the first move) to the last move. It is 0 if the touch had
       stopped more than 80ms before release. The speed tells a flick from a slow drag released near where it started. */
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
        // Tapping a date moves the task. So does picking a day in the picker, unless the task is already on that day.
        if (e.then === 'open') { was.open(id => app.moveHeld(t, targets.find(x => x.id === id), true), day => { const to = throwDate(t.due_date, day); if (to && !to.dim) app.moveHeld(t, to, true); }); return; }
        was.close();
        if (e.to) app.moveHeld(t, e.to);
      },
    };
  },
  /* Move the held task to date `to` (one of the throwTargets) at once, with an Undo, and flash its row where it lands.
     `tapped` means the date was picked from the open chips. They had the focus, so the focus goes back to the row. */
  moveHeld(t, to, tapped = false){
    this.reschedule(t, {due: to.due, label: to.label});
    this.flash([t.id], 'arrived');
    if (tapped) this.$nextTick(() => this.rowEl(t.id)?.querySelector('.card-open, .body')?.focus({preventScroll: true}));
  },
  /* Draw the date chips for task `t` around the touch at (x, y), and lift `held` (a row or a card) in place
     (.throw-from). Returns {light(p), close(), open(pick, picked)}. `open` leaves the chips open to tap. It calls
     pick(id) with the date tapped, or picked(day) with the day chosen in the phone's picker.
     The chips are centred on the strip the touch is on (the row, or a card's header or row). The chips above and below
     cover the neighbouring rows, and the held row shows between them. They stay clear of the header and the add box
     (throwLayout). The chips scale and fade in, or with reduced motion simply appear. */
  throwView(t, held, targets, why, x, y){
    shut?.();
    const top = Math.max(0, document.querySelector('header.top')?.getBoundingClientRect().bottom || 0);
    const bottom = document.getElementById('capture')?.getBoundingClientRect().top || innerHeight;
    const strip = [...held.querySelectorAll('.card-head, .row'), held].map(s => s.getBoundingClientRect()).find(r => y >= r.top && y <= r.bottom && r.height <= 2 * THROW.mid.h);
    const lay = throwLayout(targets, {x, y: strip ? strip.top + strip.height / 2 : y, width: innerWidth, height: innerHeight, top, bottom: Math.min(bottom, innerHeight), why: !!why});
    // The picker's first day is today. It opens on the task's due day unless that day has passed.
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
      /* Leave the chips open to tap. Only a press that starts on the chips counts, or a key. The click that can follow
         the hold's own release is ignored, because the touch may still be over Pick a date…. A dimmed date does
         nothing.
         Pick a date… opens the phone's picker straight from the tap, because a phone allows that only from a tap (as
         the sheet's Due does: propTap). Choosing a day there closes the menu and moves the task.
         A tap anywhere else, Escape, or the page scrolling, rotating or being left closes the menu, changes nothing,
         and puts the focus back on the row. An arrow key moves to the date in that direction. Tab stays among the
         chips. */
      open(pick, picked){
        chipsOpen(set, t.title);
        chipsLight(set, null);
        let pressed = false;
        const chips = () => [...set.querySelectorAll('.throw-t')], date = set.querySelector('.throw-date');
        const leave = () => { close(); held.querySelector('.card-open, .body')?.focus({preventScroll: true}); };
        const on = (target, type, fn, how) => { target.addEventListener(type, fn, how); off.push(() => target.removeEventListener(type, fn, how)); };
        on(set, 'pointerdown', () => { pressed = true; });
        // Mouse events from the hold's release, and a press beside the dates, must not take the focus off the chips.
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
