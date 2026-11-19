import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveLive,
  isLiveSource,
  type LiveSource,
  type LiveState,
} from "../public/js/live-source.ts";

function fixedSource(state: LiveState<number[]>): {
  source: LiveSource<number[]>;
  stops: () => number;
} {
  let stops = 0;
  return {
    source: {
      read: () => state,
      watch: () => () => {
        stops += 1;
      },
    },
    stops: () => stops,
  };
}

describe("deriveLive", () => {
  it("derives a value and passes loading and errors through", () => {
    const double = (xs: number[]) => xs.map((x) => x * 2);
    assert.deepEqual(
      deriveLive(fixedSource([1, 2]).source, double).read(),
      [2, 4],
    );
    assert.equal(
      deriveLive(fixedSource("loading").source, double).read(),
      "loading",
    );
    assert.deepEqual(
      deriveLive(fixedSource({ error: "down" }).source, double).read(),
      { error: "down" },
    );
  });

  it("watching the derived source watches the original", () => {
    const fixed = fixedSource([1]);
    const stop = deriveLive(fixed.source, (xs) => xs.length).watch(
      () => undefined,
    );
    stop();
    assert.equal(fixed.stops(), 1);
  });
});

describe("isLiveSource", () => {
  it("tells a source from plain data", () => {
    assert.ok(isLiveSource(fixedSource([]).source));
    assert.ok(!isLiveSource([1, 2]));
    assert.ok(!isLiveSource(Promise.resolve([])));
    assert.ok(!isLiveSource(null));
  });
});
