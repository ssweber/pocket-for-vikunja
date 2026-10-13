// The Alpine component `pocket`, the helpers its markup calls by name, and Pocket's own directives. main.js registers
// them for Pocket's page. The specimen page (scripts/specimen/) builds its own component from them, with made-up tasks.
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


// The markup's Alpine expressions use these by name, so main.js makes them globals.
export const globals = {addedText, colorOf, durText, fmtSize, fromLocalInput, grow, INSTALLED, isSet, PRIOS, quarterOn, QUARTERS, RICH, rowGestures, RUN_ROW, runTitle, sanitize, SHEET_ROW,
  toLocalInput, ZERO};

// Pocket's own directives: x-style, x-grow and x-box.
export const directives = Alpine => {
  /* x-style="{'--pct': .5, paddingLeft: '18px'}": what :style does with an object, minus the timer Alpine sets each
     time it evaluates one, to drop an empty style attribute. Every change to a list re-evaluates all its rows, so that
     was hundreds of timers at once: nothing to a browser, but seconds under the tests' fake clock, which runs timers
     one at a time. npm run lint keeps :style to strings. */
  Alpine.directive('style', (el, {expression}, {evaluateLater, effect}) => {
    const get = evaluateLater(expression);
    effect(() => get(o => { for (const [k, v] of Object.entries(o || {})) el.style.setProperty(k.startsWith('--') ? k : k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v); }));
  });

  // Keep a text box as tall as its text (grow, util.js): when drawn, and on the tick after whatever `read` reads
  // changes, once the box has its new text.
  const fit = (el, effect, read) => effect(() => { read(); Alpine.nextTick(() => grow(el)); });
  // x-grow="sheet.commentDraft": fit a box that isn't an add box (a comment, notes, a title) to the text given.
  Alpine.directive('grow', (el, {expression}, {evaluate, effect}) => fit(el, effect, () => evaluate(expression)));

  /* x-box="'sub'": an add box, named for box() in app/quickadd.js. Everything every add box does is here, once. The
     markup says only what differs between quick add's box, a sheet's subtask box and the boxes a template is typed in.
     - It stays as tall as its text.
     - Its caret index is recorded on each input, click and key (box.caret), since @ and * suggest for the word the
       caret is in.
     - The marks behind its words (.cap-marks, the element before it) scroll with it.
     - On focus it sets box.focus. On blur it clears box.focus 150ms later, unless it has the focus back by then: a chip
       or a button tapped beside it hands focus back. The box object captured at blur is updated, not whichever box has
       the name by then, as names move: quick add's box is the run's box on a run's screen.
     - Enter sends it, or takes the top suggestion (boxEnter), except while an input method is composing a word, when
       Enter picks from the input method's own list.
     - Typing @ or * loads what there is to suggest: people who can be assigned, or labels.
     - Half a second after typing pauses, the @usernames in it are checked (checkAccess): whether each person exists and
       can see the project the lines go to, for the chips that warn before sending. Checked again only when the names
       or the project change.
     x-box.lines marks a box that takes a list (quick add's, a subtask box), where Shift+Enter breaks the line. In a
     one-line box (a template's name, a step), Shift+Enter is Enter.
     Anything else a box does (a pasted list becoming rows, Escape, Alt+↑ and ↓) is in its own markup. */
  Alpine.directive('box', (el, {expression, modifiers}, {evaluate, effect, cleanup}) => {
    const app = Alpine.$data(el), name = () => evaluate(expression), box = () => app.box(name());
    // Listeners are removed when Alpine removes the element, as with @event. A box removed while focused is blurred on
    // its way out, with no component around it to ask which box it was.
    const on = (type, fn) => { el.addEventListener(type, fn); cleanup(() => el.removeEventListener(type, fn)); };
    // Effects are released then too. The `effect` Alpine hands a directive releases only the last one made with it,
    // and a leftover effect would ask about a box with no component around it at the next change.
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

// The component is one object: core.js's data plus each part's methods. Getters are copied as getters, since a spread
// ({...auth}) would read each one once and keep the value.
const parts = [auth, views, tasks, actions, progress, quickadd, sending, checklists, runs, claims, alerts, sheet, toast, outbox, lines, leaving, sharing, cards, throwing];
export const pocket = () => {
  const component = core();
  for (const part of parts) Object.defineProperties(component, Object.getOwnPropertyDescriptors(part));
  return component;
};
