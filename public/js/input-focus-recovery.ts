// iOS/PWA can leave the textarea focused while the virtual keyboard is closed.
// A short tap recovers fully closed stale focus; a same-position double tap
// explicitly recovers a half-open keyplane that still shrinks visualViewport.
// Waiting for pointerup preserves iPad Safari's long-press Paste/Select menu.

import { dom } from "./state.ts";

const KEYBOARD_OPEN_DELTA_PX = 80;
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVE_PX = 10;
const DOUBLE_TAP_MAX_GAP_MS = 350;
const DOUBLE_TAP_MAX_MOVE_PX = 24;

let installed = false;
let pendingRecovery: PendingRecovery | null = null;
let previousShortTap: CompletedTap | null = null;

interface PendingRecovery {
  pointerId: number;
  startX: number;
  startY: number;
  startTs: number;
  keyboardLikelyOpenAtStart: boolean;
}

interface CompletedTap {
  endX: number;
  endY: number;
  endTs: number;
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
  if (
    !isInputActivationTarget(e.target) ||
    document.activeElement !== dom.input ||
    dom.input.disabled
  ) {
    previousShortTap = null;
    return;
  }

  pendingRecovery = {
    pointerId: getPointerId(e),
    startX: e.clientX,
    startY: e.clientY,
    startTs: e.timeStamp,
    keyboardLikelyOpenAtStart: keyboardLikelyOpen(),
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
  if (durationMs > TAP_MAX_DURATION_MS || movePx > TAP_MAX_MOVE_PX) {
    previousShortTap = null;
    return;
  }
  if (document.activeElement !== dom.input || dom.input.disabled) {
    previousShortTap = null;
    return;
  }

  if (!pending.keyboardLikelyOpenAtStart) {
    previousShortTap = null;
    dom.input.blur();
    return;
  }

  const gapMs = previousShortTap
    ? pending.startTs - previousShortTap.endTs
    : Number.POSITIVE_INFINITY;
  const betweenTapMovePx = previousShortTap
    ? Math.hypot(
        e.clientX - previousShortTap.endX,
        e.clientY - previousShortTap.endY,
      )
    : Number.POSITIVE_INFINITY;
  if (
    gapMs >= 0 &&
    gapMs <= DOUBLE_TAP_MAX_GAP_MS &&
    betweenTapMovePx <= DOUBLE_TAP_MAX_MOVE_PX
  ) {
    previousShortTap = null;
    dom.input.blur();
    return;
  }

  previousShortTap = {
    endX: e.clientX,
    endY: e.clientY,
    endTs: e.timeStamp,
  };
}

function onPointerCancel(e: PointerEvent): void {
  if (!pendingRecovery) return;
  if (getPointerId(e) !== pendingRecovery.pointerId) return;
  pendingRecovery = null;
  previousShortTap = null;
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
