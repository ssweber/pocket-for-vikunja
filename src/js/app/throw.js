/* A row or a card held on Today, thrown at a ring of dates (parent-tasks-plan, 4b; the targets, their days and where
   they sit are ../throw.js). Held, it shrinks to a small box, and the ring draws in around where it was held; the box
   follows the finger from there, a tick felt crossing into each target, and letting go in one moves the task's date
   there at once, with an Undo for a few seconds (design rule 8; reschedule, app/actions.js); let go in the middle,
   nothing changes. A card moves only its task's date. What a hold can't move there, as Move all to today leaves it, opens the ring with every target
   dimmed and a line saying why. The tap path is the sheet's Due (rule 3); the ring itself is only for a finger.
   It's hooked in at one place: Today's rows and cards give `reschedule` (screenRows, lists.js), and holdOf and cardHold
   (app/progress.js) then ask rescheduleOf here. Taking those out, and this file and ../throw.js, takes it all out. */
import {THROW, THROW_STAYS, throwFlick, throwLayout, throwPick, throwTargets, thrownText} from '../throw.js';
import {hasTemplateLabel} from '../checklists.js';
import {repeats} from '../dates.js';
import {haptic} from '../haptics.js';
import {motion} from '../util.js';

const el = (tag, cls, text = '') => { const x = document.createElement(tag); x.className = cls; x.textContent = text; return x; };
const BOX = {w: 112, h: 44};                            // the small box the task shrinks to: styles.css's .throw-box

/* The ring's elements, for the layout `lay`, a task titled `title`, and `why` it can't move (THROW_STAYS's key), if it
   can't: the targets, the week labels, the box in the middle and the line saying why. Placed in px in its parent, which
   is the screen (position:fixed), or a still of it in the specimen. Text only, never HTML: a title is Vikunja's. */
export function ringEl(lay, title, why = null){
  const ring = el('div', 'throw'), at = (x, w) => x - w / 2;
  ring.setAttribute('aria-hidden', 'true');
  ring.append(el('div', 'throw-veil'));                 // the page behind, quietened
  for (const w of lay.weeks) {
    const l = el('span', 'throw-week', w.text);
    Object.assign(l.style, {left: lay.x + w.x + 'px', top: lay.y + w.y + 'px'});
    ring.append(l);
  }
  for (const t of lay.targets) {
    const b = el('div', `throw-t ${t.at}` + (t.dim || why ? ' dim' : '') + (t.week > 0 ? ' later' : ''));
    b.dataset.id = t.id;
    Object.assign(b.style, {left: lay.x + at(t.x, t.w) + 'px', top: lay.y + at(t.y, t.h) + 'px', width: t.w + 'px', height: t.h + 'px'});
    if (t.at === 'down') { b.innerHTML = '<svg class="i"><use href="#i-close"/></svg>'; b.append(el('b', '', t.name)); }
    else if (t.at === 'arc') b.append(el('b', '', t.name), el('span', '', String(t.day.getDate())));
    else b.append(el('b', '', t.name), el('span', '', t.date));
    ring.append(b);
  }
  const box = el('div', 'throw-box');
  box.append(el('span', '', title));
  Object.assign(box.style, {left: lay.x - BOX.w / 2 + 'px', top: lay.y - BOX.h / 2 + 'px'});
  ring.append(box);
  if (why) {
    const p = el('p', 'throw-why', THROW_STAYS[why]);
    Object.assign(p.style, {left: lay.x + 'px', top: lay.y + BOX.h / 2 + 10 + 'px'});
    ring.append(p);
  }
  return ring;
}

// Target `p` lit in `ring` (or none), and the box, under the finger and over it, saying where it would go ("Tomorrow",
// "Wed 14", "No date"), or with none, the task's `title`.
export function ringLight(ring, p, title){
  ring.querySelector('.throw-t.on')?.classList.remove('on');
  const box = ring.querySelector('.throw-box');
  box.classList.toggle('to', !!p); box.firstChild.textContent = p ? (p.at === 'arc' ? p.date : p.name) : title;
  if (p) ring.querySelector(`.throw-t[data-id="${p.id}"]`).classList.add('on');
}

