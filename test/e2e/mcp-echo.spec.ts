import { test, expect } from "playwright/test";
import { createNewTask, gotoConnected, sendPrompt } from "./helpers.ts";

// MCP transport proof: the WebAgent attaches its Task control plane to every
// ACP task via `mcpServers` with a per-task capability. The mock agent performs
// a real initialize → tools/list → task_list round trip and reports the result.
test("mock agent reaches the MCP server and calls task_list", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewTask(page);

  await sendPrompt(page, "E2E_MCP_TASK_LIST");

  await expect(page.locator(".msg.assistant").last()).toContainText(
    "E2E_MCP_RESULT: 200 tools=task_get_record,task_list,task_query,task_send,task_update task_list=",
  );
});
