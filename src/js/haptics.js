/* Haptic feedback: 'hold' when a hold picks a row up, 'tick' at each snap of a swipe, and 'done' (stronger) at 100% or
   when the user taps the tick. Android has navigator.vibrate. Safari on iPhone has no such call. Since iOS 18,
   though, toggling a switch (<input type="checkbox" switch>) makes the phone vibrate, even when code clicks its label.
   Apple does not offer this for haptics, so it may stop working, or not work while the user is dragging. Then the
   phone does not vibrate. The screen always shows the change as well, so nothing depends on the vibration. */
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
    if (kind === 'done') setTimeout(iosTick, 90);       // two ticks close together make the stronger one
  } catch {}                                            // no tick, then. The screen shows the change anyway.
}
