import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMcpTools } from "../src/mcp/tools.ts";
import { MCP_SERVER_INSTRUCTIONS } from "../src/mcp/server.ts";

const ROOT = join(import.meta.dirname, "..");
const MCP_DOC = readFileSync(join(ROOT, "docs/task-mcp.md"), "utf-8");

type Fence = { info: string; content: string; line: number };

/**
 * Split a Markdown document into the headings and fenced blocks that sit
 * outside every other fence. Line numbers let a check scope itself to one
 * section, so a heading quoted inside an example, or an extra fence, can
 * neither shadow the real quote nor satisfy it on the quote's behalf.
 */
function scanMarkdown(markdown: string): {
  headings: Array<{ text: string; line: number }>;
  fences: Fence[];
} {
  const headings: Array<{ text: string; line: number }> = [];
  const fences: Fence[] = [];
  let open: { info: string; line: number; body: string[] } | null = null;
  markdown.split("\n").forEach((line, index) => {
    const fence = /^(`{3,})(.*)$/.exec(line);
    if (open) {
      if (fence?.[2].trim() === "") {
        fences.push({
          info: open.info,
          content: `${open.body.join("\n")}\n`,
          line: open.line,
        });
        open = null;
      } else {
        open.body.push(line);
      }
      return;
    }
    if (fence) open = { info: fence[2].trim(), line: index, body: [] };
    else if (/^#{2,3} /.test(line)) headings.push({ text: line, line: index });
  });
  return { headings, fences };
}

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
      task_id: "current",
      max_seq: 0,
      rows: [],
    }),
    read: () => ({ task_id: "current", rows: [] }),
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

  it("quotes the advertised server instructions verbatim", () => {
    const { headings, fences } = scanMarkdown(MCP_DOC);
    const heading = headings.find(
      (item) => item.text === "## Server instructions",
    );
    assert.ok(heading, "docs/task-mcp.md must document the instructions");
    const nextSection =
      headings.find((item) => item.line > heading.line)?.line ?? Infinity;
    const quoted = fences.filter(
      (item) => item.line > heading.line && item.line < nextSection,
    );
    assert.equal(quoted.length, 1, "expected exactly one quoted block");
    assert.equal(quoted[0].info, "text");
    assert.equal(quoted[0].content, `${MCP_SERVER_INSTRUCTIONS}\n`);
  });
});
