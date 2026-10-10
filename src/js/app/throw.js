/* A row or a card held on Today: four dates, around the finger (hold-to-reschedule-plan; which is where, their days and
   where they sit are ../throw.js). Held, it lifts where it is, and the dates draw in as chips around the finger, over
   the rows above and below, with nothing over the screen and nothing following the finger. The direction the finger
   has moved lights its date, a tick felt at each change; let go, the task's date moves there at once, with an Undo
   for a few seconds (design rule 8; reschedule, app/actions.js). Back near where it was held, none is lit, and letting
   go there changes nothing. A flick counts by its direction, before the chips have drawn. A card moves only its task's
   date. What a hold can't move there, as Move all to today leaves it, has every date dimmed, and a line saying why.
   Let go without ever having moved out, the dates stay open, to tap: the hold's own tap path (design rule 3). A menu
   then, each date a button named for a screen reader, the first one focused; a tap anywhere else, or Escape, closes it,
   changing nothing.
   It's hooked in at one place: Today's rows and cards give `reschedule` (screenRows, lists.js), and holdOf and cardHold
   (app/progress.js) then ask rescheduleOf here. Taking those out, and this file and ../throw.js, takes it all out. */
import {THROW, THROW_STAYS, throwEnd, throwFlick, throwLayout, throwPick, throwTargets} from '../throw.js';
import {hasTemplateLabel} from '../checklists.js';
import {repeats} from '../dates.js';
import {haptic} from '../haptics.js';
import {motion} from '../util.js';

const el = (tag, cls, text = '') => { const x = document.createElement(tag); x.className = cls; x.textContent = text; return x; };
// A box of the layout `lay` ({x, y: its middle, from the set's; w, h}), placed in px.
const put = (x, lay, b) => Object.assign(x.style, {left: lay.x + b.x - b.w / 2 + 'px', top: lay.y + b.y - b.h / 2 + 'px', width: b.w + 'px', height: b.h + 'px'});
let shut = null;                                        // closes the dates open to tap now, if any: one set at a time

/* The chips, for the layout `lay` (throwLayout), and `why` the task can't move (THROW_STAYS's key), if it can't: each
   date's name over its day ("Tomorrow", "Sat 10"), dimmed where it would change nothing, or all of them with the line
   saying why. Placed in px in its parent, which is the screen (position:fixed), or a still of it in the specimen.
   Buttons from the start, so they're in the same place whether they're flicked to or tapped, but only for a finger
   while it's held (aria-hidden, and not reached by Tab) until they're open to tap (chipsOpen). Text only, never HTML. */
export function chipsEl(lay, why = null){
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
  if (why) {
    const p = el('p', 'throw-why', THROW_STAYS[why]);
    Object.assign(p.style, {left: lay.x + lay.why.x + 'px', top: lay.y + lay.why.y + 'px', maxWidth: lay.why.w + 'px'});
    set.append(p);
  }
  return set;
}
// The date `p` lit among the chips `set`, or none.
export function chipsLight(set, p){
  set.querySelector('.throw-t.on')?.classList.remove('on');
  if (p) set.querySelector(`.throw-t[data-id="${p.id}"]`)?.classList.add('on');
}
/* The chips `set` open to tap, for the task titled `title`: a menu, where they were. No longer hidden from a screen
   reader, and named for the task; each date can be reached (a dimmed one says it's dimmed, and does nothing), and the
   line saying why a task can't move is read with them. The screen behind is dimmed very lightly then (.throw.open),
   as a tap on it only closes them. */
export function chipsOpen(set, title){
  set.removeAttribute('aria-hidden');
  set.classList.add('open');
  set.setAttribute('role', 'dialog'); set.setAttribute('aria-modal', 'true'); set.setAttribute('aria-label', `Move “${title}” to another day`);
  const why = set.querySelector('.throw-why');
  if (why) { why.id = 'throw-why'; set.setAttribute('aria-describedby', why.id); }
  for (const b of set.querySelectorAll('.throw-t')) b.tabIndex = 0;
}

