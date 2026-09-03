import { test, expect } from "playwright/test";
import { currentTaskId, expectConnectionStatus } from "./helpers.ts";

test("concurrent clients converge on the shared Root task without creating one", async ({
  context,
  request,
}) => {
  const taskPosts: string[] = [];
  context.on("request", (browserRequest) => {
    if (
      browserRequest.method() === "POST" &&
      browserRequest.url().includes("/api/v1/tasks")
    ) {
      taskPosts.push(new URL(browserRequest.url()).pathname);
    }
  });
  const existing = (await (
    await request.get("/api/v1/tasks")
  ).json()) as Array<{
    id: string;
  }>;
  for (const task of existing) {
    if (task.id === "root") continue;
    const response = await request.delete(`/api/v1/tasks/${task.id}`);
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

  const taskIds = await Promise.all(pages.map((page) => currentTaskId(page)));
  expect(new Set(taskIds).size).toBe(1);
  expect(taskIds[0]).toBe("root");
  expect(taskPosts).toEqual([]);

  const tasks = (await (await request.get("/api/v1/tasks")).json()) as Array<{
    id: string;
  }>;
  expect(tasks.map((task) => task.id)).toEqual(["root"]);
});
