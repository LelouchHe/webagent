export type HostConnectionState = "connecting" | "connected" | "unreachable";

export const HOST_PROTOCOL_VERSION = 1;

export type HostUnreachableReason =
  "token_command_failed" | "unauthorized" | "network" | "protocol_mismatch";

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
