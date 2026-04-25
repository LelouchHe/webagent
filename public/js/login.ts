/* Login page DOM wiring. Bundled separately from app.ts.
   Loads on /login when user has no token in localStorage. */

import { verifyAndStoreToken, TOKEN_STORAGE_KEY } from "./login-core.ts";

// If already logged in, skip the form entirely.
if (localStorage.getItem(TOKEN_STORAGE_KEY)) {
  location.replace("/");
}

const form = document.getElementById("login-form") as HTMLFormElement | null;
const input = document.getElementById("token-input") as HTMLTextAreaElement | null;
const errorEl = document.getElementById("error") as HTMLDivElement | null;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement | null;

function setError(msg: string): void {
  if (!errorEl) return;
  errorEl.textContent = msg;
  errorEl.style.display = msg ? "block" : "none";
}

if (form && input && submitBtn) {
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setError("");
    submitBtn.disabled = true;
    submitBtn.textContent = "Verifying…";
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
  });

  input.focus();
}
