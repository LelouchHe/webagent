// Input area action slots — drive #attach-btn (left) and #send-btn (right)
// based on current mode + busy state. Single source of truth so we never
// half-update one button and forget the other.
//
// Slots are by *position*; their content varies per mode:
//   default (idle)   left=attach        right=send
//   default (busy)   left=attach        right=cancel  (when no /command queued)
//   preview          left=discard       right=publish
//
// Handlers are registered at boot (see app.ts) to keep this module free of
// imports from input.ts / share/commands.ts — both of those import state,
// which would create a cycle if we imported them back here.

import { dom, state, setInputActionsRefresher } from "./state.ts";

export type InputAction = {
  label: string;
  title: string;
  /** Single CSS modifier added to the button: "cancel" | "publish" | "discard" */
  className?: string;
  disabled?: boolean;
  onClick: () => void;
};

type Handlers = {
  send: () => void;
  cancel: () => void;
  attach: () => void;
  publish: () => void;
  discard: () => void;
};

let handlers: Handlers = {
  send: () => {},
  cancel: () => {},
  attach: () => {},
  publish: () => {},
  discard: () => {},
};

export function registerInputHandlers(h: Handlers): void {
  handlers = h;
}

function inputHasCommand(): boolean {
  const t = dom.input.value.trim();
  return (
    t.startsWith("/") || t.startsWith("!") || t === "?" || t.startsWith("? ")
  );
}

export function resolveInputActions(): [InputAction, InputAction] {
  if (state.previewToken) {
    return [
      {
        label: "^D",
        title: "Discard preview (Ctrl+D)",
        className: "discard",
        onClick: () => {
          handlers.discard();
        },
      },
      {
        label: "^P",
        title: "Publish preview (Ctrl+P)",
        className: "publish",
        onClick: () => {
          handlers.publish();
        },
      },
    ];
  }
  const left: InputAction = {
    label: "^U",
    title: "Attach image (Ctrl+U)",
    onClick: () => {
      handlers.attach();
    },
  };
  // Right slot: re-evaluate cancel-vs-send at click time so a user who types
  // "/help" and clicks before the input-event repaint lands still sends. The
  // label/className still come from the current snapshot (paint-time).
  const rightOnClick = () => {
    if (state.busy && !inputHasCommand()) handlers.cancel();
    else handlers.send();
  };
  if (state.busy && !inputHasCommand()) {
    return [
      left,
      {
        label: "^C",
        title: "Cancel (Ctrl+C)",
        className: "cancel",
        onClick: rightOnClick,
      },
    ];
  }
  return [
    left,
    {
      label: "↵",
      title: "Send (Enter)",
      onClick: rightOnClick,
    },
  ];
}

const MODIFIER_CLASSES = ["cancel", "publish", "discard"];

function paint(btn: HTMLButtonElement, action: InputAction): void {
  btn.textContent = action.label;
  btn.title = action.title;
  btn.disabled = action.disabled ?? false;
  btn.onclick = action.onClick;
  for (const cls of MODIFIER_CLASSES) btn.classList.remove(cls);
  if (action.className) btn.classList.add(action.className);
}

/** Repaint both action buttons based on current mode + busy state. */
export function applyInputActions(): void {
  const [left, right] = resolveInputActions();
  paint(dom.attachBtn, left);
  paint(dom.sendBtn, right);
  // Preview mode treats the textarea as read-only — there's nothing meaningful
  // to type while reviewing a snapshot. Restored on mode exit.
  dom.input.disabled = Boolean(state.previewToken);
}

setInputActionsRefresher(applyInputActions);
