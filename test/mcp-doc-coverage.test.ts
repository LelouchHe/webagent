import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpTools } from "../src/mcp/tools.ts";

const ROOT = join(import.meta.dirname, "..");
const MCP_DOC = readFileSync(join(ROOT, "docs/task-mcp.md"), "utf-8");

type RegisteredTool = {
  inputSchema: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type RegisteredServer = {
  _registeredTools: Record<string, RegisteredTool>;
};

function registeredTools(): Record<string, RegisteredTool> {
  const server = new McpServer({ name: "doc-coverage", version: "0.0.0" });
  const host = {
    list: () => [],
    query: () => ({
      workflowStatus: "idle" as const,
      records: [],
      hasMore: false,
    }),
    getRecord: () => {
      throw new Error("not used");
    },
    cancel: async () => ({
      accepted: true as const,
      taskId: "child",
      status: "idle" as const,
    }),
    create: async () => ({ taskId: "child" }),
    send: async () => {},
    update: async () => {},
  };
  registerMcpTools(server, "current", host);
  return (server as unknown as RegisteredServer)._registeredTools;
}

function documentedToolNames(): string[] {
  const toolsStart = MCP_DOC.indexOf("## Tools");
  const nextHeading = MCP_DOC.indexOf("\n### ", toolsStart + 1);
  const section = MCP_DOC.slice(
    toolsStart,
    nextHeading < 0 ? MCP_DOC.length : nextHeading,
  );
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(
    (match) => match[1],
  );
}

describe("MCP documentation coverage", () => {
  const tools = registeredTools();
  const toolNames = Object.keys(tools).sort();
  const docNames = documentedToolNames().sort();

  it("documents exactly the registered Task MCP tools", () => {
    assert.deepEqual(docNames, toolNames);
  });

  for (const name of toolNames) {
    it(`documents the input fields for ${name}`, () => {
      const properties = Object.keys(
        tools[name].inputSchema.properties ?? {},
      ).sort();
      const sectionStart = MCP_DOC.indexOf(`### \`${name}\``);
      const nextSection = MCP_DOC.indexOf("\n### ", sectionStart + 1);
      const section = MCP_DOC.slice(
        sectionStart,
        nextSection < 0 ? MCP_DOC.length : nextSection,
      );
      for (const property of properties) {
        assert.match(
          section,
          new RegExp(
            `\\b${property.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\b`,
          ),
          `${name}.${property} is in the schema but missing from docs/task-mcp.md`,
        );
      }
    });
  }

  it("keeps task_create as a two-step operation", () => {
    const sectionStart = MCP_DOC.indexOf("### `task_create`");
    const section = MCP_DOC.slice(
      sectionStart,
      MCP_DOC.indexOf("\n### ", sectionStart + 1),
    );
    assert.match(section, /task_send/);
    assert.doesNotMatch(section, /required title\s+and brief/i);
  });
});
