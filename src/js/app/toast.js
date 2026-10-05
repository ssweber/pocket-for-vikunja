// The message at the bottom, with its Undo.

let toastTimer;

export default {
  /* A message, with up to two actions: `action` (Undo, when there is one) and `more` (Open, say). Ticks in a row add
     up: a tick's Undo that comes while another tick's is still showing makes one message, "3 done", whose Undo opens
     them all again, the last first. Anything else replaces the message before it: one Undo for different things (an
     add and a tick, say) could undo more than meant. */
  notify(msg, action, more){
    const old = this.toast;
    if (action?.done && old.show && old.action?.done) {
      const all = [...(old.action.all || [old.action]), action], n = all.length;
      const fn = async () => { for (const a of [...all].reverse()) await a.fn(); };
      action = {label: 'Undo', done: true, all, fn};
      msg = `${n} done`; more = null;
    }
    const ms = action ? 5000 : 2600;
    this.toast = {show: true, msg, action: action || null, more: more || null, until: Date.now() + ms};
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => this.toast.show = false, ms);
  },
  runToastAction(second){ const a = second ? this.toast.more : this.toast.action; this.toast.show = false; a?.fn(); },
};
