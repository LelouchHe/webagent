export interface SyncRequestTransport<TRequest = unknown, TResponse = unknown> {
  send(
    opId: string | null,
    request: TRequest,
    signal: AbortSignal,
  ): Promise<{ status: number; body: TResponse }>;
}

export interface SyncTimer {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SyncRequestResult<TResponse = unknown> =
  | { kind: "success"; status: number; body: TResponse }
  | { kind: "rejected"; status: number; body: TResponse }
  | { kind: "unknown"; error: unknown };

async function sendSyncRequestOnce<
  TRequest = unknown,
  TResponse = unknown,
>(input: {
  opId: string | null;
  request: TRequest;
  timeoutMs: number;
  transport: SyncRequestTransport<TRequest, TResponse>;
  timer: SyncTimer;
}): Promise<SyncRequestResult<TResponse>> {
  const abort = new AbortController();
  let timeoutCallback:
    ((result: SyncRequestResult<TResponse>) => void) | undefined;
  const timedOut = new Promise<SyncRequestResult<TResponse>>((resolve) => {
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
      input.transport.send(input.opId, input.request, abort.signal),
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

export async function sendSyncRequest<
  TRequest = unknown,
  TResponse = unknown,
>(input: {
  opId: string | null;
  request: TRequest;
  timeoutMs: number;
  transport: SyncRequestTransport<TRequest, TResponse>;
  timer: SyncTimer;
  retries?: number;
}): Promise<SyncRequestResult<TResponse>> {
  const maxRetries =
    input.opId === null ? 0 : Math.max(0, Math.floor(input.retries ?? 0));
  let result = await sendSyncRequestOnce(input);
  let lastUnknown: { kind: "unknown"; error: unknown } | null =
    result.kind === "unknown" ? result : null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    if (result.kind !== "unknown") return result;
    result = await sendSyncRequestOnce(input);
    if (result.kind === "unknown") {
      lastUnknown = result;
    } else if (result.kind === "rejected" && lastUnknown !== null) {
      // Once an earlier attempt had an unknown outcome, a later 4xx cannot
      // prove the original request did not commit.
      return lastUnknown;
    }
  }
  return result;
}
