// ESLint flat config (ESLint 9).
// All enabled rules are "error". Warnings are not used — if a rule is worth
// running, violations block the build; if it isn't, we turn it off.
// Prettier handles all formatting; eslint-config-prettier disables conflicting rules.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

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
      // CLI entry shim, plain JS.
      "bin/**",
      // Playwright config/spec files use a distinct test runner with its own globals.
      "playwright.config.ts",
      "test/e2e/**",
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
      "no-console": ["error", { allow: ["warn", "error", "info"] }],

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
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "no-param-reassign": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/prefer-for-of": "error",
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/prefer-readonly": "error",

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
        { allowNumber: true, allowBoolean: true, allowAny: true, allowNullish: true },
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

  // public/js: browser globals + strict console ban.
  // Convention (CLAUDE.md): use `log.*` (public/js/log.ts) so entries appear
  // in the inline debug panel. console.* bypasses that channel entirely.
  // The project-wide allow list (warn/error/info) is overridden here.
  {
    files: ["public/js/**/*.ts"],
    languageOptions: { globals: { ...globals.browser } },
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

  // CLI / bootstrap files: console.log is the intended user-facing output.
  {
    files: [
      "src/daemon.ts",
      "src/server.ts",
      "src/config.ts",
      "src/push-service.ts",
      "scripts/**/*.ts",
    ],
    rules: { "no-console": "off" },
  },

  // Final: turn off rules that conflict with prettier (formatting)
  prettier,
);
