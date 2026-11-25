import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { afterEach, test } from "node:test";
import { RegressionForwarder } from "./regression/forwarder.ts";

const servers: Array<Server | RegressionForwarder> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      return server instanceof RegressionForwarder
        ? server.close()
        : new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          });
    }),
  );
});

test("regression forwarder controls post responses and watch connections", async () => {
  let commits = 0;
  let slowStarted = 0;
  let slowClosed = 0;
  let slowNextPost = false;
  const target = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/peer-post") {
      commits += 1;
      if (slowNextPost) {
        slowNextPost = false;
        slowStarted += 1;
        response.once("close", () => {
          slowClosed += 1;
        });
        return;
      }
      response.end(JSON.stringify({ commit: commits }));
      return;
    }
    if (request.url === "/peer-watch") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: connected\n\n");
      return;
    }
    response.end(JSON.stringify({ path: request.url }));
  });
  servers.push(target);
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  assert(address && typeof address !== "string");
  const forwarder = await RegressionForwarder.start(
    `http://127.0.0.1:${address.port}`,
    { post: "/peer-post", watch: "/peer-watch" },
  );
  servers.push(forwarder);

  const watch = await fetch(`${forwarder.origin}/peer-watch`);
  assert.equal(watch.status, 200);
  const reader = watch.body?.getReader();
  assert(reader);
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /connected/,
  );

  forwarder.disconnect("watch");
  await assert.rejects(reader.read());
  assert.deepEqual(await (await fetch(`${forwarder.origin}/status`)).json(), {
    path: "/status",
  });
  assert.deepEqual(
    await (
      await fetch(`${forwarder.origin}/other-post`, { method: "POST" })
    ).json(),
    { path: "/other-post" },
  );
  forwarder.connect("watch");
  const reconnectedWatch = await fetch(`${forwarder.origin}/peer-watch`);
  assert.equal(reconnectedWatch.status, 200);
  await reconnectedWatch.body?.cancel();

  const barrier = forwarder.holdNextResponse("post");
  let heldSettled = false;
  const held = fetch(`${forwarder.origin}/peer-post`, { method: "POST" }).then(
    (response) => {
      heldSettled = true;
      return response;
    },
  );
  await barrier;
  assert.equal(heldSettled, false);
  forwarder.release("post");
  assert.deepEqual(await (await held).json(), { commit: 1 });

  forwarder.dropNextResponse("post");
  await assert.rejects(
    fetch(`${forwarder.origin}/peer-post`, { method: "POST" }),
  );
  assert.equal(commits, 2);

  forwarder.disconnect("post");
  assert.equal(
    (await fetch(`${forwarder.origin}/peer-post`, { method: "POST" })).status,
    503,
  );
  forwarder.connect("post");
  assert.deepEqual(
    await (
      await fetch(`${forwarder.origin}/peer-post`, { method: "POST" })
    ).json(),
    { commit: 3 },
  );

  slowNextPost = true;
  forwarder.connect("post");
  const slow = fetch(`${forwarder.origin}/peer-post`, { method: "POST" });
  await waitUntil(() => slowStarted === 1);
  forwarder.disconnect("post");
  await assert.rejects(slow);
  await waitUntil(() => slowClosed === 1);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
