import {
  ExecutionAdapter,
  type ExecutionRetirer,
} from "./execution-adapter.ts";
import { log } from "./log.ts";

const rlog = log.scope("registry");

/** The transport capabilities the registry drives; `AgentBridge` satisfies it. */
export interface RegistryTransport extends ExecutionRetirer {
  readonly agentId: string;
  isAvailable(): boolean;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Where execution environments come from.
 *
 * Deliberately narrow: the task runtime only needs "which agents exist", "an
 * already-created adapter", and "give me a started adapter for this agent". A
 * single-agent embedder (and most unit tests) can implement it without a
 * process-wide registry.
 */
export interface AgentEnvironment {
  /** Agent that unbound tasks and caller-less operations target. */
  readonly defaultAgentId: string;
  isConfigured(agentId: string): boolean;
  configuredAgentIds(): string[];
  /** An adapter created earlier, never a reason to start anything. */
  existing(agentId: string): ExecutionAdapter | undefined;
  /** Every adapter created so far, in creation order. */
  listExisting(): ExecutionAdapter[];
  /** The adapter for an agent, created on demand but **not** started. */
  adapterFor(agentId: string): ExecutionAdapter;
  /** An adapter with a live transport, starting the agent when needed. */
  resolve(agentId: string): Promise<ExecutionAdapter>;
  /**
   * Run one exclusive process operation (a restart) for an agent. It shares
   * the same single-flight slot as `resolve`, so a start and a reload can
   * never produce two live processes for one agent.
   */
  reload(
    agentId: string,
    run: (adapter: ExecutionAdapter) => Promise<void>,
  ): Promise<void>;
}

/** Raised when an operation needs an agent that cannot be started. */
export class AgentUnavailableError extends Error {
  readonly agentId: string;

  constructor(agentId: string, message?: string, options?: ErrorOptions) {
    super(message ?? `Agent ${agentId} is not available`, options);
    this.name = "AgentUnavailableError";
    this.agentId = agentId;
  }
}

export interface AgentRegistryOptions {
  /** Configured agents; only these may ever be started. */
  agents: Record<string, { cmd: string }>;
  defaultAgentId: string;
  /** Build the transport for one agent, with its event wiring installed. */
  createTransport: (agentId: string) => RegistryTransport;
}

/**
 * `agentId → execution adapter`, started on demand.
 *
 * Nothing is created at boot. `resolve` is single-flight per agent, so
 * concurrent demand for the same agent starts one process; a dead or
 * half-started transport is replaced before it is handed out, and a failed
 * start never leaves a child process behind because the transport itself
 * unwinds on failure.
 */
export class AgentRegistry implements AgentEnvironment {
  readonly defaultAgentId: string;
  private readonly agents: Record<string, { cmd: string }>;
  private readonly createTransport: (agentId: string) => RegistryTransport;
  private readonly entries = new Map<
    string,
    { adapter: ExecutionAdapter; flight: Promise<ExecutionAdapter> | null }
  >();
  /**
   * Every transport this registry ever created. `shutdownAll` uses this rather
   * than the current adapter bindings, so a transport that was unbound (or
   * whose adapter entry was dropped) is still closed.
   */
  private readonly transports = new Set<RegistryTransport>();

  constructor(options: AgentRegistryOptions) {
    this.agents = options.agents;
    this.defaultAgentId = options.defaultAgentId;
    this.createTransport = options.createTransport;
  }

  isConfigured(agentId: string): boolean {
    return Object.hasOwn(this.agents, agentId);
  }

  configuredAgentIds(): string[] {
    return Object.keys(this.agents);
  }

  existing(agentId: string): ExecutionAdapter | undefined {
    return this.entries.get(agentId)?.adapter;
  }

  listExisting(): ExecutionAdapter[] {
    return [...this.entries.values()].map((entry) => entry.adapter);
  }

  adapterFor(agentId: string): ExecutionAdapter {
    const entry = this.entries.get(agentId);
    if (entry) return entry.adapter;
    const adapter = new ExecutionAdapter(agentId);
    this.entries.set(agentId, { adapter, flight: null });
    return adapter;
  }

  async resolve(agentId: string): Promise<ExecutionAdapter> {
    if (!this.isConfigured(agentId)) {
      throw new AgentUnavailableError(
        agentId,
        `Agent ${agentId} is not configured`,
      );
    }
    const adapter = this.adapterFor(agentId);
    const entry = this.entries.get(agentId)!;
    // One flight per agent owns the process: a start or a reload that is in
    // progress is the answer for every concurrent caller, and `isAvailable`
    // stays false until that flight's process has finished initializing.
    if (entry.flight) return entry.flight;
    if (adapter.isAvailable()) return adapter;
    return this.startFlight(agentId, entry);
  }

