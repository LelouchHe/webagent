import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Store } from "../src/store.ts";
import { SessionManager } from "../src/session-manager.ts";
import { createRequestHandler } from "../src/routes.ts";

function makeRequest(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .request({ hostname: "127.0.0.1", port, path, method: "GET" }, (res) => {
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString("utf-8");
        });
        res.on("end", () => {
          resolve({ status: res.statusCode!, body: data });
        });
      })
      .on("error", reject)
      .end();
  });
}

/**
 * Wires Store + SessionManager + createRequestHandler end-to-end and
 * verifies the GET /api/v1/sessions/:id/events route applies the
 * attachment label egress rewrite. Complements:
 *  - test/attachment-labels.test.ts (pure unit on enrich fn)
 *  - test/sse-attachment-labels.test.ts (live SSE chokepoint)
 *  - test/attachment-labels-integration.test.ts (helper-level)
 */
describe("HTTP /events attachment label egress", () => {
  let store: Store;
  let sessions: SessionManager;
  let tmpDir: string;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "webagent-route-att-"));
    const publicDir = join(tmpDir, "public");
    mkdirSync(publicDir);
    writeFileSync(join(publicDir, "index.html"), "ok");

    store = new Store(tmpDir);
    sessions = new SessionManager(store, tmpDir, tmpDir);

    store.createSession("s1", "/x");
    store.insertAttachment({
      id: "abcd1234",
      sessionId: "s1",
      kind: "file",
      name: "report.pdf",
      mime: "application/pdf",
      size: 1,
      realpath: "/data/uploads/s1/abcd1234.pdf",
    });

    const handler = createRequestHandler({
      store,
      sessions,
      publicDir,
      dataDir: tmpDir,
      limits: {
        bash_output: 1_048_576,
        image_upload: 10_485_760,
        cancel_timeout: 10_000,
      },
      sseManager: { broadcast() {} } as any,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    store.close();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites tool_call title and rawInput.path; DB stays raw", async () => {
    store.saveEvent(
      "s1",
      "tool_call",
      {
        sessionId: "s1",
        id: "t1",
        title: "Read /data/uploads/s1/abcd1234.pdf",
        kind: "read",
        rawInput: { path: "/data/uploads/s1/abcd1234.pdf" },
      },
      { from_ref: "agent" },
    );

    const res = await makeRequest(port, "/api/v1/sessions/s1/events");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body) as {
      events: Array<{ type: string; data: string }>;
    };
    const tc = body.events.find((e) => e.type === "tool_call")!;
    const parsed = JSON.parse(tc.data);
    assert.equal(parsed.title, "Read report.pdf [#abcd]");
    assert.equal(parsed.rawInput.path, "report.pdf [#abcd]");

    // DB still raw.
    const raw = store.getEvents("s1").find((e) => e.type === "tool_call")!;
    const parsedRaw = JSON.parse(raw.data);
    assert.equal(parsedRaw.title, "Read /data/uploads/s1/abcd1234.pdf");
    assert.equal(parsedRaw.rawInput.path, "/data/uploads/s1/abcd1234.pdf");
  });

  it("does NOT rewrite permission_request.rawInput at HTTP egress (F2 safety)", async () => {
    store.saveEvent(
      "s1",
      "permission_request",
      {
        requestId: "r1",
        sessionId: "s1",
        title: "Allow read /data/uploads/s1/abcd1234.pdf",
        options: [],
        rawInput: { path: "/data/uploads/s1/abcd1234.pdf" },
      },
      { from_ref: "agent" },
    );

    const res = await makeRequest(port, "/api/v1/sessions/s1/events");
    const body = JSON.parse(res.body) as {
      events: Array<{ type: string; data: string }>;
    };
    const pr = body.events.find((e) => e.type === "permission_request")!;
    const parsed = JSON.parse(pr.data);
    assert.equal(parsed.title, "Allow read report.pdf [#abcd]");
    assert.equal(
      parsed.rawInput.path,
      "/data/uploads/s1/abcd1234.pdf",
      "F2 interceptor depends on raw permission_request.rawInput.path",
    );
  });
});
