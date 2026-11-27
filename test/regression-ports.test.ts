import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import {
  createRegressionPortAllocator,
  REGRESSION_PORT_MAX,
  REGRESSION_PORT_MIN,
} from "./regression/ports.ts";

describe("regression port allocator", () => {
  it("allocates unique non-ephemeral ports across concurrent callers and skips occupied ports [behavior proof]", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    const occupiedPort = (occupied.address() as { port: number }).port;
    try {
      // Probe against a small range containing an occupied port + concurrent calls.
      const allocate = createRegressionPortAllocator({
        min: occupiedPort,
        max: occupiedPort + 20,
        startOffset: 0,
      });
      const ports = await Promise.all(
        Array.from({ length: 10 }, () => allocate()),
      );
      assert.equal(
        new Set(ports).size,
        10,
        "all concurrent ports must be unique",
      );
      assert.equal(
        ports.includes(occupiedPort),
        false,
        "must skip already-occupied port",
      );
    } finally {
      await new Promise<void>((resolve) => {
        occupied.close(() => {
          resolve();
        });
      });
    }

    // Default allocations stay strictly outside Linux (32768-60999) and macOS (49152-65535) ephemeral ranges.
    const defaultAllocate = createRegressionPortAllocator();
    const defaultPorts = await Promise.all(
      Array.from({ length: 40 }, () => defaultAllocate()),
    );
    assert.equal(new Set(defaultPorts).size, 40);
    for (const port of defaultPorts) {
      assert.ok(port >= REGRESSION_PORT_MIN && port <= REGRESSION_PORT_MAX);
      assert.ok(port >= 1024 && port < 32_768);
    }
  });
});
