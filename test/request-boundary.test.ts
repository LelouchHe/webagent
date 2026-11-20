import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { withRequestErrorBoundary } from "../src/request-boundary.ts";

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => {
          resolve({ status: res.statusCode!, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("request error boundary", () => {
  it("answers a non-URI handler failure as 500", async () => {
    const server = http.createServer(
      withRequestErrorBoundary(async () => {
        throw new Error("boom");
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    try {
      const res = await get(port, "/");
      assert.equal(res.status, 500);
      assert.equal(
        (JSON.parse(res.body) as { error: string }).error,
        "Internal Server Error",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
