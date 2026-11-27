// ESLint flat config (ESLint 9).
// All enabled rules are "error". Warnings are not used — if a rule is worth
// running, violations block the build; if it isn't, we turn it off.
// Prettier handles all formatting; eslint-config-prettier disables conflicting rules.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

function maxLines(max) {
  return { max, skipBlankLines: true, skipComments: true };
}

const hostImplementationPatterns = [
  {
    group: ["**/host/**"],
    message:
      "Entrypoints may use neutral api/** contracts, not concrete Host implementations.",
  },
];

function entrypointBoundary(peer) {
  return [
    ...hostImplementationPatterns,
    {
      group: [`**/${peer}/**`],
      message: "HTTP and MCP entrypoints cannot depend on each other.",
    },
  ];
}

const noEntrypointDependency = {
  group: ["**/http/**", "**/mcp/**"],
  message:
    "Core and host code cannot depend on HTTP or MCP entrypoints; assemble them in server.ts.",
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-dev/**",
      "lib/**",
      "test-results/**",
      "playwright-report/**",
      "data/**",
      "coverage/**",
      "public/js/**/*.js",
      "scripts/**/*.js",
      "*.config.js",
      ":memory:/**",
      // Browser service worker — different globals, not worth wiring up here.
      "public/sw.js",
      // Theme initialization script — runs before TS bundle, plain JS.
      "public/theme-init.js",
      // CLI entry shim, plain JS.
      "bin/**",
      // Playwright config/spec files use a distinct test runner with its own globals.
      "playwright.config.ts",
      "test/e2e/*.spec.ts",
      "test/e2e/helpers.ts",
      "scripts/screenshots*.ts",
    ],
  },

  // Base
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // Type-aware setup
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Project-wide rules
  {
    rules: {
      // High value — error
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // Node's --experimental-strip-types only strips type annotations; it
      // cannot transform TS parameter properties and fails at startup.
      "@typescript-eslint/parameter-properties": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        // Allow `let x: typeof import("./foo")` inline type annotations;
        // common in tests that set up modules via dynamic await import().
        { disallowTypeAnnotations: false },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-implicit-coercion": "error",
      "prefer-const": "error",
      "no-console": "error",

      // Medium value — promoted to error (0 violations after cleanup)
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      complexity: ["error", { max: 20 }],
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "no-param-reassign": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/prefer-for-of": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",

      // Off — too noisy / not aligned with our style
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-empty-function": "off",
      // require-await fires on wrapper async functions that return Promises
      // without awaiting — too many legitimate cases (returning a promise
      // chain, satisfying an async interface). Off.
      "@typescript-eslint/require-await": "off",
      // restrict-template-expressions on `${err}` where err is unknown is
      // 99% noise and the fix (String(err)) reads worse. Allow common ones.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowAny: true,
          allowNullish: true,
        },
      ],
      "@typescript-eslint/restrict-plus-operands": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
    },
  },

  // src + scripts + bench: Node globals
  {
    files: ["src/**/*.ts", "scripts/**/*.{ts,js,mjs}", "bench/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    files: ["src/mcp/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/store.ts", "**/task-manager.ts"],
              message:
                "MCP code must use TaskOps from api/tasks.ts instead of importing local domain services.",
            },
            ...entrypointBoundary("http"),
          ],
        },
      ],
    },
  },

  {
    files: ["src/http/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: entrypointBoundary("mcp"),
        },
      ],
    },
  },

  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/server.ts",
      "src/http/**/*.ts",
      "src/mcp/**/*.ts",
      "src/task-manager.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [noEntrypointDependency],
        },
      ],
    },
  },

  {
    files: ["src/task-manager.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "./mcp/server.ts",
              allowImportNames: ["buildMcpServerEntry"],
              message:
                "TaskManager may use only its legacy buildMcpServerEntry import.",
            },
            {
              name: "./mcp/capability.ts",
              allowImportNames: ["CapabilityStore"],
              message:
                "TaskManager may use only its legacy CapabilityStore type import.",
            },
          ],
          patterns: [
            {
              group: [
                "**/http/**",
                "**/mcp/**",
                "!**/mcp/server.ts",
                "!**/mcp/capability.ts",
              ],
              message:
                "TaskManager has only two named MCP legacy dependencies and cannot depend on HTTP entrypoints.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["src/api/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noEntrypointDependency,
            {
              group: ["**/host/**", "**/store.ts", "**/task-manager.ts"],
              message:
                "api/** is a thin contract layer and cannot depend on entrypoints, Host implementations, or local persistence/runtime services.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["src/task-ops.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noEntrypointDependency,
            {
              group: ["**/host/**"],
              message:
                "Core code must use the neutral Host port from api/**, not concrete Host implementations.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["src/host/remote/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noEntrypointDependency,
            {
              group: [
                "**/store.ts",
                "**/task-manager.ts",
                "**/host/local/**",
                "../local/**",
              ],
              message:
                "Remote host code cannot depend on local task persistence, runtime services, or local adapters.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["src/host/local/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            noEntrypointDependency,
            {
              group: ["**/host/remote/**", "../remote/**"],
              message:
                "Local host code cannot depend on remote host implementations.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["src/shared/sync/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "node:*",
                "better-sqlite3",
                "**/store.ts",
                "**/task-manager.ts",
                "**/host/**",
              ],
              message:
                "shared/sync must remain platform-neutral and depend only on injected transport, persistence, and timer ports.",
            },
          ],
        },
      ],
    },
  },

  // public/js: browser globals + strict console ban.
  // Convention (CLAUDE.md): use `log.*` (public/js/log.ts) so entries appear
  // in the inline debug panel. console.* bypasses that channel entirely.
  // The project-wide allow list (warn/error/info) is overridden here.
  {
    files: ["public/js/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Injected by esbuild `define` for browser bundles, by
        // test/frontend-setup.ts (`globalThis.__DEV__ = true`) for the node
        // test runtime. See public/js/render-event.ts for usage.
        __DEV__: "readonly",
      },
    },
    rules: {
      "no-console": "error",
      // Ban direct `dom.input.value = ...` assignment. Programmatic value
      // writes don't fire the "input" event, which means the send button,
      // slash menu, and bash-mode toggle silently go out of sync. Always
      // route through setInputValue() in state.ts (which dispatches the
      // event so listeners re-run).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression[left.type='MemberExpression'][left.property.name='value'][left.object.type='MemberExpression'][left.object.object.name='dom'][left.object.property.name='input']",
          message:
            "Use setInputValue() from state.ts instead of assigning dom.input.value directly; direct assignment does not fire 'input' and leaves send button / slash menu / bash-mode out of sync.",
        },
      ],
    },
  },

  // Share viewer must funnel ALL content event rendering through render-event.ts
  // (the shared dispatcher used by both main app and viewer). Any local switch
  // over the event type in viewer.ts means we're rebuilding DOM in a second
  // place, which is exactly the drift the shared module exists to prevent.
  // Allowed: switching on `ev.type` is fine in event-interpreter.ts (which is
  // pure data) or in events.ts (which has additional live-only side effects),
  // but NOT in the viewer.
  {
    files: ["public/js/share/viewer.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "SwitchStatement > MemberExpression.discriminant[property.name='type']",
          message:
            "Do not switch on event.type in viewer.ts — route ALL content-event rendering through renderContentEvent() in render-event.ts so viewer and main app cannot drift. Add new event types to CONTENT_EVENT_TYPES in render-event.ts instead.",
        },
        {
          selector:
            "SwitchStatement > MemberExpression.discriminant[property.name='kind']",
          message:
            "Do not switch on event.kind in viewer.ts — route through renderContentEvent() in render-event.ts.",
        },
      ],
    },
  },

  // Tests + bench: relax noisy rules (mocks, dynamic JSON, console.log fine)
  {
    files: ["test/**/*.ts", "bench/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "no-console": "off",
    },
  },

  // E2E support entrypoints run directly under `node --experimental-strip-types`
  // (seed.ts from playwright.config.ts, mock-agent.ts via config.e2e.toml).
  // Keep them linted for strip-types-incompatible syntax such as parameter
  // properties, but relax noisy style rules because the broader E2E suite is
  // intentionally excluded from project lint.
  {
    files: ["test/e2e/seed.ts", "test/e2e/mock-agent.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "no-console": "off",
      "@typescript-eslint/prefer-readonly": "off",
      "@typescript-eslint/return-await": "off",
    },
  },

  // CLI / bootstrap files: console.log is the intended user-facing output.
  // - daemon.ts: CLI commands (start/stop/status/restart) emit human-readable
  //   text to the operator's terminal — UX, not service runtime debug.
  // - server.ts: operational lifecycle output (listen, shutdown, bridge start)
  //   visible to whoever launched the process. Runtime debug callbacks inside
  //   server.ts use `log.scope(...)`.
  // - config.ts: bootstrap output, runs before setLogLevel() can be called.
  // - preflight.ts: same — runs even before config-derived log level is
  //   applied, and the whole point is operator-facing ✓/✗ lines.
  {
    files: [
      "src/daemon.ts",
      "src/server.ts",
      "src/config.ts",
      "src/preflight.ts",
      "src/startup-checks.ts",
      "scripts/**/*.ts",
    ],
    rules: { "no-console": "off" },
  },

  // File length: a ratchet. Global caps count code lines only. Files already
  // over a cap are pinned at their current size below; they may shrink, never
  // grow. When a split shrinks one, lower its pin in the same change; delete
  // the pin once the file is under the global cap.
  {
    files: ["src/**/*.ts", "public/js/**/*.ts", "scripts/**/*.ts"],
    rules: { "max-lines": ["error", maxLines(800)] },
  },
  {
    files: ["test/**/*.ts", "bench/**/*.ts"],
    rules: { "max-lines": ["error", maxLines(1500)] },
  },
  ...Object.entries({
    "src/store.ts": 3079,
    "src/http/routes.ts": 3643,
    "src/task-manager.ts": 3279,
    "public/js/events.ts": 2323,
    "src/bridge.ts": 1046,
    "public/js/slash-commands.ts": 1020,
    "src/share/routes.ts": 975,
    "public/js/markdown-stream.ts": 965,
    "public/js/state.ts": 884,
    "public/js/task-command.ts": 854,
    "test/events.test.ts": 7026,
    "test/task-manager.test.ts": 2741,
    "test/link-sync.test.ts": 2210,
    "test/tasks.test.ts": 1972,
    "test/mcp-task-host.test.ts": 1953,
    "test/store.test.ts": 1888,
    "test/e2e/mock-agent.ts": 1678,
  }).map(([file, max]) => ({
    files: [file],
    rules: { "max-lines": ["error", maxLines(max)] },
  })),

  // Final: turn off rules that conflict with prettier (formatting)
  prettier,
);
