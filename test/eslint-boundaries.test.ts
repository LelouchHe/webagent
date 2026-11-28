import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { ESLint } from "eslint";

const ROOT = resolve(import.meta.dirname, "..");

const eslint = new ESLint({ cwd: ROOT });

async function restrictedImportErrors(
  relPath: string,
  code: string,
): Promise<string[]> {
  const [result] = await eslint.lintText(code, {
    filePath: resolve(ROOT, relPath),
  });
  return result.messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map((message) => message.message);
}

describe("ESLint architecture dependency boundary matrix", () => {
  it("allows Core modules to import the neutral host/api.ts port", async () => {
    for (const [file, code] of [
      [
        "src/task-ops.ts",
        'import type { TaskHost } from "./host/api.ts";\nexport type X = TaskHost;\n',
      ],
      [
        "src/task-delete.ts",
        'import type { RemoteTaskDeleter } from "./host/api.ts";\nexport type X = RemoteTaskDeleter;\n',
      ],
      [
        "src/task-manager.ts",
        'import type { RemoteTaskDeleter } from "./host/api.ts";\nexport type X = RemoteTaskDeleter;\n',
      ],
    ] as const) {
      const errors = await restrictedImportErrors(file, code);
      assert.deepEqual(
        errors,
        [],
        `${file} should be allowed to import host/api.ts`,
      );
    }
  });

  it("forbids Core modules from importing concrete host implementations", async () => {
    for (const [file, specifier] of [
      ["src/task-ops.ts", "./host/local/adapter.ts"],
      ["src/task-ops.ts", "./host/remote/registry.ts"],
      ["src/task-ops.ts", "./host/tasks.ts"],
      ["src/task-ops.ts", "./host/link-sync.ts"],
      ["src/task-manager.ts", "./host/local/adapter.ts"],
      ["src/task-manager.ts", "./host/tasks.ts"],
      ["src/store.ts", "./host/tasks.ts"],
    ] as const) {
      const errors = await restrictedImportErrors(
        file,
        `import type * as x from "${specifier}";\nexport type X = typeof x;\n`,
      );
      assert.ok(
        errors.length > 0,
        `${file} must not be allowed to import ${specifier}`,
      );
    }
  });

  it("forbids HTTP, MCP, and api/** from importing host/** including host/api.ts", async () => {
    for (const [file, specifier] of [
      ["src/http/routes.ts", "../host/api.ts"],
      ["src/http/routes.ts", "../host/tasks.ts"],
      ["src/mcp/tools.ts", "../host/api.ts"],
      ["src/mcp/tools.ts", "../host/tasks.ts"],
      ["src/api/tasks.ts", "../host/api.ts"],
    ] as const) {
      const errors = await restrictedImportErrors(
        file,
        `import type * as x from "${specifier}";\nexport type X = typeof x;\n`,
      );
      assert.ok(
        errors.length > 0,
        `${file} must not be allowed to import ${specifier}`,
      );
    }
  });

  it("forbids host/local and host/remote cross-imports across shallow and deep relative paths", async () => {
    for (const [file, specifier] of [
      ["src/host/local/adapter.ts", "../remote/registry.ts"],
      ["src/host/local/adapter.ts", "../../remote/connection.ts"],
      ["src/host/local/adapter.ts", "../../host/remote/registry.ts"],
      ["src/host/remote/registry.ts", "../local/adapter.ts"],
      ["src/host/remote/registry.ts", "../../local/adapter.ts"],
      ["src/host/remote/registry.ts", "../../host/local/adapter.ts"],
    ] as const) {
      const errors = await restrictedImportErrors(
        file,
        `import type * as x from "${specifier}";\nexport type X = typeof x;\n`,
      );
      assert.ok(
        errors.length > 0,
        `${file} must not be allowed to import ${specifier}`,
      );
    }
  });

  it("forbids TaskManager and Host modules from importing HTTP or MCP entrypoints", async () => {
    for (const [file, specifier] of [
      ["src/task-manager.ts", "./mcp/server.ts"],
      ["src/task-manager.ts", "./mcp/capability.ts"],
      ["src/task-manager.ts", "./http/routes.ts"],
      ["src/host/tasks.ts", "../mcp/server.ts"],
      ["src/host/tasks.ts", "../http/routes.ts"],
    ] as const) {
      const errors = await restrictedImportErrors(
        file,
        `import type * as x from "${specifier}";\nexport type X = typeof x;\n`,
      );
      assert.ok(
        errors.length > 0,
        `${file} must not be allowed to import ${specifier}`,
      );
    }
  });

  it("exempts server.ts as the composition root", async () => {
    const errors = await restrictedImportErrors(
      "src/server.ts",
      [
        'import type * as a from "./mcp/server.ts";',
        'import type * as b from "./http/routes.ts";',
        'import type * as c from "./host/tasks.ts";',
        'import type * as d from "./host/local/adapter.ts";',
        'import type * as e from "./host/remote/registry.ts";',
        "export type X = [typeof a, typeof b, typeof c, typeof d, typeof e];",
      ].join("\n"),
    );
    assert.deepEqual(
      errors,
      [],
      "server.ts must remain exempt as the composition root",
    );
  });
});
