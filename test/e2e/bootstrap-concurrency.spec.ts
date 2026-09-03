import { test, expect } from "playwright/test";
import { currentSessionId, expectConnectionStatus } from "./helpers.ts";

test("concurrent clients converge on the shared Root session without creating one", async ({
  context,
  request,
}) => {
  const sessionPosts: string[] = [];
  context.on("request", (browserRequest) => {
    if (
      browserRequest.method() === "POST" &&
      browserRequest.url().includes("/api/v1/sessions")
    ) {
      sessionPosts.push(new URL(browserRequest.url()).pathname);
    }
  });
  const existing = (await (
    await request.get("/api/v1/sessions")
  ).json()) as Array<{
    id: string;
  }>;
  for (const session of existing) {
    if (session.id === "root") continue;
    const response = await request.delete(`/api/v1/sessions/${session.id}`);
    expect(response.ok()).toBe(true);
  }

  const pages = await Promise.all(
    Array.from({ length: 5 }, () => context.newPage()),
  );
  await Promise.all(pages.map((page) => page.goto("/")));
  // Root carries no URL hash (canonical clean URL), so readiness is signaled by
  // the SSE connection and enabled input, not by a hash.
  await Promise.all(
    pages.map((page) => expectConnectionStatus(page, "connected")),
  );
  await Promise.all(
    pages.map((page) => expect(page.locator("#input")).toBeEnabled()),
  );

  const sessionIds = await Promise.all(
    pages.map((page) => currentSessionId(page)),
  );
  expect(new Set(sessionIds).size).toBe(1);
  expect(sessionIds[0]).toBe("root");
  expect(sessionPosts).toEqual([]);

  const sessions = (await (
    await request.get("/api/v1/sessions")
  ).json()) as Array<{
    id: string;
  }>;
  expect(sessions.map((session) => session.id)).toEqual(["root"]);
});
