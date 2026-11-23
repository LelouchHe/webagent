import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type {
  JsonObject,
  MockBehavior,
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
  tokenTransform: (token: string) => string = (token) => token,
  writeToken = true,
  waitForConnected = true,
): Promise<ProvisionedHostToken> {
  const response = await context
    .instance("owner")
    .rest("POST", "/api/v1/tokens", {
      name: "hub-connection",
      scope: "api",
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
  if (writeToken) writeFileSync(tokenPath, tokenTransform(body.token));
  if (waitForConnected) {
    await context.waitForHost("hub", "owner", "connected");
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

export function readHostToken(state: ProvisionedHostToken): string {
  return readFileSync(state.tokenPath, "utf8");
}
