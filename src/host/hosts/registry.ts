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
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  requestTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  minimumRetryMs?: number;
  maximumRetryMs?: number;
  onConnected?: (name: string) => void | Promise<void>;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class HostRegistry {
  private readonly configs: Record<string, HostConfig>;
  private readonly options: HostRegistryOptions;
  private readonly states = new Map<string, HostRuntimeState>();
  private readonly stop = new AbortController();
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
    if (this.started || this.stop.signal.aborted) return;
    this.started = true;
    for (const name of Object.keys(this.configs)) {
      void this.run(name).catch(() => {
        if (!this.stop.signal.aborted) {
          this.transition(name, "unreachable", "network");
        }
      });
    }
  }

  stopAll(): void {
    this.stop.abort();
  }

  list(): HostRuntimeState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  private async run(name: string): Promise<void> {
    const config = this.configs[name];
    let attempt = 0;
    while (!this.stop.signal.aborted) {
      this.transition(name, "connecting");
      try {
        const connection = new HostConnection(config, this.stop.signal, {
          fetch: this.options.fetch,
          requestTimeoutMs: this.options.requestTimeoutMs,
          heartbeatTimeoutMs: this.options.heartbeatTimeoutMs,
          onState: (state, reason) => {
            this.transition(name, state, reason);
            if (state === "connected") attempt = 0;
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
        await connection.connect();
      } catch (error) {
        if (this.isStopped()) return;
        this.transition(
          name,
          "unreachable",
          HostConnection.failureReason(error),
        );
      }
      if (this.isStopped()) return;
      const delay = retryDelay(
        attempt,
        this.options.minimumRetryMs,
        this.options.maximumRetryMs,
      );
      attempt += 1;
      await (this.options.sleep ?? sleep)(delay, this.stop.signal);
    }
  }

  private isStopped(): boolean {
    return this.stop.signal.aborted;
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
  }
}
