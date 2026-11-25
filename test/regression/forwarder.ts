import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type RegressionForwarderChannel = "post" | "watch";

interface ActiveExchange {
  downstream: ServerResponse;
  upstream: IncomingMessage;
}

interface ChannelState {
  connected: boolean;
  dropResponses: number;
  holdResponses: number;
  held: ActiveExchange | null;
  active: Set<ActiveExchange>;
}

export class RegressionForwarder {
  origin = "";

  private readonly targetOrigin: string;
  private readonly channels: Record<RegressionForwarderChannel, ChannelState> =
    {
      post: createChannelState(),
      watch: createChannelState(),
    };
  private readonly server = createServer((request, response) => {
    void this.forward(request, response);
  });

  private constructor(targetOrigin: string) {
    this.targetOrigin = targetOrigin;
  }

  static async start(target: string): Promise<RegressionForwarder> {
    const forwarder = new RegressionForwarder(target);
    await new Promise<void>((resolve, reject) => {
      forwarder.server.once("error", reject);
      forwarder.server.listen(0, "127.0.0.1", () => {
        forwarder.server.off("error", reject);
        forwarder.origin = `http://127.0.0.1:${regressionForwarderPort(forwarder)}`;
        resolve();
      });
    });
    return forwarder;
  }

  disconnect(channel: RegressionForwarderChannel): void {
    const state = this.channels[channel];
    state.connected = false;
    for (const exchange of state.active) {
      exchange.upstream.destroy();
      exchange.downstream.destroy();
    }
    state.active.clear();
    this.release(channel);
  }

  connect(channel: RegressionForwarderChannel): void {
    this.channels[channel].connected = true;
  }

  dropNextResponse(channel: RegressionForwarderChannel): void {
    this.channels[channel].dropResponses += 1;
  }

  holdNextResponse(channel: RegressionForwarderChannel): void {
    this.channels[channel].holdResponses += 1;
  }

  release(channel: RegressionForwarderChannel): void {
    const state = this.channels[channel];
    const exchange = state.held;
    state.held = null;
    if (!exchange || exchange.downstream.destroyed) return;
    exchange.downstream.writeHead(
      exchange.upstream.statusCode ?? 502,
      exchange.upstream.statusMessage,
      exchange.upstream.headers,
    );
    exchange.upstream.pipe(exchange.downstream);
  }

  async close(): Promise<void> {
    for (const channel of ["post", "watch"] as const) {
      for (const exchange of this.channels[channel].active) {
        exchange.upstream.destroy();
        exchange.downstream.destroy();
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async forward(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const channel = request.method === "POST" ? "post" : "watch";
    const state = this.channels[channel];
    if (!state.connected) {
      response.writeHead(503).end();
      return;
    }

    const target = new URL(this.targetOrigin);
    const upstreamRequest = httpRequest(
      `${target.origin}${request.url ?? "/"}`,
      {
        method: request.method,
        headers: request.headers,
      },
      (upstream) => {
        const exchange = { downstream: response, upstream };
        state.active.add(exchange);
        const finish = () => state.active.delete(exchange);
        response.once("close", finish);
        upstream.once("end", finish);
        upstream.once("close", finish);

        if (state.dropResponses > 0) {
          state.dropResponses -= 1;
          upstream.destroy();
          response.destroy();
          return;
        }
        if (state.holdResponses > 0) {
          state.holdResponses -= 1;
          if (state.held) {
            state.held.upstream.destroy();
            state.held.downstream.destroy();
          }
          state.held = exchange;
          upstream.pause();
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
    upstreamRequest.once("error", () => {
      if (!response.destroyed) response.destroy();
    });
    request.pipe(upstreamRequest);
  }
}

export function regressionForwarderPort(
  forwarder: RegressionForwarder,
): number {
  const address = forwarderAddress(forwarder);
  return address.port;
}

function createChannelState(): ChannelState {
  return {
    connected: true,
    dropResponses: 0,
    holdResponses: 0,
    held: null,
    active: new Set(),
  };
}

function forwarderAddress(forwarder: RegressionForwarder): AddressInfo {
  const address = (
    forwarder as unknown as {
      server: { address(): AddressInfo | string | null };
    }
  ).server.address();
  if (!address || typeof address === "string") {
    throw new Error("regression forwarder is not listening");
  }
  return address;
}
