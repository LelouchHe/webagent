import type { HostConfig } from "../../config.ts";
import { log } from "../../log.ts";
import { HostConnection } from "./connection.ts";
import {
  retryDelay,
  type HostRuntimeState,
  type HostConnectionState,
  type HostUnreachableReason,
} from "./state.ts";

const hlog = log.scope("hosts");

export class HostRegistry {
  private readonly states = new Map<string, HostRuntimeState>();
  private readonly connections = new Map<string, HostConnection>();
  private started = false;

  constructor(
    configs: Record<string, HostConfig>,
    onConnected?: (name: string) => void,
  ) {
    for (const [name, config] of Object.entries(configs)) {
      this.states.set(name, {
        name,
        url: config.url,
        state: "connecting",
        reason: null,
        since: Date.now(),
      });
      this.connections.set(
        name,
        new HostConnection(config, {
          retryDelay: (attempt) => retryDelay(attempt),
          onState: (state, reason) => {
            this.transition(name, state, reason);
          },
          onConnected: () => {
            onConnected?.(name);
          },
        }),
      );
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const connection of this.connections.values()) connection.start();
  }

  stopAll(): void {
    for (const connection of this.connections.values()) connection.stop();
  }

  list(): HostRuntimeState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  private transition(
    name: string,
    state: HostConnectionState,
    reason?: HostUnreachableReason,
  ): void {
    const current = this.states.get(name);
    if (!current) return;
    const nextReason = state === "unreachable" ? (reason ?? "network") : null;
    if (current.state === state && current.reason === nextReason) return;
    this.states.set(name, {
      ...current,
      state,
      reason: nextReason,
      since: Date.now(),
    });
    hlog.info("state changed", {
      host: name,
      state,
      ...(nextReason ? { reason: nextReason } : {}),
    });
  }
}
