import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { taskDisplayPath } from "../public/js/path-display.ts";

describe("display-path selection", () => {
  it("selects the server display form when present", () => {
    assert.equal(
      taskDisplayPath({ cwd: "/Users/u/x", cwdDisplay: "~/x" }),
      "~/x",
    );
    assert.equal(taskDisplayPath({ cwd: "/Users/u/x" }), "/Users/u/x");
  });
});
