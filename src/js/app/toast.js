/* The message at the bottom of the screen, for what has no place of its own (lines.js says the rest where it happened):
   a countdown at zero, a screen that couldn't load, what's done after its sheet has closed (a project deleted). */

let toastTimer;
export const UNDO_MS = 5000;                            // how long a message with an Undo shows

export default {
  /* A message, with up to two actions: `action` (Undo, when there is one) and `more` (Open, say). It replaces the message
     before it: one Undo for different things could undo more than meant. An action's `gone` is called when its message
     goes without it being tapped. */
  notify(msg, action, more){
    if (this.toast.show) this.toastGone(this.toast);
    const ms = action ? UNDO_MS : 2600;
    this.toast = {show: true, msg, action: action || null, more: more || null, until: Date.now() + ms};
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => this.toast.show = false, ms);
  },
  runToastAction(second){ const a = second ? this.toast.more : this.toast.action; if (a && !second) a.gone = null; this.toast.show = false; a?.fn(); },
  toastGone(t){ const go = t.action?.gone; if (go) { t.action.gone = null; go(); } },
};
