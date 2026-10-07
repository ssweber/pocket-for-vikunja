// The message at the bottom, with its Undo.

let toastTimer;
export const UNDO_MS = 5000;                            // how long a message with an Undo shows

export default {
  /* A message, with up to two actions: `action` (Undo, when there is one) and `more` (Open, say). It replaces the message
     before it: one Undo for different things (an add and a tick, say) could undo more than meant. (A task ticked off a
     list, or deleted, has its Undo in its row's place instead: lines.js.) An action's `gone` is called when its message
     goes without it being tapped. */
  notify(msg, action, more){
    if (this.toast.show) this.toastGone(this.toast);
    const ms = action ? UNDO_MS : 2600;
    this.toast = {show: true, msg, action: action || null, more: more || null, until: Date.now() + ms};
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => this.toast.show = false, ms);
  },
  // A message of Pocket's own, such as a task now due: it waits for an Undo still showing to go, so that isn't lost.
  notifyAfterUndo(msg){
    const wait = this.toast.show && this.toast.action ? this.toast.until - Date.now() : 0;
    if (wait > 0) setTimeout(() => this.notifyAfterUndo(msg), wait + 100); else this.notify(msg);
  },
  runToastAction(second){ const a = second ? this.toast.more : this.toast.action; if (a && !second) a.gone = null; this.toast.show = false; a?.fn(); },
  toastGone(t){ const go = t.action?.gone; if (go) { t.action.gone = null; go(); } },
};
