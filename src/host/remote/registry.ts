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

export interface HostRegistryOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  minimumRetryMs?: number;
  maximumRetryMs?: number;
  onConnected?: (name: string) => void | Promise<void>;
  onState?: (
    name: string,
    state: HostConnectionState,
    reason?: HostUnreachableReason,
  ) => void;
}

export class HostRegistry {
  private readonly configs: Record<string, HostConfig>;
  private readonly options: HostRegistryOptions;
  private readonly states = new Map<string, HostRuntimeState>();
  private readonly connections = new Map<string, HostConnection>();
  private started = false;

  constructor(
    configs: Record<string, HostConfig>,
    options: HostRegistryOptions = {},
  ) {
    this.configs = configs;
    this.options = options;
    const now = options.now ?? Date.now;
    for (const [name, config] of Object.entries(configs)) {
      this.states.set(name, {
        name,
        url: config.url,
        state: "connecting",
        reason: null,
        since: now(),
      });
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const [name, config] of Object.entries(this.configs)) {
      const connection = new HostConnection(config, {
        fetch: this.options.fetch,
        requestTimeoutMs: this.options.requestTimeoutMs,
        heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
        retryDelay: (failures) =>
          retryDelay(
            failures,
            this.options.minimumRetryMs,
            this.options.maximumRetryMs,
          ),
        onState: (state, reason) => {
          this.transition(name, state, reason);
        },
        onConnected: async () => {
          try {
            await this.options.onConnected?.(name);
          } catch (error) {
            hlog.warn("catch-up hook failed", {
              host: name,
              error: String(error),
            });
          }
        },
      });
      this.connections.set(name, connection);
      connection.start();
    }
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
    const now = this.options.now ?? Date.now;
    this.states.set(name, {
      ...current,
      state,
      reason: nextReason,
      since: now(),
    });
    hlog.info("state changed", {
      host: name,
      state,
      ...(nextReason ? { reason: nextReason } : {}),
    });
    this.options.onState?.(name, state, nextReason ?? undefined);
  }
}
