import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { createRequestHandler } from "../src/routes.ts";
import type { AgentEvent, ConfigOption } from "../src/types.ts";

function putConfig(port: number, taskId: string, value: string) {
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: `/api/v1/tasks/${taskId}/model`,
          method: "PUT",
          headers: { "Content-Type": "application/json" },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(body) as Record<string, unknown>,
            });
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ value }));
    },
  );
}

describe("config option route authority", () => {
  it("broadcasts the resolved response value rather than the request encoding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webagent-config-route-"));
    const publicDir = join(dir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "ok");
    const store = new Store(dir, "config-route-test");
    store.createTask("task-1", dir, "auto", "session-1");
    const events: AgentEvent[] = [];
    const canonicalOptions: ConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "vendor-a/model-one",
        options: [{ value: "vendor-a/model-one", name: "Vendor A/Model One" }],
      },
    ];
    const server = http.createServer(
      createRequestHandler({
        store,
        publicDir,
        dataDir: dir,
        limits: { bash_output: 1_048_576, image_upload: 10_485_760 },
        sseManager: {
          broadcast: (event: AgentEvent) => events.push(event),
        } as any,
        getBridge: () =>
          ({
            setConfigOption: async () => canonicalOptions,
          }) as any,
      }),
    );
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as { port: number }).port;
      const encoded = JSON.stringify(["vendor-a", "model-one"]);
      const response = await putConfig(port, "task-1", encoded);
      assert.equal(response.status, 200);
      const configSet = events.find((event) => event.type === "config_set");
      assert.deepEqual(configSet, {
        type: "config_set",
        taskId: "task-1",
        configId: "model",
        value: "vendor-a/model-one",
      });
    } finally {
      store.close();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
