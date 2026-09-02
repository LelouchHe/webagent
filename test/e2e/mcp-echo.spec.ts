import { test, expect } from "playwright/test";
import { createNewSession, gotoConnected, sendPrompt } from "./helpers.ts";

// P0b transport proof: the WebAgent attaches its Task Server to every ACP
// session via `mcpServers` with a per-session capability. The mock agent
// performs a real MCP round trip (initialize → tools/list → tools/call echo)
// on E2E_MCP_ECHO and reports the result — including the session id the
// capability resolved to — as its message text.
test("mock agent reaches the Task Server and calls the echo tool", async ({
  page,
}) => {
  await gotoConnected(page);
  await createNewSession(page);

  await sendPrompt(page, "E2E_MCP_ECHO hello-from-e2e");

  await expect(page.locator(".msg.assistant").last()).toContainText(
    "E2E_MCP_RESULT: 200 tools=echo echo=echo: hello-from-e2e (session ",
  );
});
