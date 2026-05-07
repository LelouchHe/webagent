/* Login page DOM wiring. Bundled separately from app.ts.
   Loads on /login when user has no token in localStorage. */

import {
  verifyAndStoreToken,
  consumeUrlHashToken,
  TOKEN_STORAGE_KEY,
} from "./login-core.ts";

// First-run banner may land on /login directly (e.g. user typed
// http://host:port/login#t=...). Consume hash before the
// already-logged-in check so the redirect happens correctly.
consumeUrlHashToken();

// If already logged in, skip the form entirely.
if (localStorage.getItem(TOKEN_STORAGE_KEY)) {
  location.replace("/");
}

const form = document.getElementById("login-form") as HTMLFormElement | null;
const input = document.getElementById("token-input") as HTMLInputElement | null;
const errorEl = document.getElementById("error") as HTMLDivElement | null;
const submitBtn = document.getElementById(
  "submit-btn",
) as HTMLButtonElement | null;

function setError(msg: string): void {
  if (!errorEl) return;
  errorEl.textContent = msg;
  errorEl.style.display = msg ? "block" : "none";
}

if (form && input && submitBtn) {
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    setError("");
    submitBtn.disabled = true;
    submitBtn.textContent = "Verifying…";
    void (async () => {
      try {
        const result = await verifyAndStoreToken(input.value);
        if (result.ok) {
          location.replace("/");
        } else {
          setError(result.error);
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign in";
      }
    })();
  });

  input.focus();
}
