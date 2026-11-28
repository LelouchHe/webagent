import { HTTP_STATUS } from "../../http-status.ts";

export interface SyncRequestResponse<TResponse = unknown> {
  status: number;
  body: TResponse;
  /**
   * True when a response body failed to read or parse. Status classification
   * still runs first (so 4xx remains `rejected` on attempt 0 except `409
   * op_aborted`), while a non-204 2xx with a malformed body is classified as
   * `unknown` rather than usable `success`.
   */
  bodyMalformed?: boolean;
}

export interface SyncRequestTransport<TRequest = unknown, TResponse = unknown> {
  send(
    opId: string | null,
    request: TRequest,
    signal: AbortSignal,
  ): Promise<SyncRequestResponse<TResponse>>;
}

export interface SyncTimer {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SyncRequestUnknownResult<TResponse = unknown> = {
  kind: "unknown";
  error: unknown;
  status?: number;
  body?: TResponse;
};

export type SyncRequestResult<TResponse = unknown> =
  | { kind: "success"; status: number; body: TResponse }
  | { kind: "rejected"; status: number; body: TResponse }
  | SyncRequestUnknownResult<TResponse>
  | { kind: "skipped" };

export type SyncRequestBackoff =
  readonly number[] | ((attempt: number) => number);

export const SYNC_REQUEST_DEFAULTS = {
  write: {
    timeoutMs: 10_000,
    retries: 2,
    backoffMs: [300, 800] as readonly number[],
  },
  slowWrite: {
    timeoutMs: 30_000,
    retries: 1,
    backoffMs: [500] as readonly number[],
  },
  create: {
    timeoutMs: 30_000,
    retries: 0,
  },
  read: {
    timeoutMs: 10_000,
    retries: 0,
  },
} as const;

type AttemptOutcome<TResponse> =
  | { kind: "success"; status: number; body: TResponse }
  | { kind: "rejected"; status: number; body: TResponse }
  | {
      kind: "unknown";
      result: SyncRequestUnknownResult<TResponse>;
      terminal: boolean;
    };

function isOpAbortedResponse(status: number, body: unknown): boolean {
  return (
    status === HTTP_STATUS.CONFLICT &&
    body !== null &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === "op_aborted"
  );
}

function resolveBackoffMs(
  backoffMs: SyncRequestBackoff | undefined,
  attempt: number,
): number {
  if (backoffMs === undefined) return 0;
  if (typeof backoffMs === "function") {
    return Math.max(0, backoffMs(attempt));
  }
  if (backoffMs.length === 0) return 0;
  const index = Math.min(attempt - 1, backoffMs.length - 1);
  return Math.max(0, backoffMs[index] ?? 0);
}

function waitBackoff(
  delayMs: number,
  timer: SyncTimer,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      timer.clearTimeout(handle);
      resolve(false);
    };
    const handle = timer.setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function mergeUnknownDiagnostic<TResponse>(
  previous: SyncRequestUnknownResult<TResponse> | null,
  current: SyncRequestUnknownResult<TResponse>,
): SyncRequestUnknownResult<TResponse> {
  if (current.status === undefined && previous?.status !== undefined) {
    return {
      kind: "unknown",
      error: current.error,
      status: previous.status,
      body: previous.body,
    };
  }
  return current;
}

async function sendSyncRequestOnce<
  TRequest = unknown,
  TResponse = unknown,
>(input: {
  opId: string | null;
  request: TRequest;
  timeoutMs: number;
  transport: SyncRequestTransport<TRequest, TResponse>;
  timer: SyncTimer;
  signal?: AbortSignal;
}): Promise<AttemptOutcome<TResponse>> {
  if (input.signal?.aborted) {
    return {
      kind: "unknown",
      terminal: true,
      result: {
        kind: "unknown",
        error: input.signal.reason ?? new Error("sync_request_aborted"),
      },
    };
  }

  const abort = new AbortController();
  let finishRace: ((outcome: AttemptOutcome<TResponse>) => void) | undefined;
  const raceStop = new Promise<AttemptOutcome<TResponse>>((resolve) => {
    finishRace = resolve;
  });

  const onExternalAbort = () => {
    abort.abort(input.signal?.reason);
    finishRace?.({
      kind: "unknown",
      terminal: true,
      result: {
        kind: "unknown",
        error: input.signal?.reason ?? new Error("sync_request_aborted"),
      },
    });
  };
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeout = input.timer.setTimeout(() => {
    abort.abort(new Error("sync_request_timeout"));
    finishRace?.({
      kind: "unknown",
      terminal: false,
      result: {
        kind: "unknown",
        error: new Error("sync_request_timeout"),
      },
    });
  }, input.timeoutMs);

  try {
    const response = await Promise.race([
      input.transport.send(input.opId, input.request, abort.signal),
      raceStop,
    ]);
    if ("kind" in response) return response;
    const statusClass = Math.floor(response.status / 100);
    if (statusClass === 4) {
      if (isOpAbortedResponse(response.status, response.body)) {
        return {
          kind: "unknown",
          terminal: true,
          result: {
            kind: "unknown",
            error: new Error("sync_request_op_aborted"),
            status: response.status,
            body: response.body,
          },
        };
      }
      return {
        kind: "rejected",
        status: response.status,
        body: response.body,
      };
    }
    if (statusClass === 2) {
      if (
        response.bodyMalformed === true &&
        response.status !== HTTP_STATUS.NO_CONTENT
      ) {
        return {
          kind: "unknown",
          terminal: false,
          result: {
            kind: "unknown",
            error: new Error("sync_request_malformed_body"),
            status: response.status,
            body: response.body,
          },
        };
      }
      return {
        kind: "success",
        status: response.status,
        body: response.body,
      };
    }
    return {
      kind: "unknown",
      terminal: false,
      result: {
        kind: "unknown",
        error: new Error(`sync_request_status_${response.status}`),
        status: response.status,
        body: response.body,
      },
    };
  } catch (error) {
    return {
      kind: "unknown",
      terminal: Boolean(input.signal?.aborted),
      result: { kind: "unknown", error },
    };
  } finally {
    input.timer.clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export interface SendSyncRequestInput<TRequest = unknown, TResponse = unknown> {
  opId: string | null;
  request: TRequest;
  timeoutMs: number;
  transport: SyncRequestTransport<TRequest, TResponse>;
  timer: SyncTimer;
  retries?: number;
  backoffMs?: SyncRequestBackoff;
  beforeSend?: (attempt: number) => boolean | void;
  signal?: AbortSignal;
}

export async function sendSyncRequest<TRequest = unknown, TResponse = unknown>(
  input: SendSyncRequestInput<TRequest, TResponse>,
): Promise<SyncRequestResult<TResponse>> {
  const maxRetries =
    input.opId === null ? 0 : Math.max(0, Math.floor(input.retries ?? 0));

  if (input.beforeSend) {
    // Attempt 0: false -> skipped; throw -> propagate to caller.
    if (input.beforeSend(0) === false) {
      return { kind: "skipped" };
    }
  }

  let outcome = await sendSyncRequestOnce(input);
  if (outcome.kind === "success" || outcome.kind === "rejected") {
    return outcome;
  }
  let lastUnknown = outcome.result;
  if (outcome.terminal) {
    return lastUnknown;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const delay = resolveBackoffMs(input.backoffMs, attempt);
    const proceeded = await waitBackoff(delay, input.timer, input.signal);
    if (!proceeded) {
      return lastUnknown;
    }

    if (input.beforeSend) {
      try {
        if (input.beforeSend(attempt) === false) {
          return lastUnknown;
        }
      } catch {
        return lastUnknown;
      }
    }

    outcome = await sendSyncRequestOnce(input);
    if (outcome.kind === "success") {
      return outcome;
    }
    if (outcome.kind === "rejected") {
      // Any 4xx after an earlier unknown attempt stays unknown and stops retries.
      return mergeUnknownDiagnostic(lastUnknown, {
        kind: "unknown",
        error: new Error(`sync_request_retry_status_${outcome.status}`),
        status: outcome.status,
        body: outcome.body,
      });
    }
    lastUnknown = mergeUnknownDiagnostic(lastUnknown, outcome.result);
    if (outcome.terminal) {
      return lastUnknown;
    }
  }

  return lastUnknown;
}
