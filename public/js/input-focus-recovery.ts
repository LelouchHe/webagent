// iOS/PWA can leave the textarea focused while the virtual keyboard is closed.
// Recover only after a short tap: blurring on pointerdown cancels iPad Safari's
// native long-press Paste/Select menu, especially with floating/split keyboards
// that do not shrink visualViewport.

import { dom } from "./state.ts";

const KEYBOARD_OPEN_DELTA_PX = 80;
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVE_PX = 10;

let installed = false;
let pendingRecovery: PendingRecovery | null = null;

interface PendingRecovery {
  pointerId: number;
  startX: number;
  startY: number;
  startTs: number;
}

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
  return target === dom.input;
}

function getPointerId(e: PointerEvent): number {
  return typeof e.pointerId === "number" ? e.pointerId : 1;
}

function onPointerDown(e: PointerEvent): void {
  if (e.pointerType !== "touch") return;
  pendingRecovery = null;
  if (!isInputActivationTarget(e.target)) return;
  if (document.activeElement !== dom.input) return;
  if (dom.input.disabled) return;
  if (keyboardLikelyOpen()) return;

  pendingRecovery = {
    pointerId: getPointerId(e),
    startX: e.clientX,
    startY: e.clientY,
    startTs: e.timeStamp,
  };
}

function onPointerUp(e: PointerEvent): void {
  if (!pendingRecovery) return;
  if (getPointerId(e) !== pendingRecovery.pointerId) return;
  const pending = pendingRecovery;
  pendingRecovery = null;
  const durationMs = e.timeStamp - pending.startTs;
  const movePx = Math.hypot(
    e.clientX - pending.startX,
    e.clientY - pending.startY,
  );
  if (durationMs > TAP_MAX_DURATION_MS || movePx > TAP_MAX_MOVE_PX) return;
  if (document.activeElement !== dom.input || dom.input.disabled) return;
  if (keyboardLikelyOpen()) return;

  dom.input.blur();
}

function onPointerCancel(e: PointerEvent): void {
  if (!pendingRecovery) return;
  if (getPointerId(e) !== pendingRecovery.pointerId) return;
  pendingRecovery = null;
}

export function installInputFocusRecovery(): void {
  if (installed) return;
  installed = true;
  document.addEventListener("pointerdown", onPointerDown, {
    capture: true,
  });
  document.addEventListener("pointerup", onPointerUp, {
    capture: true,
  });
  document.addEventListener("pointercancel", onPointerCancel, {
    capture: true,
  });
}
