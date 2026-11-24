import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type {
  JsonObject,
  Json,
  MockBehavior,
  RegressionClient,
  RegressionContext,
  RegressionInstanceContext,
} from "./types.ts";

export const EMPTY_MOCK: MockBehavior = { prompts: [] };

export interface ProvisionedHostToken {
  tokenPath: string;
  created: {
    status: number;
    name: string;
    scope: string;
  };
}

export interface ProvisionHostTokenOptions {
  transform?: (token: string) => string;
  write?: boolean;
  waitFor?: "connected" | null;
  scope?: "api" | "host";
}

export function hostTokenPath(
  instances: Record<string, RegressionInstanceContext>,
): string {
  return join(instances.hub.root, "owner-token");
}

export function hubHostConfig(
  instances: Record<string, RegressionInstanceContext>,
): string[] {
  return [
    "[hosts.owner]",
    `url = ${JSON.stringify(instances.owner.origin)}`,
    `token = ${JSON.stringify(`!cat ${hostTokenPath(instances)}`)}`,
  ];
}

export async function provisionHostToken(
  context: RegressionContext,
  options: ProvisionHostTokenOptions = {},
): Promise<ProvisionedHostToken> {
  const response = await context
    .instance("owner")
    .rest("POST", "/api/v1/tokens", {
      name: "hub-connection",
      scope: options.scope ?? "api",
    });
  const body = response.body as JsonObject;
  if (
    response.status !== 201 ||
    typeof body.token !== "string" ||
    typeof body.name !== "string" ||
    typeof body.scope !== "string"
  ) {
    throw new Error(`token creation failed: ${JSON.stringify(response)}`);
  }
  const tokenPath = hostTokenPath(context.instances);
  if (options.write !== false) {
    writeFileSync(tokenPath, options.transform?.(body.token) ?? body.token);
  }
  if (options.waitFor !== null) {
    await waitForHost(context, "hub", "owner", "connected");
  }
  return {
    tokenPath,
    created: {
      status: response.status,
      name: body.name,
      scope: body.scope,
    },
  };
}

export async function waitForHost(
  context: RegressionClient,
  instanceName: string,
  hostName: string,
  state: "connecting" | "connected" | "unreachable",
  reason?: string,
): Promise<Json> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const latest = (
      await context.instance(instanceName).rest("GET", "/api/v1/hosts")
    ).body;
    if (Array.isArray(latest)) {
      const host = latest.find(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (entry as JsonObject).name === hostName,
      ) as JsonObject | undefined;
      if (
        host?.state === state &&
        (reason === undefined || host.reason === reason)
      ) {
        return latest;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `${instanceName}: ${hostName} did not become ${state}${reason ? ` (${reason})` : ""}`,
  );
}

export function readHostToken(state: ProvisionedHostToken): string {
  return readFileSync(state.tokenPath, "utf8");
}
