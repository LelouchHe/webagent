import { test, expect } from "playwright/test";

test("concurrent clients bootstrap one shared session", async ({
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
    const response = await request.delete(`/api/v1/sessions/${session.id}`);
    expect(response.ok()).toBe(true);
  }

  const pages = await Promise.all(
    Array.from({ length: 5 }, () => context.newPage()),
  );
  await Promise.all(pages.map((page) => page.goto("/")));
  await Promise.all(
    pages.map((page) =>
      expect
        .poll(() => page.evaluate(() => location.hash.slice(1)))
        .not.toBe(""),
    ),
  );

  const sessionIds = await Promise.all(
    pages.map((page) => page.evaluate(() => location.hash.slice(1))),
  );
  expect(
    new Set(sessionIds).size,
    `session POSTs: ${sessionPosts.join(", ")}`,
  ).toBe(1);

  const sessions = (await (
    await request.get("/api/v1/sessions")
  ).json()) as Array<{
    id: string;
  }>;
  // S1: the hash anchors the Task — resolve its live session for comparison.
  const anchor = sessionIds[0];
  const task = (await (
    await request.get(`/api/v1/tasks/${anchor}`)
  ).json()) as {
    task?: { liveSessionId?: string | null };
  };
  expect(sessions.map((session) => session.id)).toEqual([
    task.task?.liveSessionId,
  ]);
});
