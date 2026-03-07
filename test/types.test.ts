import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WsMessageSchema, errorMessage } from "../src/types.ts";

describe("WsMessageSchema", () => {
  it("parses new_session", () => {
    const result = WsMessageSchema.safeParse({ type: "new_session" });
    assert.ok(result.success);
    assert.equal(result.data.type, "new_session");
  });

  it("parses new_session with optional cwd", () => {
    const result = WsMessageSchema.safeParse({ type: "new_session", cwd: "/home" });
    assert.ok(result.success);
    if (result.data.type === "new_session") {
      assert.equal(result.data.cwd, "/home");
    }
  });

  it("parses new_session with optional inheritFromSessionId", () => {
    const result = WsMessageSchema.safeParse({
      type: "new_session",
      inheritFromSessionId: "s1",
    });
    assert.ok(result.success);
    if (result.data.type === "new_session") {
      assert.equal(result.data.inheritFromSessionId, "s1");
    }
  });

  it("parses prompt with images", () => {
    const result = WsMessageSchema.safeParse({
      type: "prompt",
      sessionId: "s1",
      text: "hello",
      images: [{ data: "base64data", mimeType: "image/png" }],
    });
    assert.ok(result.success);
  });

  it("rejects prompt without text", () => {
    const result = WsMessageSchema.safeParse({
      type: "prompt",
      sessionId: "s1",
    });
    assert.ok(!result.success);
  });

  it("rejects unknown message type", () => {
    const result = WsMessageSchema.safeParse({ type: "unknown_thing" });
    assert.ok(!result.success);
  });

  it("parses permission_response with denied", () => {
    const result = WsMessageSchema.safeParse({
      type: "permission_response",
      requestId: "r1",
      denied: true,
    });
    assert.ok(result.success);
  });

  it("parses bash_exec", () => {
    const result = WsMessageSchema.safeParse({
      type: "bash_exec",
      sessionId: "s1",
      command: "ls -la",
    });
    assert.ok(result.success);
  });

  it("rejects bash_exec without command", () => {
    const result = WsMessageSchema.safeParse({
      type: "bash_exec",
      sessionId: "s1",
    });
    assert.ok(!result.success);
  });

  it("parses set_config_option", () => {
    const result = WsMessageSchema.safeParse({
      type: "set_config_option",
      sessionId: "s1",
      configId: "model",
      value: "claude-sonnet-4",
    });
    assert.ok(result.success);
  });
});

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    assert.equal(errorMessage(new Error("boom")), "boom");
  });

  it("returns string as-is", () => {
    assert.equal(errorMessage("oops"), "oops");
  });

  it("JSON-stringifies objects", () => {
    assert.equal(errorMessage({ code: 42 }), '{"code":42}');
  });

  it("handles null", () => {
    assert.equal(errorMessage(null), "null");
  });
});