  private startFlight(
    agentId: string,
    entry: {
      adapter: ExecutionAdapter;
      flight: Promise<ExecutionAdapter> | null;
    },
  ): Promise<ExecutionAdapter> {
    const flight = this.startAgent(entry.adapter).finally(() => {
      if (entry.flight === flight) entry.flight = null;
    });
    entry.flight = flight;
    void agentId;
    return flight;
  }

  async reload(
    agentId: string,
    run: (adapter: ExecutionAdapter) => Promise<void>,
  ): Promise<void> {
    if (!this.isConfigured(agentId)) {
      throw new AgentUnavailableError(
        agentId,
        `Agent ${agentId} is not configured`,
      );
    }
    const entry = this.entries.get(agentId);
    if (!entry) {
      throw new AgentUnavailableError(
        agentId,
        `Agent ${agentId} is not running`,
      );
    }
    if (entry.flight) throw new Error("Already reloading");
    const flight = (async () => {
      await run(entry.adapter);
      return entry.adapter;
    })().finally(() => {
      if (entry.flight === flight) entry.flight = null;
    });
    entry.flight = flight;
    // A reload is a flight like any other: `resolve` waits for it instead of
    // starting a second process beside it.
    await flight.then(
      () => {},
      (err: unknown) => {
        throw err;
      },
    );
  }

  private async startAgent(
    adapter: ExecutionAdapter,
  ): Promise<ExecutionAdapter> {
    const previous = adapter.bridge;
    // A failed or dead transport must be unwound before a replacement starts,
    // or the retry would race a half-initialized child process.
    if (previous) {
      adapter.bindBridge(null);
      await previous.shutdown?.().catch(() => {});
    }
    adapter.resetProcessState();
    const transport = this.createTransport(adapter.agentId);
    this.transports.add(transport);
    adapter.bindBridge(transport);
    try {
      await transport.start();
      return adapter;
    } catch (err) {
      adapter.bindBridge(null);
      await transport.shutdown().catch(() => {});
      rlog.warn("agent start failed", {
        agentId: adapter.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new AgentUnavailableError(
        adapter.agentId,
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    }
  }

  /** Close every transport this process ever started. */
  async shutdownAll(): Promise<void> {
    const adapters = [...this.entries.values()].map((entry) => entry.adapter);
    const transports = [...this.transports];
    this.entries.clear();
    this.transports.clear();
    for (const adapter of adapters) adapter.bindBridge(null);
    await Promise.all(
      transports.map((transport) => transport.shutdown().catch(() => {})),
    );
  }
}

/**
 * Environment backed by pre-built adapters. Tests and single-process
 * embedders use it to drive the task runtime without a registry; it never
 * spawns anything, so `resolve` only succeeds for an adapter whose transport
 * the caller already attached.
 */
export class StaticAgentEnvironment implements AgentEnvironment {
  readonly defaultAgentId: string;
  private readonly adapters = new Map<string, ExecutionAdapter>();
  private readonly configured: ((agentId: string) => boolean) | null;

  constructor(
    defaultAgentId: string,
    adapters: Iterable<ExecutionAdapter> = [],
    opts: { isConfigured?: (agentId: string) => boolean } = {},
  ) {
    this.defaultAgentId = defaultAgentId;
    for (const adapter of adapters) this.adapters.set(adapter.agentId, adapter);
    this.configured = opts.isConfigured ?? null;
  }

  isConfigured(agentId: string): boolean {
    if (this.configured) return this.configured(agentId);
    return this.adapters.has(agentId) || agentId === this.defaultAgentId;
  }

  configuredAgentIds(): string[] {
    return [...this.adapters.keys()];
  }

  existing(agentId: string): ExecutionAdapter | undefined {
    return this.adapters.get(agentId);
  }

  listExisting(): ExecutionAdapter[] {
    return [...this.adapters.values()];
  }

  adapterFor(agentId: string): ExecutionAdapter {
    const existing = this.adapters.get(agentId);
    if (existing) return existing;
    const adapter = new ExecutionAdapter(agentId);
    this.adapters.set(agentId, adapter);
    return adapter;
  }

  async reload(
    agentId: string,
    run: (adapter: ExecutionAdapter) => Promise<void>,
  ): Promise<void> {
    const adapter = this.adapters.get(agentId);
    if (!adapter) throw new AgentUnavailableError(agentId);
    await run(adapter);
  }

  async resolve(agentId: string): Promise<ExecutionAdapter> {
    const adapter = this.adapterFor(agentId);
    if (!adapter.isAvailable()) {
      throw new AgentUnavailableError(agentId);
    }
    return adapter;
  }
}
