// iOS/PWA can leave the textarea focused while the virtual keyboard is closed.
// When the user taps that stale-focused input, blur it so the next native tap
// can establish a fresh user-initiated focus.

import { dom } from "./state.ts";

const KEYBOARD_OPEN_DELTA_PX = 80;

let installed = false;

function getVisualViewport(): VisualViewport | null {
  return typeof window.visualViewport === "undefined"
    ? null
    : window.visualViewport;
}

function keyboardLikelyOpen(): boolean {
  const vv = getVisualViewport();
  if (!vv) return true;
  return (
    vv.offsetTop > 0 || window.innerHeight - vv.height > KEYBOARD_OPEN_DELTA_PX
  );
}

function isInputActivationTarget(target: EventTarget | null): boolean {
  return target === dom.input || target === dom.inputArea;
}

function blurStaleInputFocus(e: PointerEvent): void {
  if (e.pointerType !== "touch") return;
  if (!isInputActivationTarget(e.target)) return;
  if (document.activeElement !== dom.input) return;
  if (dom.input.disabled) return;
  if (keyboardLikelyOpen()) return;

  dom.input.blur();
}

export function installInputFocusRecovery(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerdown", blurStaleInputFocus, {
    capture: true,
  });
}
