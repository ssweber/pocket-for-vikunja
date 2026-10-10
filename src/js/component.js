// The Alpine component, `pocket`, the helpers its markup uses by name, and its own directives. main.js registers them for Pocket's page;
// the specimen page (scripts/specimen/) makes a component of its own from them, with made-up tasks.
import {colorOf, fmtSize, grow, PRIOS, ZERO} from './util.js';
import {INSTALLED} from './api.js';
import {fromLocalInput, isSet, toLocalInput} from './dates.js';
import {RICH, sanitize} from './html.js';
import {addedText, durText} from './checklists.js';
import {runTitle} from './sync.js';
import {rowGestures, RUN_ROW, SHEET_ROW} from './lists.js';
import {quarterOn, QUARTERS} from './progress.js';
import core from './app/core.js';
import auth from './app/auth.js';
import views from './app/views.js';
import tasks from './app/tasks.js';
import actions from './app/actions.js';
import progress from './app/progress.js';
import quickadd from './app/quickadd.js';
import sending from './app/sending.js';
import checklists from './app/checklists.js';
import runs from './app/runs.js';
import claims from './app/claims.js';
import alerts from './app/alerts.js';
import sheet from './app/sheet.js';
import toast from './app/toast.js';
import outbox from './app/outbox.js';
import lines from './app/lines.js';
import leaving from './app/leaving.js';
import sharing from './app/sharing.js';
import cards from './app/cards.js';
import throwing from './app/throw.js';


// The markup's Alpine expressions use these by name, so they have to be globals (main.js makes them so).
export const globals = {addedText, colorOf, durText, fmtSize, fromLocalInput, grow, INSTALLED, isSet, PRIOS, quarterOn, QUARTERS, RICH, rowGestures, RUN_ROW, runTitle, sanitize, SHEET_ROW,
  toLocalInput, ZERO};

// What the markup asks of an element besides Alpine's own directives: x-style, x-grow and x-box.
export const directives = Alpine => {
  /* x-style="{'--pct': .5, paddingLeft: '18px'}": what :style does with an object, without the timer Alpine starts each
     time it works one out (to drop a style attribute left empty). A list's rows are worked out again on every change to
     it, so that was hundreds of timers at once: nothing to a browser, but seconds under the tests' clock, which runs
     timers one at a time. npm run lint keeps :style to strings. */
  Alpine.directive('style', (el, {expression}, {evaluateLater, effect}) => {
    const get = evaluateLater(expression);
    effect(() => get(o => { for (const [k, v] of Object.entries(o || {})) el.style.setProperty(k.startsWith('--') ? k : k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v); }));
  });

  /* A text box kept as tall as its text (grow, util.js): fitted as it's drawn, and again each time what `read` reads
     changes, on the next tick, once the box has its new text. */
  const fit = (el, effect, read) => effect(() => { read(); Alpine.nextTick(() => grow(el)); });
  // x-grow="sheet.commentDraft": that, for a box that isn't an add box (a comment, notes, a title), given its text.
  Alpine.directive('grow', (el, {expression}, {evaluate, effect}) => fit(el, effect, () => evaluate(expression)));

  /* x-box="'sub'": an add box, by its name (box(), app/quickadd.js). What every add box does is here, written once, and
     its markup says only what differs: quick add's box, a sheet's subtask box, and the boxes a template is written
     in (its name, a step being written, a step being changed).
     - It's as tall as its text (fit).
     - Where its cursor is, is kept as it's typed in, tapped, or a key moves it (box.caret): what @ and * suggest goes
       by the word the cursor is in.
     - The marks behind its words (.cap-marks, the element before it) scroll with it.
     - Focused, it says so (box.focus); left, only a moment later (150ms), and not if it has the focus back by then: a
       chip or a button tapped beside it hands it back. The box it was as it was left is told, not whichever box has
       its name by then (quick add's is the run's box on a run's screen; a step being changed gives way to another).
     - Enter sends it, or takes the suggestion on top (boxEnter); not while a word is being composed (isComposing: the
       Enter that picks from an input method's own list).
     - Starting an @username or a *label in it loads what there is to suggest: who can be assigned, the labels.
     - Once typing pauses (half a second), the @usernames in it are looked up (checkAccess): whether there's such a
       person, and whether they can see the project its lines go to, for the chips that warn before it's sent. Again
       only when they, or that project, change.
     x-box.lines: a box that takes a list (quick add's, a subtask box), where Shift+Enter breaks the line. In a box
     that holds one line (a template's name, a step), Shift+Enter is Enter.
     What else a box does is its own, beside this in its markup: a pasted list made rows, Escape, Alt+↑ and ↓. */
  Alpine.directive('box', (el, {expression, modifiers}, {evaluate, effect, cleanup}) => {
    const app = Alpine.$data(el), name = () => evaluate(expression), box = () => app.box(name());
    // It listens until Alpine takes it off the page, as an @event does: a box that goes while it has the focus is
    // blurred on its way out, with nothing left around it to ask which box it was.
    const on = (type, fn) => { el.addEventListener(type, fn); cleanup(() => el.removeEventListener(type, fn)); };
    // And each thing it keeps up to date is let go of then. (The `effect` Alpine hands a directive lets go of only the
    // last one made with it: one left running asks, at the next change, about a box that has nothing around it.)
    const watch = fn => { const made = effect(fn); cleanup(() => Alpine.release(made)); };
    fit(el, watch, () => box().text);
    for (const type of ['input', 'click', 'keyup']) on(type, () => { box().caret = el.selectionStart; });
    on('scroll', () => { el.previousElementSibling.scrollTop = el.scrollTop; });
    on('focus', () => { box().focus = true; });
    on('blur', () => { const b = box(); setTimeout(() => { b.focus = document.activeElement === el; }, 150); });
    on('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing || (e.shiftKey && modifiers.includes('lines'))) return;
      e.preventDefault();
      app.boxEnter(name());
    });
    watch(() => {
      const kind = app.boxToken(name())?.kind;
      if (kind === 'label') app.loadLabels().catch(() => {});
      if (kind === 'assignee') app.loadPeople().catch(() => {});
    });
    let asked = '', timer;
    watch(() => {
      const q = app.accessQuery(name());
      if (q === asked) return;
      asked = q;
      clearTimeout(timer);
      if (q) timer = setTimeout(() => app.checkAccess(name()), 500);
    });
    cleanup(() => clearTimeout(timer));
  });
};

// Alpine's component is one object: the data from core.js, with the methods of each part of the app. Getters are
// copied as getters (a spread, {...auth}, would read each one once and keep the value), so they still work out what
// they show each time they're read.
const parts = [auth, views, tasks, actions, progress, quickadd, sending, checklists, runs, claims, alerts, sheet, toast, outbox, lines, leaving, sharing, cards, throwing];
export const pocket = () => {
  const component = core();
  for (const part of parts) Object.defineProperties(component, Object.getOwnPropertyDescriptors(part));
  return component;
};
