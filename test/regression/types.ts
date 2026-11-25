export type Json = null | boolean | number | string | Json[] | JsonObject;
export type JsonObject = { [key: string]: Json };

export interface RestResponse {
  status: number;
  body: Json;
}

export interface RegressionClient {
  rest(
    method: string,
    path: string,
    body?: Json,
    token?: string,
  ): Promise<RestResponse>;
  instance(name: string): RegressionInstanceClient;
  restart(name: string, whileStopped?: () => Promise<Json>): Promise<Json>;
  forwarder(name: string): RegressionForwarderControl;
}

export interface RegressionForwarderControl {
  connect(channel: "post" | "watch"): void;
  disconnect(channel: "post" | "watch"): void;
  dropNextResponse(channel: "post" | "watch"): void;
  holdNextResponse(channel: "post" | "watch"): void;
  release(channel: "post" | "watch"): void;
}

export interface RegressionInstanceClient {
  rest(
    method: string,
    path: string,
    body?: Json,
    token?: string,
  ): Promise<RestResponse>;
}

export interface RegressionContext extends RegressionClient {
  root: string;
  token: string;
  instances: Record<string, RegressionInstanceContext>;
}

export interface RegressionInstanceContext {
  root: string;
  origin: string;
  forwarders: Record<string, string>;
}

export interface RegressionInstanceSpec {
  mock: MockBehavior;
  extraConfig?: (
    instances: Record<string, RegressionInstanceContext>,
  ) => string[];
}

export interface McpAction {
  tool: string;
  arguments?: JsonObject;
}

export interface PromptBehavior {
  match: string;
  actions: Array<
    | { type: "reply"; text: string }
    | { type: "wait"; label: string }
    | { type: "permission"; title: string; command: string }
    | {
        type: "mcp";
        calls: McpAction[];
        capability?: "current" | "first" | "missing";
      }
    | { type: "fail"; message: string }
  >;
}

export interface MockBehavior {
  onNew?: { calls?: McpAction[] };
  prompts: PromptBehavior[];
}

export interface ScenarioStep<State> {
  name: string;
  action: (
    client: RegressionClient,
    state: State,
  ) => Promise<RestResponse | RestResponse[] | Json>;
}

export interface RegressionScenario<State> {
  mock: MockBehavior;
  instances?: Record<string, RegressionInstanceSpec>;
  forwarders?: Record<string, { target: string }>;
  setup(context: RegressionContext): Promise<State> | State;
  steps: (client: RegressionClient, state: State) => ScenarioStep<State>[];
}

export function scenario<State>(
  definition: RegressionScenario<State>,
): RegressionScenario<State> {
  return definition;
}
