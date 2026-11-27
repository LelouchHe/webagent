import { randomInt } from "node:crypto";
import { isPortFree } from "../e2e/run-context.ts";

/**
 * Non-ephemeral loopback port range for regression servers: avoids Linux
 * ip_local_port_range (32768-60999) and macOS ephemeral ports (49152-65535) so
 * OS listen(0) forwarders and outgoing client sockets cannot claim a planned
 * server port while the server process is booting.
 */
export const REGRESSION_PORT_MIN = 20_000;
export const REGRESSION_PORT_MAX = 31_999;

export function createRegressionPortAllocator(options?: {
  min?: number;
  max?: number;
  startOffset?: number;
  probe?: (port: number) => Promise<boolean>;
}): () => Promise<number> {
  const min = options?.min ?? REGRESSION_PORT_MIN;
  const max = options?.max ?? REGRESSION_PORT_MAX;
  const span = max - min + 1;
  const probe = options?.probe ?? isPortFree;
  const reserved = new Set<number>();
  let cursor =
    options?.startOffset !== undefined
      ? ((options.startOffset % span) + span) % span
      : randomInt(0, span);

  return async function allocatePort(): Promise<number> {
    for (let tried = 0; tried < span; tried += 1) {
      const candidate = min + cursor;
      cursor = (cursor + 1) % span;
      if (reserved.has(candidate)) continue;
      // Reserve synchronously before awaiting probe so concurrent callers in
      // Promise.allSettled never probe or claim the same port.
      reserved.add(candidate);
      if (await probe(candidate)) return candidate;
    }
    throw new Error(
      `No free regression port available in ${min}-${max} (${reserved.size} tried)`,
    );
  };
}
