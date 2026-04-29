// Theme toggle — auto / light / dark cycle, persisted in localStorage.
//
// Self-registering: importing this module wires the click handler on
// `#theme-btn` (if present) and applies the saved theme on load. Used by
// both the main app and the share viewer; both have a `<button id="theme-btn">`
// in their header but otherwise share no DOM/state, so this module
// deliberately depends on nothing besides the button + `<html>` element.
//
// Callers that need to react to theme changes (e.g. hljs CSS swap) can
// register via `onThemeChange(cb)`. Today hljs swap is CSS-only so the
// callback is unused, but keeping the hook avoids breaking existing
// wiring in app.ts.

const THEME_ICONS: Record<string, string> = {
  auto: "◑",
  light: "☀",
  dark: "☾",
};
const THEME_CYCLE = ["auto", "light", "dark"] as const;

function getTheme(): string {
  return localStorage.getItem("theme") ?? "auto";
}

const themeChangeCallbacks: Array<() => void> = [];

export function onThemeChange(cb: () => void): void {
  themeChangeCallbacks.push(cb);
}

function applyTheme(t: string): void {
  document.documentElement.setAttribute("data-theme", t);
  const btn = document.getElementById("theme-btn");
  if (btn) {
    btn.textContent = THEME_ICONS[t];
    btn.title = `Theme: ${t}`;
  }
  localStorage.setItem("theme", t);
  for (const cb of themeChangeCallbacks) cb();
}

const btn = document.getElementById("theme-btn");
if (btn) {
  btn.addEventListener("click", () => {
    const cur = getTheme();
    const next =
      THEME_CYCLE[
        (THEME_CYCLE.indexOf(cur as (typeof THEME_CYCLE)[number]) + 1) % 3
      ];
    applyTheme(next);
  });
}

applyTheme(getTheme());
