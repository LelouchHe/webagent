import { TOKEN_STORAGE_KEY } from "./login-core.ts";

export const THEME_STORAGE_KEY = "theme";
export const LOG_LEVEL_STORAGE_KEY = "wa_log_level";
export const NOTIFY_TIP_KEY = "webagent_notify_tip_shown";
export const NOTIFY_TIP_DENIED_KEY = "webagent_notify_tip_denied_shown";

const EXACT_RESET_KEYS = new Set([
  THEME_STORAGE_KEY,
  LOG_LEVEL_STORAGE_KEY,
  NOTIFY_TIP_KEY,
  NOTIFY_TIP_DENIED_KEY,
]);

export interface LocalResetResult {
  localStorageKeys: string[];
  serviceWorkers: number;
  caches: string[];
  errors: string[];
}

export function isResettableLocalStorageKey(key: string): boolean {
  if (key === TOKEN_STORAGE_KEY) return false;
  if (EXACT_RESET_KEYS.has(key)) return true;
  return key.startsWith("wa_") || key.startsWith("webagent_");
}

export function clearResettableLocalStorage(): string[] {
  const removed: string[] = [];
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !isResettableLocalStorageKey(key)) continue;
    localStorage.removeItem(key);
    removed.push(key);
  }
  return removed;
}

async function unregisterServiceWorkers(): Promise<number> {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof navigator.serviceWorker.getRegistrations !== "function"
  ) {
    return 0;
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((reg) => reg.unregister()));
  return registrations.length;
}

async function clearCaches(): Promise<string[]> {
  if (typeof caches === "undefined") return [];
  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));
  return names;
}

export async function resetLocalFrontendState(): Promise<LocalResetResult> {
  const result: LocalResetResult = {
    localStorageKeys: [],
    serviceWorkers: 0,
    caches: [],
    errors: [],
  };

  try {
    result.localStorageKeys = clearResettableLocalStorage();
  } catch (err) {
    result.errors.push(`localStorage: ${formatError(err)}`);
  }

  try {
    result.serviceWorkers = await unregisterServiceWorkers();
  } catch (err) {
    result.errors.push(`serviceWorker: ${formatError(err)}`);
  }

  try {
    result.caches = await clearCaches();
  } catch (err) {
    result.errors.push(`cache: ${formatError(err)}`);
  }

  return result;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