export default {
  /* What a hold on Today does to task `t` (`el`: what's held, a row, or for a card, the card): its dates, around the
     finger (throwOf). Not one done, marked, with a line in its place, waiting to be sent or that can't be written to:
     nothing. A repeating task (moved, its next times would follow the new date; ticked, it moves on to its next), a
     checklist that comes round and a checklist run, or a run's step: the dates all dimmed, saying why. */
  rescheduleOf(t, el){
    if (!t || t.pending || t.done || this.leaving[t.id] || this.lines[t.id] || !this.canWrite(t.project_id)) return null;
    const why = this.isRunTask(t) || this.stepRun(t) ? 'run' : hasTemplateLabel(t) ? 'checklist' : repeats(t) ? 'repeats' : null;
    return this.throwOf(t, el, why);
  },
  /* The hold, as holdToSlide drives it (app/progress.js): lift(x, y) as the hold is felt, at once, so a flick that
     follows counts; move(_, y, x) with the finger; end(commit) as it's let go (or taken away: nothing). What's picked
     is where the finger has gone from where it was held (throwPick), whatever is drawn where (throwView); what letting
     go does is throwEnd's: the task moved, nothing, or its dates left open to tap, each then moving it as a direction
     does. */
  throwOf(t, held, why){
    const app = this, targets = throwTargets(t.due_date);
    let v = null, x0 = 0, y0 = 0, on = null, out = false, dx = 0, dy = 0, moves = [];
    // A date that can be picked: not a dimmed one, nor any on a task that can't move.
    const can = p => p && !p.dim && !why ? p : null;
    /* How fast the finger was going as it was let go, px/ms, over its last moves: from where it was at least 16ms before
       its last (or where it was held, a frame before its first), to its last; 0 if it had stopped before it lifted. What
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
        // The date the finger points at, lit, a tick felt.
        on = p; v.light(can(p));
        if (can(p)) haptic('tick');
      },
      end(commit){
        if (!v) return;
        const was = v, e = throwEnd({commit, on, out, why, flick: on ? null : throwFlick(targets, dx, dy, speed())});
        v = null;
        if (e.then === 'open') { was.open(id => app.moveHeld(t, targets.find(x => x.id === id), true)); return; }
        was.close();
        if (e.to) app.moveHeld(t, e.to);
      },
    };
  },
  /* The task held, moved to the date picked (`to`, one of throwTargets'): at once, with its Undo (reschedule), its row
     lit up where it lands. `tapped`: picked from the dates open to tap, which had the focus: it goes to its row, where
     it is now. */
  moveHeld(t, to, tapped = false){
    this.reschedule(t, {due: to.due, label: to.label});
    this.flash([t.id], 'arrived');
    if (tapped) this.$nextTick(() => this.rowEl(t.id)?.querySelector('.card-open, .body')?.focus({preventScroll: true}));
  },
  /* The dates drawn for task `t`, for what's `held` (a row, or a card) at (x, y), which lifts where it is
     (.throw-from): {light(p): the date `p` lit, or none; close(): gone, the row as it was; open(pick): left open to
     tap, pick(id) called with the date tapped}. Around the finger, at the height of the strip it's on (the row, or a
     card's header or row), so the dates above and below lie over its neighbours and the row shows between them; kept
     on the screen, clear of the header and the add box (throwLayout). The chips scale and fade in; with less motion
     they're simply there. */
  throwView(t, held, targets, why, x, y){
    shut?.();
    const top = Math.max(0, document.querySelector('header.top')?.getBoundingClientRect().bottom || 0);
    const bottom = document.getElementById('capture')?.getBoundingClientRect().top || innerHeight;
    const strip = [...held.querySelectorAll('.card-head, .row'), held].map(s => s.getBoundingClientRect()).find(r => y >= r.top && y <= r.bottom && r.height <= 2 * THROW.mid.h);
    const lay = throwLayout(targets, {x, y: strip ? strip.top + strip.height / 2 : y, width: innerWidth, height: innerHeight, top, bottom: Math.min(bottom, innerHeight), why: !!why});
    const set = chipsEl(lay, why);
    document.body.append(set);
    held.classList.add('throw-from');
    if (motion()) {
      for (const c of set.querySelectorAll('.throw-t')) c.animate([{opacity: 0, transform: 'scale(.9)'}, {opacity: 1, transform: 'none'}], {duration: THROW.ms, easing: 'ease-out'});
      set.querySelector('.throw-why')?.animate([{opacity: 0}, {opacity: 1}], {duration: THROW.ms});
    }
    const off = [], close = () => { for (const f of off.splice(0)) f(); if (shut === close) shut = null; set.remove(); held.classList.remove('throw-from'); };
    return {light: p => chipsLight(set, p), close,
      /* Open to tap. A press that starts on it counts, and a key's: not the click the hold's own release may be
         followed by, with the finger still where Pick a date… is. A dimmed date does nothing. A tap anywhere else,
         Escape, the page scrolled, turned or left: closed, nothing changed, the focus back on the row. The arrow keys
         go to the date in that direction, and Tab stays among them. */
      open(pick){
        chipsOpen(set, t.title);
        chipsLight(set, null);
        let pressed = false;
        const chips = () => [...set.querySelectorAll('.throw-t')];
        const leave = () => { close(); held.querySelector('.card-open, .body')?.focus({preventScroll: true}); };
        const on = (target, type, fn, how) => { target.addEventListener(type, fn, how); off.push(() => target.removeEventListener(type, fn, how)); };
        on(set, 'pointerdown', () => { pressed = true; });
        // (That release's own mouse events, and a press beside the dates, don't take the focus from them.)
        on(set, 'mousedown', e => { if (!pressed || !e.target.closest('.throw-t')) e.preventDefault(); });
        on(set, 'click', e => {
          if (!pressed && e.detail) return;
          const b = e.target.closest('.throw-t');
          if (!b) { leave(); return; }
          if (b.getAttribute('aria-disabled') === 'true') return;
          close(); pick(b.dataset.id);
        });
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
