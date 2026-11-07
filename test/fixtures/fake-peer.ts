/**
 * Spike-only adapter for ACP SDK 2.x client peers.
 *
 * SDK 2.0 removed `ClientSideConnection`, so a peer is a `ClientContext` with
 * exactly two outbound operations: `request(method, params)` and
 * `notify(method, params)`. The unit tests used to hand-roll a fake peer with
 * one property per ACP method (`{ prompt, newSession, cancel, ... }`), which no
 * longer matches any real object.
 *
 * This helper keeps those fakes readable while dispatching through the single
 * 2.x entry points, and keeps per-method reassignment working
 * (`peer.setSessionConfigOption = ...`) so a test can replace one call without
 * rebuilding the whole peer.
 */

const REQUEST_METHODS = {
  initialize: "initialize",
  newSession: "session/new",
  loadSession: "session/load",
  resumeSession: "session/resume",
  setSessionConfigOption: "session/set_config_option",
  deleteSession: "session/delete",
  closeSession: "session/close",
  prompt: "session/prompt",
} as const;

const NOTIFY_METHODS = {
  cancel: "session/cancel",
} as const;

type MethodName = keyof typeof REQUEST_METHODS | keyof typeof NOTIFY_METHODS;

export type FakePeerHandlers = Partial<
  Record<MethodName, (params: any) => any>
>;

export function fakePeer(handlers: FakePeerHandlers = {}) {
  const impl: Record<string, ((params: any) => any) | undefined> = {
    ...handlers,
  };
  const peer = {
    // Deliberately not `async`: the bridge distinguishes "the agent never got
    // the prompt" (a synchronous throw) from "the turn failed in flight", and
    // an `async` wrapper would turn every throw into a rejection.
    request: (method: string, params: unknown) => {
      const name = findByMethod(REQUEST_METHODS, method);
      const fn = impl[name];
      if (!fn) throw new Error(`fakePeer: unexpected request ${method}`);
      return fn(params);
    },
    notify: (method: string, params: unknown) => {
      const name = findByMethod(NOTIFY_METHODS, method);
      const fn = impl[name];
      if (!fn) throw new Error(`fakePeer: unexpected notify ${method}`);
      return fn(params);
    },
  } as Record<string, unknown>;
  for (const name of [
    ...Object.keys(REQUEST_METHODS),
    ...Object.keys(NOTIFY_METHODS),
  ]) {
    Object.defineProperty(peer, name, {
      get: () => impl[name],
      set: (fn: ((params: any) => any) | undefined) => {
        impl[name] = fn;
      },
      enumerable: true,
      configurable: true,
    });
  }
  return peer;
}

function findByMethod(map: Record<string, string>, method: string): string {
  for (const [name, candidate] of Object.entries(map)) {
    if (candidate === method) return name;
  }
  throw new Error(`fakePeer: unexpected method ${method}`);
}
