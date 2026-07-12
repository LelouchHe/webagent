// Boot entry point — imports all modules and starts the app

// Pre-bootstrap: bounce to /login if no token. Done before any other module
// runs so we don't waste time spinning up the app for an unauthenticated user.
import { TOKEN_STORAGE_KEY } from "./login-core.ts";
if (!localStorage.getItem(TOKEN_STORAGE_KEY)) {
  location.replace("/login");
  // Throw to halt the rest of the bundle in case replace() is async.
  throw new Error("redirecting to /login");
}

import { installAuthFetch } from "./auth-fetch.ts";
installAuthFetch();

import "./render.ts"; // theme, click-to-collapse listeners
import "./commands.ts"; // slash menu listeners
import "./attachments.ts"; // attach/paste listeners
import "./lightbox.ts"; // click-to-enlarge image viewer
import "./input.ts"; // keyboard/send listeners
import { connect } from "./connection.ts";
import { state, dom } from "./state.ts";
import { addSystem, onThemeChange } from "./render.ts";
import { installInputFocusRecovery } from "./input-focus-recovery.ts";
import {
  handleCopyClick,
  onThemeChange as hljsThemeChange,
} from "./highlight.ts";
import { setLogRenderer } from "./log.ts";
import {
  navigateFromNotification,
  type NotificationTarget,
} from "./session-navigation.ts";

// Inline debug log — when level != "off", log records render as
// system-msg rows in the conversation flow via addSystem.
setLogRenderer(addSystem);
installInputFocusRecovery();

// Code block copy button (event delegation)
dom.messages.addEventListener("click", handleCopyClick);
// Swap hljs theme CSS when app theme changes
onThemeChange(hljsThemeChange);

connect();

// Fetch version info (non-blocking)
void fetch("/api/v1/version")
  .then((r) => r.json())
  .then((v: Record<string, unknown>) => {
    if (typeof v.server === "string") state.serverVersion = v.server;
    const agent = v.agent as Record<string, string> | null;
    if (agent) {
      state.agentName = typeof agent.name === "string" ? agent.name : null;
      state.agentVersion =
        typeof agent.version === "string" ? agent.version : null;
    }
  })
  .catch(() => {});

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js");

  // Handle push notification click → navigate to session
  navigator.serviceWorker.addEventListener("message", (e) => {
    const data = (e.data ?? {}) as NotificationTarget & { type?: string };
    if (data.type !== "navigate") return;
    void navigateFromNotification(data).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      addSystem(`err: notification navigation failed (${message})`);
    });
  });
}
