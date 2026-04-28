import { describe, it } from "node:test";
import assert from "node:assert";
import { ClientRegistry } from "../src/client-registry.ts";

describe("ClientRegistry", () => {
  it("register stores capabilities, focus null, fresh lastSeen", () => {
    const r = new ClientRegistry();
    const e = r.register("c1", { capabilities: ["sse"] });
    assert.equal(e.id, "c1");
    assert.deepEqual(e.capabilities, ["sse"]);
    assert.equal(e.focus, null);
    assert.ok(e.lastSeen <= Date.now());
  });

  it("re-register same id updates capabilities + lastSeen, keeps focus", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setFocus("c1", "sess-A");
    const before = r.get("c1")!.lastSeen;
    // sleep one tick
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    const e = r.register("c1", { capabilities: ["push"] });
    assert.deepEqual(e.capabilities, ["push"]);
    assert.equal(e.focus, "sess-A");
    assert.ok(e.lastSeen >= before);
  });

  it("remove deletes the client", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.remove("c1");
    assert.equal(r.get("c1"), undefined);
    assert.equal(r.list().length, 0);
  });

  it("setFocus on unknown client is no-op", () => {
    const r = new ClientRegistry();
    r.setFocus("ghost", "sess-X");
    assert.equal(r.get("ghost"), undefined);
  });

  it("setFocus updates focus and lastSeen", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.setFocus("c1", "sess-A");
    assert.equal(r.get("c1")!.focus, "sess-A");
    r.setFocus("c1", null);
    assert.equal(r.get("c1")!.focus, null);
  });

  it("updateCapabilities replaces caps, touches lastSeen", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: ["sse"] });
    r.updateCapabilities("c1", ["sse", "push"]);
    assert.deepEqual(r.get("c1")!.capabilities, ["sse", "push"]);
  });

  it("touch updates lastSeen on existing, no-op on unknown", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    const before = r.get("c1")!.lastSeen;
    const start = Date.now();
    while (Date.now() === start) {
      /* spin */
    }
    r.touch("c1");
    r.touch("ghost"); // no throw
    assert.ok(r.get("c1")!.lastSeen > before);
  });

  it("list returns all registered clients", () => {
    const r = new ClientRegistry();
    r.register("c1", { capabilities: [] });
    r.register("c2", { capabilities: ["push"] });
    const ids = r
      .list()
      .map((e) => e.id)
      .sort();
    assert.deepEqual(ids, ["c1", "c2"]);
  });
});
