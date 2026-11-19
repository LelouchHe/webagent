import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveLive,
  errorsAsEmpty,
  isLiveSource,
  refreshingSource,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("refreshingSource", () => {
  it("reads loading until the first load lands, then notifies watchers", async () => {
    const first = deferred<number[]>();
    let loads = 0;
    const source = refreshingSource(() => {
      loads += 1;
      return first.promise;
    });
    assert.equal(source.read(), "loading");

    const seen: LiveState<number[]>[] = [];
    const stop = source.watch(() => seen.push(source.read()));
    assert.equal(loads, 1);

    first.resolve([1, 2]);
    await tick();
    assert.deepEqual(source.read(), [1, 2]);
    assert.deepEqual(seen, [[1, 2]]);
    stop();
  });

  it("a second watch joins the load in flight", async () => {
    const first = deferred<number[]>();
    let loads = 0;
    const source = refreshingSource(() => {
      loads += 1;
      return first.promise;
    });
    const a: number[][] = [];
    const b: number[][] = [];
    const stopA = source.watch(() => a.push(source.read() as number[]));
    const stopB = source.watch(() => b.push(source.read() as number[]));
    assert.equal(loads, 1);

    first.resolve([3]);
    await tick();
    assert.deepEqual(a, [[3]]);
    assert.deepEqual(b, [[3]]);
    stopA();
    stopB();
  });

  it("a stopped watch hears nothing", async () => {
    const first = deferred<number[]>();
    const source = refreshingSource(() => first.promise);
    const heard: LiveState<number[]>[] = [];
    const stop = source.watch(() => heard.push(source.read()));
    stop();

    first.resolve([4]);
    await tick();
    assert.deepEqual(source.read(), [4]);
    assert.deepEqual(heard, []);
  });

  it("shows a failure only while there is no value", async () => {
    const failed = deferred<number[]>();
    const source = refreshingSource(() => failed.promise);
    const heard: LiveState<number[]>[] = [];
    source.watch(() => heard.push(source.read()));

    failed.reject(new Error("down"));
    await tick();
    assert.deepEqual(source.read(), { error: "down" });
    assert.deepEqual(heard, [{ error: "down" }]);
  });

  it("keeps the last value when a later load fails", async () => {
    const first = deferred<number[]>();
    const second = deferred<number[]>();
    const requests = [first.promise, second.promise];
    const source = refreshingSource(() => requests.shift()!);
    const heard: LiveState<number[]>[] = [];
    source.watch(() => heard.push(source.read()));

    first.resolve([5]);
    await tick();
    // A watch with nothing in flight starts the next load.
    source.watch(() => heard.push(source.read()));
    second.reject(new Error("down"));
    await tick();

    assert.deepEqual(source.read(), [5]);
    assert.deepEqual(heard, [[5]]);
  });
});

describe("errorsAsEmpty", () => {
  it("reads an error as no rows but keeps loading and values", () => {
    const errored = errorsAsEmpty(fixedSource({ error: "down" }).source);
    assert.deepEqual(errored.read(), []);
    const loading = errorsAsEmpty(fixedSource("loading").source);
    assert.equal(loading.read(), "loading");
    const valued = errorsAsEmpty(fixedSource([1]).source);
    assert.deepEqual(valued.read(), [1]);
  });
});
