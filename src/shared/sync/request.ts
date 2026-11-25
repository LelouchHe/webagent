export interface SyncRequestTransport {
  send(
    operationId: string,
    request: unknown,
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
}

export interface SyncTimer {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SyncRequestResult =
  | { kind: "success"; status: number; body: unknown }
  | { kind: "rejected"; status: number; body: unknown }
  | { kind: "unknown"; error: unknown };

export async function sendSyncRequest(input: {
  operationId: string;
  request: unknown;
  timeoutMs: number;
  transport: SyncRequestTransport;
  timer: SyncTimer;
}): Promise<SyncRequestResult> {
  const abort = new AbortController();
  let timeoutCallback: ((result: SyncRequestResult) => void) | undefined;
  const timedOut = new Promise<SyncRequestResult>((resolve) => {
    timeoutCallback = resolve;
  });
  const timeout = input.timer.setTimeout(() => {
    abort.abort();
    timeoutCallback?.({
      kind: "unknown",
      error: new Error("sync_request_timeout"),
    });
  }, input.timeoutMs);
  try {
    const response = await Promise.race([
      input.transport.send(input.operationId, input.request, abort.signal),
      timedOut,
    ]);
    if ("kind" in response) return response;
    const statusClass = Math.floor(response.status / 100);
    if (statusClass === 4) {
      return { kind: "rejected", ...response };
    }
    if (statusClass === 2) {
      return { kind: "success", ...response };
    }
    return {
      kind: "unknown",
      error: new Error(`sync_request_status_${response.status}`),
    };
  } catch (error) {
    return { kind: "unknown", error };
  } finally {
    input.timer.clearTimeout(timeout);
  }
}
