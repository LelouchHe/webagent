import { test, expect, type Page } from "playwright/test";
import { createNewTask, currentTaskId, gotoConnected } from "./helpers.ts";

async function announceGroupedChoices(page: Page): Promise<void> {
  await page.locator("#input").fill("E2E_GROUPED_CONFIG_OPTIONS");
  await page.locator("#input").press("Enter");
  await expect
    .poll(async () => {
      const taskId = await currentTaskId(page);
      return await page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/tasks/${id}`);
        if (!response.ok) return 0;
        const detail = (await response.json()) as {
          configOptions: Array<{ id: string; options?: unknown[] }>;
        };
        return (
          detail.configOptions.find((option) => option.id === "model")?.options
            ?.length ?? 0
        );
      }, taskId);
    })
    .toBeGreaterThan(0);
}

test("grouped choices flatten into qualified selectable model options", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);
  await announceGroupedChoices(page);

  await page.locator("#input").fill("/model ");
  await expect(page.locator("#slash-menu.active .slash-item")).toHaveCount(2);
  await expect(page.locator("#slash-menu.active .slash-item")).toContainText([
    "Vendor A/Model One",
    "Vendor A/Model Two",
  ]);
  await page.locator("#input").press("ArrowDown");
  await page.locator("#input").press("Tab");
  await page.locator("#input").press("Enter");

  await expect(page.locator("#messages")).toContainText(
    "Model → Vendor A/Model Two",
  );
  const modelStatus = page.locator("#status-bar .status-model");
  await expect(modelStatus).toHaveText("model-two");
  await expect(modelStatus).toHaveAttribute("title", "vendor-a/model-two");
});

test("grouped model writes return and broadcast the canonical identity", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);
  await announceGroupedChoices(page);

  const taskId = await currentTaskId(page);
  const wireValue = JSON.stringify(["vendor-a", "model-one"]);
  const result = await page.evaluate(
    async ({ id, value }) => {
      const response = await fetch(`/api/v1/tasks/${id}/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      return {
        status: response.status,
        body: (await response.json()) as {
          configOptions?: Array<{
            id: string;
            currentValue: string;
            options: Array<Record<string, unknown>>;
          }>;
          error?: string;
        },
      };
    },
    { id: taskId, value: wireValue },
  );

  expect(result.status).toBe(200);
  const modelOption = result.body.configOptions?.find(
    (option) => option.id === "model",
  );
  expect(modelOption?.currentValue).toBe("vendor-a/model-one");
  expect(modelOption?.options[0]).toMatchObject({
    value: "vendor-a/model-one",
    name: "Vendor A/Model One",
    description: "First choice",
  });
  expect(modelOption?.options[1]).toMatchObject({
    value: "vendor-a/model-two",
    name: "Vendor A/Model Two",
    _meta: { rank: 2 },
  });

  const modelStatus = page.locator("#status-bar .status-model");
  await expect(modelStatus).toHaveText("model-one");
  await expect(modelStatus).toHaveAttribute("title", "vendor-a/model-one");
  const detail = await page.evaluate(async (id) => {
    const response = await fetch(`/api/v1/tasks/${id}`);
    return (await response.json()) as {
      model: string;
      configOptions: Array<{ id: string; currentValue: string }>;
    };
  }, taskId);
  expect(detail.model).toBe("vendor-a/model-one");
  expect(
    detail.configOptions.find((option) => option.id === "model")?.currentValue,
  ).toBe("vendor-a/model-one");
});
