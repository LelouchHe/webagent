// Shared test fixture builders.
//
// Goal: let tests construct valid production objects with only the fields
// that matter for the test, without weakening production types or scattering
// `as any` casts. All builders accept `Partial<T>` overrides and merge with
// sensible defaults.

import type { EventHandlerConfig } from "../src/event-handler.ts";
import type { AgentBridge } from "../src/bridge.ts";

export function makeEventHandlerConfig(
  overrides: Partial<EventHandlerConfig> = {},
): EventHandlerConfig {
  return {
    cancelTimeout: 10000,
    recentPathsLimit: 10,
    ...overrides,
  };
}

/**
 * Poll for a condition with a deadline. Returns as soon as `cond()` is truthy.
 * Throws if the deadline elapses. Catches the SAME bugs as a fixed sleep (and
 * more — a bug that never produces the expected state surfaces as a clear
 * timeout, not a silent flake).
 */
export async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs?: number; stepMs?: number; message?: string } = {},
): Promise<void> {
  const {
    timeoutMs = 1000,
    stepMs = 5,
    message = "waitFor condition not met",
  } = opts;
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error(`${message} (after ${timeoutMs}ms)`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Subset of AgentBridge required by routes/getBridge. Mirrors the Pick<>
 * used by RequestHandlerDeps.getBridge in routes.ts.
 */
export type MockBridge = Pick<
  AgentBridge,
  | "prompt"
  | "newSession"
  | "setConfigOption"
  | "loadSession"
  | "reloading"
  | "cancel"
  | "resolvePermission"
  | "denyPermission"
  | "restart"
>;

/** Typing helper: takes any shape that structurally matches MockBridge and
 * returns it typed as MockBridge. Prefer passing the concrete mock object
 * here so mock-specific extras (like `promptCalls`) survive via a single
 * `& typeof mock` intersection when needed. */
export function asMockBridge<T extends MockBridge>(mock: T): T {
  return mock;
}

/** Default no-op stubs for every method/property in MockBridge. Spread these
 * into a partial mock to satisfy the structural Pick<> requirement without
 * defining stubs at every test site. Keeps mock-specific extras intact. */
export function mockBridgeStubs(): MockBridge {
  return {
    reloading: false,
    newSession: async () => "",
    loadSession: async () => ({ sessionId: "", configOptions: [] }),
    setConfigOption: async () => [],
    prompt: async () => {},
    cancel: async () => {},
    resolvePermission: async () => {},
    denyPermission: async () => {},
    restart: async () => {},
  };
}
