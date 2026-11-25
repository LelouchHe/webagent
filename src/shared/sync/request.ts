export interface SyncRequestTransport<TRequest = unknown, TResponse = unknown> {
  send(
    operationId: string,
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

export async function sendSyncRequest<
  TRequest = unknown,
  TResponse = unknown,
>(input: {
  operationId: string;
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
