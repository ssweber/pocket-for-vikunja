/* A tick felt in the hand while a row is swiped or held: 'hold' as a hold picks it up, 'tick' at each snap, 'done'
   (stronger) at 100%. Android has navigator.vibrate. Safari on iPhone has none, but since iOS 18 toggling a switch,
   <input type="checkbox" switch>, gives a tick, also when its label is clicked from code. That's a trick, not something
   Apple offers for this: it may stop working, or not work while a finger is moving, and then there's simply no tick.
   The screen always shows one as well (the percentage pulses), so nothing depends on feeling it. */
const PATTERNS = {hold: 12, tick: 6, done: [14, 60, 24]};

function iosTick(){
  const label = document.createElement('label'), box = document.createElement('input');
  box.type = 'checkbox'; box.setAttribute('switch', ''); box.tabIndex = -1;
  label.setAttribute('aria-hidden', 'true'); label.style.display = 'none';
  label.append(box); document.head.append(label);
  label.click(); label.remove();
}

export function haptic(kind = 'tick'){
  try {
    if (navigator.vibrate) { navigator.vibrate(PATTERNS[kind]); return; }
    iosTick();
    if (kind === 'done') setTimeout(iosTick, 90);       // two close together: the stronger one
  } catch {}                                            // no tick, then: the screen shows one anyway
}
