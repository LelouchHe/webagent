export type HostConnectionState = "connecting" | "connected" | "unreachable";

export type HostUnreachableReason =
  "token_command_failed" | "unauthorized" | "network" | "invalid_response";

export interface HostRuntimeState {
  name: string;
  url: string;
  state: HostConnectionState;
  reason: HostUnreachableReason | null;
  since: number;
}

export function retryDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.min(attempt, 30), 30_000);
}
