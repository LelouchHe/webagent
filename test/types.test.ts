import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorMessage } from "../src/types.ts";

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