export default {
  /* What a hold on Today does to task `t` (`el`: what's held, a row, or for a card, the card): the ring, thrown from
     (throwOf). Not one done, marked, with a line in its place, waiting to be sent or that can't be written to: nothing.
     A repeating task (moved, its next times would follow the new date; ticked, it moves on to its next), a checklist
     that comes round and a checklist run, or a run's step: the ring, every target dimmed, saying why. */
  rescheduleOf(t, el){
    if (!t || t.pending || t.done || this.leaving[t.id] || this.lines[t.id] || !this.canWrite(t.project_id)) return null;
    const why = this.isRunTask(t) || this.stepRun(t) ? 'run' : hasTemplateLabel(t) ? 'checklist' : repeats(t) ? 'repeats' : null;
    return this.throwOf(t, el, why);
  },
  /* The ring as holdToSlide drives a hold (app/progress.js): lift(x, y) as the hold is felt, at once, so a flick that
     follows counts; move(_, y, x) with the finger; end(commit) as it's let go (or taken away: nothing). */
  throwOf(t, held, why){
    const app = this, from = held.closest('.item') || held;
    let ring = null, box = null, lay = null, x0 = 0, y0 = 0, on = null, dx = 0, dy = 0, moves = [];
    // The target the finger is in, lit, a tick felt (not a dimmed one, nor any on a task that can't move).
    const light = p => {
      if (p?.id === on?.id) return;
      on = p;
      const go = p && !p.dim && !why ? p : null;
      ringLight(ring, go, t.title);
      if (go) haptic('tick');
    };
    /* How fast the finger was going as it was let go, px/ms, over its last moves: from where it was at least 16ms before
       its last (or where it was held, a frame before its first), to its last; 0 if it had stopped before it lifted. What
       tells a flick from a slow move let go in the middle. */
    const speed = () => {
      const last = moves.at(-1);
      if (!last || performance.now() - last.t > 80) return 0;
      const ref = moves.findLast(m => last.t - m.t >= 16) || {t: moves[0].t - 16, dx: 0, dy: 0};
      return Math.hypot(last.dx - ref.dx, last.dy - ref.dy) / (last.t - ref.t);
    };
    const fade = (x, frames, ms) => motion() ? x.animate(frames, {duration: ms, easing: 'ease-out', fill: 'forwards'}).finished.catch(() => {}) : Promise.resolve();
    return {el: held,
      lift(x, y){
        x0 = x; y0 = y;
        const top = Math.max(0, document.querySelector('header.top')?.getBoundingClientRect().bottom || 0);
        const bottom = document.getElementById('capture')?.getBoundingClientRect().top || innerHeight;
        lay = throwLayout(throwTargets(t.due_date), {x, y, width: innerWidth, height: innerHeight, top, bottom: Math.min(bottom, innerHeight)});
        ring = ringEl(lay, t.title, why); box = ring.querySelector('.throw-box');
        document.body.append(ring);
        from.classList.add('throw-from');
        if (!motion()) return;
        // The task shrinks from its place to the box; the ring draws in around it.
        const r = from.getBoundingClientRect(), sx = r.width / BOX.w, sy = r.height / BOX.h;
        box.animate([{transform: `translate(${r.left + r.width / 2 - lay.x}px, ${r.top + r.height / 2 - lay.y}px) scale(${sx}, ${sy})`, opacity: .6}, {transform: 'none', opacity: 1}],
          {duration: THROW.ms.draw, easing: 'ease-out'});
        for (const x of ring.querySelectorAll('.throw-t, .throw-week')) x.animate([{opacity: 0, transform: 'scale(.7)'}, {opacity: 1, transform: 'none'}], {duration: THROW.ms.draw, easing: 'ease-out'});
        ring.firstChild.animate([{opacity: 0}, {opacity: 1}], {duration: THROW.ms.draw});
      },
      move(_, y, x){
        if (!ring) return;
        dx = x - x0; dy = y - y0;
        moves.push({t: performance.now(), dx, dy}); if (moves.length > 12) moves.shift();
        box.style.translate = `${dx}px ${dy}px`;
        light(throwPick(lay, dx, dy));
      },
      async end(commit){
        if (!ring) return;
        const p = on || (commit ? throwFlick(lay, dx, dy, speed()) : null), go = commit && p && !p.dim && !why ? p : null, was = ring;
        ring = null;
        // (Whatever happens, the ring goes, and the task it was shows again.)
        setTimeout(() => { was.remove(); from.classList.remove('throw-from'); }, THROW.ms.fly + 100);
        if (go) {
          // It moves at once; the box flies to its target, and the row then shows in its new place, or has left Today.
          was.querySelector(`.throw-t[data-id="${go.id}"]`)?.classList.add('on');
          from.classList.remove('throw-from');
          app.said = thrownText(t.title, go);
          app.reschedule(t, {due: go.due, label: go.at === 'down' ? null : go.at === 'arc' ? go.date : go.name});
          app.flash([t.id], 'arrived');
          await Promise.all([fade(box, [{transform: 'none', opacity: 1}, {transform: `translate(${go.x - dx}px, ${go.y - dy}px) scale(.4)`, opacity: 0}], THROW.ms.fly),
            fade(was, [{opacity: 1}, {opacity: 0}], THROW.ms.fly)]);
        } else {
          // Kept where it is: the box goes back into its place.
          const r = from.getBoundingClientRect();
          await Promise.all([fade(box, [{transform: 'none', opacity: 1}, {transform: `translate(${r.left + r.width / 2 - lay.x - dx}px, ${r.top + r.height / 2 - lay.y - dy}px) scale(${r.width / BOX.w}, ${r.height / BOX.h})`, opacity: 0}], THROW.ms.fly),
            fade(was, [{opacity: 1}, {opacity: 0}], THROW.ms.fly)]);
        }
        was.remove(); from.classList.remove('throw-from');
      },
    };
  },
};
