/* The message at the bottom of the screen. It is for messages that have no row or screen area to appear in: a
   countdown at zero, a screen that couldn't load, a project deleted after its sheet has closed. lines.js shows other
   messages where the action happened. */

let toastTimer;
export const UNDO_MS = 5000;                            // how long a message with an Undo shows

export default {
  /* Show a message with up to two actions: `action` (Undo, when there is one) and `more` (for example Open). It
     replaces the message before it, because one Undo for two different things could undo more than meant. An action's
     `gone` is called when its message disappears without being tapped. */
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
