import {
  createServer,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type RegressionForwarderChannel = "post" | "watch";

export interface RegressionForwarderRoutes {
  post: string;
  watch: string;
}

interface ActiveExchange {
  downstream: ServerResponse;
  upstreamRequest: ClientRequest | null;
  upstreamResponse: IncomingMessage | null;
}

interface HoldArm {
  resolve(): void;
}

interface ChannelState {
  connected: boolean;
  dropResponses: number;
  holdArms: HoldArm[];
  held: ActiveExchange | null;
  active: Set<ActiveExchange>;
}

export class RegressionForwarder {
  origin = "";

  private readonly targetOrigin: string;
  private readonly routes: RegressionForwarderRoutes;
  private readonly channels: Record<RegressionForwarderChannel, ChannelState> =
    {
      post: createChannelState(),
      watch: createChannelState(),
    };
  private readonly server = createServer((request, response) => {
    void this.forward(request, response);
  });

  private constructor(targetOrigin: string, routes: RegressionForwarderRoutes) {
    this.targetOrigin = targetOrigin;
    this.routes = routes;
  }

  static async start(
    target: string,
    routes: RegressionForwarderRoutes,
  ): Promise<RegressionForwarder> {
    const forwarder = new RegressionForwarder(target, routes);
    await new Promise<void>((resolve, reject) => {
      forwarder.server.once("error", reject);
      forwarder.server.listen(0, "127.0.0.1", () => {
        forwarder.server.off("error", reject);
        const address = forwarder.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("regression forwarder is not listening"));
          return;
        }
        forwarder.origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    return forwarder;
  }

  disconnect(channel: RegressionForwarderChannel): void {
    const state = this.channels[channel];
    state.connected = false;
    for (const exchange of state.active) destroyExchange(exchange);
    state.active.clear();
    state.held = null;
  }

  connect(channel: RegressionForwarderChannel): void {
    this.channels[channel].connected = true;
  }

  dropNextResponse(channel: RegressionForwarderChannel): void {
    this.channels[channel].dropResponses += 1;
  }

  holdNextResponse(channel: RegressionForwarderChannel): Promise<void> {
    let releaseHeld: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    this.channels[channel].holdArms.push({
      resolve: () => releaseHeld?.(),
    });
    return promise;
  }

  release(channel: RegressionForwarderChannel): void {
    const state = this.channels[channel];
    const exchange = state.held;
    state.held = null;
    if (!exchange?.upstreamResponse || exchange.downstream.destroyed) return;
    exchange.downstream.writeHead(
      exchange.upstreamResponse.statusCode ?? 502,
      exchange.upstreamResponse.statusMessage,
      exchange.upstreamResponse.headers,
    );
    exchange.upstreamResponse.pipe(exchange.downstream);
  }

  async close(): Promise<void> {
    for (const channel of ["post", "watch"] as const) {
      for (const exchange of this.channels[channel].active) {
        destroyExchange(exchange);
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", this.origin).pathname;
    const channel = classifyChannel(request.method, path, this.routes);
    const state = channel === null ? null : this.channels[channel];
    if (state && !state.connected) {
      response.writeHead(503).end();
      return;
    }

    const exchange: ActiveExchange = {
      downstream: response,
      upstreamRequest: null,
      upstreamResponse: null,
    };
    state?.active.add(exchange);
    const finish = () => {
      if (state) state.active.delete(exchange);
      if (exchange.upstreamResponse) exchange.upstreamResponse.destroy();
      if (exchange.upstreamRequest) exchange.upstreamRequest.destroy();
    };
    response.once("close", finish);

    const target = new URL(this.targetOrigin);
    const upstreamRequest = httpRequest(
      `${target.origin}${request.url ?? "/"}`,
      {
        method: request.method,
        headers: request.headers,
      },
      (upstream) => {
        exchange.upstreamResponse = upstream;
        upstream.once("end", finish);
        upstream.once("close", finish);
        if (state && state.dropResponses > 0) {
          state.dropResponses -= 1;
          upstream.destroy();
          response.destroy();
          return;
        }
        const hold = state?.holdArms.shift();
        if (state && hold) {
          if (state.held) destroyExchange(state.held);
          state.held = exchange;
          upstream.pause();
          hold.resolve();
          return;
        }
        response.writeHead(
          upstream.statusCode ?? 502,
          upstream.statusMessage,
          upstream.headers,
        );
        upstream.pipe(response);
      },
    );
    exchange.upstreamRequest = upstreamRequest;
    upstreamRequest.once("error", () => {
      if (!response.destroyed) response.destroy();
    });
    request.pipe(upstreamRequest);
  }
}

function classifyChannel(
  method: string | undefined,
  path: string,
  routes: RegressionForwarderRoutes,
): RegressionForwarderChannel | null {
  if (method === "POST" && path === routes.post) return "post";
  if (method === "GET" && path === routes.watch) return "watch";
  return null;
}

function createChannelState(): ChannelState {
  return {
    connected: true,
    dropResponses: 0,
    holdArms: [],
    held: null,
    active: new Set(),
  };
}

function destroyExchange(exchange: ActiveExchange): void {
  exchange.upstreamResponse?.destroy();
  exchange.upstreamRequest?.destroy();
  if (!exchange.downstream.destroyed) exchange.downstream.destroy();
}
