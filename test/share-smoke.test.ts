import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Store } from "../src/store.ts";
import { handleShareRoutes, type ShareRouteDeps } from "../src/share/routes.ts";
import type { Config } from "../src/config.ts";

// End-to-end integration smoke: create -> publish -> public view -> revoke -> 410.

interface Mock {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  json: () => unknown;
}
function mockRes(): Mock {
  let status = 0;
  let body = "";
  const res = {
    writeHead(c: number, _h?: Record<string, string>) {
      status = c;
      return res;
    },
    setHeader() {},
    end(chunk?: unknown) {
      if (typeof chunk === "string") body += chunk;
      else if (chunk instanceof Buffer) body += chunk.toString("binary");
    },
  };
  return {
    res: res as unknown as ServerResponse,
    status: () => status,
    body: () => body,
    json: () => {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    },
  };
}

function ownerReq(
  url: string,
  method = "GET",
  body?: unknown,
): IncomingMessage {
  const b = body != null ? JSON.stringify(body) : "";
  const L: Record<string, Array<(a?: unknown) => void>> = {
    data: [],
    end: [],
    error: [],
  };
  const req = {
    url,
    method,
    headers: {
      "sec-fetch-site": "same-origin",
      host: "localhost:6800",
    } as Record<string, string>,
    on(ev: string, cb: (a?: unknown) => void) {
      L[ev].push(cb);
      return req;
    },
  };
  queueMicrotask(() => {
    if (b) for (const cb of L.data) cb(Buffer.from(b));
    for (const cb of L.end) cb();
  });
  return req as unknown as IncomingMessage;
}

function publicReq(url: string, method = "GET"): IncomingMessage {
  const L: Record<string, Array<(a?: unknown) => void>> = {
    data: [],
    end: [],
    error: [],
  };
  const req = {
    url,
    method,
    headers: { host: "public" } as Record<string, string>,
    on(ev: string, cb: (a?: unknown) => void) {
      L[ev].push(cb);
      return req;
    },
  };
  queueMicrotask(() => {
    for (const cb of L.end) cb();
  });
  return req as unknown as IncomingMessage;
}

describe("share smoke — end-to-end lifecycle", () => {
  let tmpDir: string;
  let store: Store;
  let deps: ShareRouteDeps;
  const sid = "smoke-sess";

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wa-share-smk-"));
    store = new Store(tmpDir);
    store.createSession(sid, "/tmp/smoke");
    store.saveEvent(
      sid,
      "user_message",
      { text: "hello world" },
      { from_ref: "agent" },
    );
    store.saveEvent(
      sid,
      "assistant_message",
      {
        text: "# Title\n\nSome **bold** text.",
      },
      { from_ref: "agent" },
    );
    const cfg: Config["share"] = {
      enabled: true,
      ttl_hours: 0,
      csp_enforce: true,
      viewer_origin: "",
      internal_hosts: [],
    };
    deps = { store, config: cfg, dataDir: tmpDir, publicDir: "/tmp" };
  });
  after(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("create preview -> publish -> public JSON serves sanitized events with no session_id -> revoke -> 410", async () => {
    // 1. Create preview.
    const r1 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "POST", {}),
      r1.res,
      deps,
    );
    assert.equal(r1.status(), 201);
    const token = (r1.json() as { token: string }).token;
    assert.match(token, /^[A-Za-z0-9_-]{24}$/);

    // 2. Publish.
    const r2 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share/publish`, "POST", {
        token,
        display_name: "smoker",
      }),
      r2.res,
      deps,
    );
    assert.equal(r2.status(), 200);
    const pub = r2.json() as { public_url: string; shared_at: number };
    assert.match(pub.public_url, new RegExp(`/s/${token}$`));
    assert.ok(pub.shared_at > 0);

    // 3. Public viewer JSON.
    const r3 = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/shared/${token}/events`),
      r3.res,
      deps,
    );
    assert.equal(r3.status(), 200);
    const pv = r3.json() as {
      share: Record<string, unknown>;
      events: unknown[];
    };
    assert.equal(
      pv.share.session_id,
      undefined,
      "public JSON must NOT expose session_id",
    );
    assert.equal(pv.share.display_name, "smoker");
    assert.ok(Array.isArray(pv.events));

    // 4. Owner list sees the active share.
    const r4 = mockRes();
    await handleShareRoutes(ownerReq("/api/v1/shares"), r4.res, deps);
    assert.equal(r4.status(), 200);
    assert.equal((r4.json() as { shares: unknown[] }).shares.length, 1);

    // 5. Revoke.
    const r5 = mockRes();
    await handleShareRoutes(
      ownerReq(`/api/v1/sessions/${sid}/share`, "DELETE", { token }),
      r5.res,
      deps,
    );
    assert.equal(r5.status(), 200);
    assert.equal((r5.json() as { revoked: boolean }).revoked, true);

    // 6. Public JSON now 410.
    const r6 = mockRes();
    await handleShareRoutes(
      publicReq(`/api/v1/shared/${token}/events`),
      r6.res,
      deps,
    );
    assert.equal(r6.status(), 410);

    // 7. Owner list empty again.
    const r7 = mockRes();
    await handleShareRoutes(ownerReq("/api/v1/shares"), r7.res, deps);
    assert.deepEqual((r7.json() as { shares: unknown[] }).shares, []);
  });
});
