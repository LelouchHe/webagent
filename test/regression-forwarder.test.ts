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
  const target = createServer((request, response) => {
    if (request.method === "POST") {
      commits += 1;
      response.end(JSON.stringify({ commit: commits }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: connected\n\n");
  });
  servers.push(target);
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  assert(address && typeof address !== "string");
  const forwarder = await RegressionForwarder.start(
    `http://127.0.0.1:${address.port}`,
  );
  servers.push(forwarder);

  const watch = await fetch(`${forwarder.origin}/watch`);
  assert.equal(watch.status, 200);
  const reader = watch.body?.getReader();
  assert(reader);
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /connected/,
  );

  forwarder.disconnect("watch");
  await assert.rejects(reader.read());
  forwarder.connect("watch");
  const reconnectedWatch = await fetch(`${forwarder.origin}/watch`);
  assert.equal(reconnectedWatch.status, 200);
  await reconnectedWatch.body?.cancel();

  forwarder.holdNextResponse("post");
  let heldSettled = false;
  const held = fetch(`${forwarder.origin}/commit`, { method: "POST" }).then(
    (response) => {
      heldSettled = true;
      return response;
    },
  );
  await waitUntil(() => commits === 1);
  assert.equal(heldSettled, false);
  forwarder.release("post");
  assert.deepEqual(await (await held).json(), { commit: 1 });

  forwarder.dropNextResponse("post");
  await assert.rejects(fetch(`${forwarder.origin}/commit`, { method: "POST" }));
  assert.equal(commits, 2);

  forwarder.disconnect("post");
  assert.equal(
    (await fetch(`${forwarder.origin}/commit`, { method: "POST" })).status,
    503,
  );
  forwarder.connect("post");
  assert.deepEqual(
    await (
      await fetch(`${forwarder.origin}/commit`, { method: "POST" })
    ).json(),
    { commit: 3 },
  );
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
