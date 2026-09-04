import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskTreeLock } from "../src/task-tree-lock.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("TaskTreeLock", () => {
  it("allows mutations in sibling branches concurrently", async () => {
    const lock = new TaskTreeLock();
    const a = await lock.acquire({ shared: ["root"], exclusive: ["a"] });
    let bRelease: (() => void) | undefined;
    const bAcquired = lock
      .acquire({ shared: ["root"], exclusive: ["b"] })
      .then((release) => {
        bRelease = release;
      });

    await bAcquired;
    assert.equal(typeof bRelease, "function");

    bRelease!();
    a();
  });

  it("blocks a descendant mutation while an ancestor subtree is deleted", async () => {
    const lock = new TaskTreeLock();
    const ancestor = await lock.acquire({
      shared: ["root"],
      exclusive: ["a"],
    });
    let childGranted = false;
    const childPromise = lock
      .acquire({ shared: ["root", "a"], exclusive: ["a1"] })
      .then((release) => {
        childGranted = true;
        return release;
      });

    await tick();
    assert.equal(childGranted, false);
    ancestor();
    const child = await childPromise;
    assert.equal(childGranted, true);
    child();
  });

  it("blocks Root reset while any branch mutation is active", async () => {
    const lock = new TaskTreeLock();
    const branch = await lock.acquire({
      shared: ["root"],
      exclusive: ["a"],
    });
    let rootGranted = false;
    const rootPromise = lock
      .acquire({ exclusive: ["root"] })
      .then((release) => {
        rootGranted = true;
        return release;
      });

    await tick();
    assert.equal(rootGranted, false);
    branch();
    const root = await rootPromise;
    assert.equal(rootGranted, true);
    root();
  });

  it("keeps an earlier conflicting request ahead of a later sibling request", async () => {
    const lock = new TaskTreeLock();
    const branch = await lock.acquire({
      shared: ["root"],
      exclusive: ["a"],
    });
    let rootGranted = false;
    const rootPromise = lock
      .acquire({ exclusive: ["root"] })
      .then((release) => {
        rootGranted = true;
        return release;
      });
    let siblingGranted = false;
    const siblingPromise = lock
      .acquire({ shared: ["root"], exclusive: ["b"] })
      .then((release) => {
        siblingGranted = true;
        return release;
      });

    await tick();
    assert.equal(rootGranted, false);
    assert.equal(siblingGranted, false);
    branch();
    const root = await rootPromise;
    assert.equal(rootGranted, true);
    root();
    const sibling = await siblingPromise;
    assert.equal(siblingGranted, true);
    sibling();
  });
});
