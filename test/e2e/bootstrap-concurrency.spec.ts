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
    if (session.id === "root") continue;
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
  expect(new Set(sessionIds).size).toBe(1);
  expect(sessionIds[0]).toBe("root");
  expect(sessionPosts).toEqual([]);

  const sessions = (await (
    await request.get("/api/v1/sessions")
  ).json()) as Array<{
    id: string;
  }>;
  expect(sessions.map((session) => session.id)).toEqual([sessionIds[0]]);
});
