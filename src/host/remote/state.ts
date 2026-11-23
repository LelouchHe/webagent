export type HostConnectionState = "connecting" | "connected" | "unreachable";

export type HostUnreachableReason =
  | "token_command_failed"
  | "unauthorized"
  | "insufficient_scope"
  | "network"
  | "protocol_mismatch";

export interface HostRuntimeState {
  name: string;
  url: string;
  state: HostConnectionState;
  reason: HostUnreachableReason | null;
  since: number;
}

export function retryDelay(
  attempt: number,
  minimumMs = 500,
  maximumMs = 30_000,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError("attempt must be a non-negative integer");
  }
  return Math.min(minimumMs * 2 ** Math.min(attempt, 30), maximumMs);
}
