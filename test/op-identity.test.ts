import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { opIdentity } from "../src/op-identity.ts";

const NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("opIdentity", () => {
  it("derives a stable RFC 4122 UUIDv5 scoped by namespace, caller, and op id", () => {
    const id = opIdentity(NS, "host:hub-a", "op-1");
    // Pinned value: ids are persisted, so the derivation must never change.
    assert.equal(id, "f6695d96-bf0d-54d6-a0bc-b2f2edef67ee");
    assert.equal(
      opIdentity(NS, "token:browser", "中文-op"),
      "c3307471-0ae2-59f7-9974-b1b29a0a5172",
    );
    assert.equal(opIdentity(NS, "host:hub-a", "op-1"), id);
    assert.notEqual(opIdentity(NS, "host:hub-b", "op-1"), id);
    assert.notEqual(opIdentity(NS, "host:hub-a", "op-2"), id);
    assert.notEqual(
      opIdentity("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "host:hub-a", "op-1"),
      id,
    );
    assert.throws(() => opIdentity("not-a-uuid", "host:hub-a", "op-1"));
  });
});
