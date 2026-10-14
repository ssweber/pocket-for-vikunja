// The Alpine component `pocket`, the helpers its markup calls by name, and Pocket's own directives. main.js registers
// them for Pocket's page. The specimen page (scripts/specimen/) builds its own component from them, with made-up tasks.
import {colorOf, fmtSize, grow, PRIOS, ZERO} from './util.js';
import {INSTALLED} from './api.js';
import {fromLocalInput, isSet, toLocalInput} from './dates.js';
import {RICH, sanitize} from './html.js';
import {addedText, commentShown, durText} from './checklists.js';
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
import asks from './app/asks.js';
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
export const globals = {addedText, colorOf, commentShown, durText, fmtSize, fromLocalInput, grow, INSTALLED, isSet, PRIOS, quarterOn, QUARTERS, RICH, rowGestures, RUN_ROW, runTitle, sanitize, SHEET_ROW,
  toLocalInput, ZERO};

// Pocket's own directives: x-style, x-grow and x-box.
export const directives = Alpine => {
  /* x-style="{'--pct': .5, paddingLeft: '18px'}" does what :style does with an object, without the timer Alpine sets
     each time it evaluates one (the timer removes an empty style attribute). Every change to a list re-evaluates all
     its rows, which started hundreds of timers at once. A browser handles that easily, but it took seconds under the
     tests' fake clock, which runs timers one at a time. `npm run lint` keeps :style to strings. */
  Alpine.directive('style', (el, {expression}, {evaluateLater, effect}) => {
    const get = evaluateLater(expression);
    effect(() => get(o => { for (const [k, v] of Object.entries(o || {})) el.style.setProperty(k.startsWith('--') ? k : k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), v); }));
  });

  // Keep a text box as tall as its text (grow, util.js). It runs when the box is drawn, and on the next tick after
  // anything `read` reads changes, once the box has its new text.
  const fit = (el, effect, read) => effect(() => { read(); Alpine.nextTick(() => grow(el)); });
  // x-grow="sheet.commentDraft" fits a box that isn't an add box (a comment, notes, a title) to its text.
  Alpine.directive('grow', (el, {expression}, {evaluate, effect}) => fit(el, effect, () => evaluate(expression)));

  /* x-box="'sub'" turns an element into an add box. The name is the one box() in app/quickadd.js looks up. This
     directive does everything that every add box does. The markup says only what differs between quick add's box, a
     sheet's subtask box and the boxes a template is typed in.

     - The box stays as tall as its text.
     - It records its caret index on each input, click and key (box.caret), because @, * and + suggest for the word at
       the caret.
     - The marks behind its text (.cap-marks, the element before it) scroll along with it.
     - On focus it sets box.focus. On blur it clears box.focus 150ms later, unless the box has focus again by then.
       Tapping a chip or a button beside the box hands focus back to it. The blur handler updates the box object it
       captured at blur, not whichever box has that name later, because names move. Quick add's box is the
       checklist's box on a checklist's screen.
     - Enter sends the text, or takes the top suggestion (boxEnter). While an input method is composing a word, Enter
       picks from the input method's own list instead.
     - Typing @ or * loads the people or labels it suggests. The projects that + suggests are already loaded.
     - Half a second after typing pauses, it checks the @usernames in the text (checkAccess). The check finds out
       whether each person exists and can see the project the lines go to, so chips can warn before sending. It
       checks again only when the names or the project change.

     x-box.lines marks a box that takes a list (quick add's, a subtask box). In it, Shift+Enter starts a new line. In a
     one-line box (a template's name, a step), Shift+Enter acts as Enter.

     Alt+↑ and Alt+↓ move a list's add box through its rows. Alt+← and Alt+→ change a project's box level. */
  Alpine.directive('box', (el, {expression, modifiers}, {evaluate, effect, cleanup}) => {
    const app = Alpine.$data(el), name = () => evaluate(expression), box = () => app.box(name());
    // Listeners are removed when Alpine removes the element, as with @event. A box removed while focused is blurred on
    // its way out, when no component is left to ask which box it was.
    const on = (type, fn) => { el.addEventListener(type, fn); cleanup(() => el.removeEventListener(type, fn)); };
    // Effects are released then too. The `effect` Alpine hands to a directive releases only the last effect made with
    // it. A leftover effect would ask about a box at the next change, when no component is left to answer.
    const watch = fn => { const made = effect(fn); cleanup(() => Alpine.release(made)); };
    fit(el, watch, () => box().text);
    for (const type of ['input', 'click', 'keyup']) on(type, () => { box().caret = el.selectionStart; });
    on('scroll', () => { el.previousElementSibling.scrollTop = el.scrollTop; });
    on('focus', () => { box().focus = true; });
    on('blur', () => { const b = box(); setTimeout(() => { b.focus = document.activeElement === el; }, 150); });
    on('keydown', e => {
      if (modifiers.includes('lines') && e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
        if (['cap', 'under'].includes(name())) { e.preventDefault(); app.boxLevel(e.key === 'ArrowLeft'); }
        return;
      }
      if (modifiers.includes('lines') && e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
        if (app.boxMove(name(), e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
        return;
      }
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

// The component is core.js's data plus the methods of each part. Getters are copied as getters. A spread ({...auth})
// would call each getter once and keep its value.
const parts = [auth, views, tasks, actions, progress, quickadd, sending, checklists, runs, asks, claims, alerts, sheet, toast, outbox, lines, leaving, sharing, cards, throwing];
export const pocket = () => {
  const component = core();
  for (const part of parts) Object.defineProperties(component, Object.getOwnPropertyDescriptors(part));
  return component;
};
