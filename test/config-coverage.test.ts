import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseTOML } from "smol-toml";
import type { z } from "zod";

/**
 * Staleness guard: Ensures config.toml and config.dev.toml stay in sync with
 * the schema in src/config.ts.
 *
 *  1. Every schema key (top-level + nested object fields) must appear in
 *     config.toml — either set live or present as a `# key =` commented stub.
 *     This catches "added a new key to the schema but forgot to document it".
 *
 *  2. Every value actually set (uncommented) in config.toml must equal the
 *     schema default for that key. config.toml's job is to document defaults;
 *     local overrides belong in a separate config (e.g. the service config).
 *     Keys without a schema default are skipped.
 *
 *  3. config.dev.toml must be a valid subset — every key it sets must be a
 *     real schema key. This catches typos like `[debug] enabled = true` that
 *     zod silently strips.
 */

const ROOT = join(import.meta.dirname, "..");

// ----- Schema walk ----------------------------------------------------------

type KeyInfo = {
  /** Dotted path, e.g. "limits.bash_output" or "port" */
  path: string;
  /** Section name (top level of TOML), e.g. "limits" or "" for top-level. */
  section: string;
  /** Leaf key name, e.g. "bash_output". */
  leaf: string;
  /** Default value if the schema provides one; undefined if optional/no default. */
  hasDefault: boolean;
  defaultValue?: unknown;
};

function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; defaultValue?: unknown } {
  let current: z.ZodTypeAny = schema;
  let def: unknown = undefined;
  let hasDef = false;
  for (;;) {
    const d = (
      current as unknown as {
        _def: { type: string; defaultValue?: unknown; innerType: z.ZodTypeAny };
      }
    )._def;
    if (d.type === "default") {
      hasDef = true;
      const dv = d.defaultValue;
      def = typeof dv === "function" ? (dv as () => unknown)() : dv;
      current = d.innerType;
    } else if (d.type === "optional") {
      current = d.innerType;
    } else {
      break;
    }
  }
  return hasDef ? { inner: current, defaultValue: def } : { inner: current };
}

function walkSchema(schema: z.ZodTypeAny): KeyInfo[] {
  const out: KeyInfo[] = [];
  const { inner: root } = unwrap(schema);
  const rootCtor = root.constructor.name;
  if (rootCtor !== "ZodObject") {
    throw new Error(`walkSchema: root must be a ZodObject, got ${rootCtor}`);
  }
  const shape = (root as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
  for (const [key, child] of Object.entries(shape)) {
    const { inner, defaultValue } = unwrap(child);
    if (inner.constructor.name === "ZodObject") {
      const subShape = (inner as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
      for (const [subKey, subChild] of Object.entries(subShape)) {
        const { defaultValue: subDefault } = unwrap(subChild);
        out.push({
          path: `${key}.${subKey}`,
          section: key,
          leaf: subKey,
          hasDefault: subDefault !== undefined,
          defaultValue: subDefault,
        });
      }
    } else {
      out.push({
        path: key,
        section: "",
        leaf: key,
        hasDefault: defaultValue !== undefined,
        defaultValue,
      });
    }
  }
  return out;
}

// ----- Config file parsing --------------------------------------------------

/**
 * Keys in config.toml that are intentionally commented-out despite having a
 * schema default. Two reasons qualify:
 *   - Runtime-dependent default (e.g. `default_cwd` = process.cwd()).
 *   - Long template-string default where literalising it in config.toml
 *     would hurt readability.
 * Keep this list tight — anything else should be live.
 */
const COMMENTED_OK = new Set<string>(["default_cwd"]);

/** True if `leaf` appears as a commented stub (`# leaf =`) in source. */
function sourceHasCommented(source: string, leaf: string): boolean {
  const re = new RegExp(`^\\s*#\\s*${leaf}\\s*=`, "m");
  return re.test(source);
}

/** True if `leaf` appears live (uncommented, `leaf =`) in source. */
function sourceHasLive(source: string, leaf: string): boolean {
  const re = new RegExp(`^\\s*${leaf}\\s*=`, "m");
  return re.test(source);
}

/** Extract just the `section` block (from `[section]` up to the next `[...]`). */
function sectionBlock(source: string, section: string): string {
  if (!section) {
    // Top-level: everything before the first `[...]` heading.
    const idx = source.search(/^\s*\[[^\]]+\]/m);
    return idx >= 0 ? source.slice(0, idx) : source;
  }
  const re = new RegExp(`^\\s*\\[${section}\\]`, "m");
  const m = re.exec(source);
  if (!m) return "";
  const rest = source.slice(m.index + m[0].length);
  const next = rest.search(/^\s*\[[^\]]+\]/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

// ----- Actual tests ---------------------------------------------------------

// Import schema asynchronously to avoid top-level await issues with node:test.
// We dynamically import inside the suite.

describe("config coverage", async () => {
  const { ConfigSchema } = (await import("../src/config.ts")) as unknown as {
    ConfigSchema: z.ZodTypeAny;
  };

  const mainSrc = readFileSync(join(ROOT, "config.toml"), "utf-8");
  const devSrc = readFileSync(join(ROOT, "config.dev.toml"), "utf-8");
  const mainParsed = parseTOML(mainSrc) as Record<string, unknown>;
  const devParsed = parseTOML(devSrc) as Record<string, unknown>;

  const keys = walkSchema(ConfigSchema);

  it("should find a reasonable number of schema keys", () => {
    assert.ok(keys.length >= 15, `Expected ≥15 schema keys, found ${keys.length}`);
  });

  // --- (1) config.toml coverage rules:
  //   - Keys with a schema default MUST be live (uncommented), except for
  //     runtime-dependent defaults listed in COMMENTED_OK (e.g. default_cwd).
  //   - Keys without a schema default (optional) may be live or commented,
  //     but must at least appear as a commented stub so users see the option.
  for (const k of keys) {
    it(`config.toml should cover "${k.path}"`, () => {
      const block = sectionBlock(mainSrc, k.section);
      const live = sourceHasLive(block, k.leaf);
      const commented = sourceHasCommented(block, k.leaf);
      if (k.hasDefault && !COMMENTED_OK.has(k.path)) {
        assert.ok(
          live,
          `Key "${k.path}" has a schema default — it must be LIVE (uncommented) ` +
            `in config.toml so users see the value. Found: ${commented ? "commented-only" : "missing"}.`,
        );
      } else {
        assert.ok(
          live || commented,
          `Key "${k.path}" not found in config.toml (section ${k.section || "<top-level>"}). ` +
            `Add it live or as a "# ${k.leaf} = ..." commented stub.`,
        );
      }
    });
  }

  // --- (2) Every live value in config.toml must equal schema default ---
  for (const k of keys) {
    if (!k.hasDefault) continue;
    const live = getLive(mainParsed, k.path);
    if (live === undefined) continue; // commented-out, skipped (covered by test 1)
    it(`config.toml value for "${k.path}" should equal schema default`, () => {
      assert.deepEqual(
        live,
        k.defaultValue,
        `config.toml has "${k.path}" = ${JSON.stringify(live)} but schema default is ` +
          `${JSON.stringify(k.defaultValue)}. config.toml documents defaults; ` +
          `put local overrides in a separate config file.`,
      );
    });
  }

  // --- (3) config.dev.toml must only use real schema keys ---
  const schemaKeySet = new Set(keys.map((k) => k.path));
  const devKeys = flattenKeys(devParsed);
  for (const dk of devKeys) {
    it(`config.dev.toml key "${dk}" should exist in schema`, () => {
      assert.ok(
        schemaKeySet.has(dk),
        `config.dev.toml sets "${dk}" but no such key exists in ConfigSchema. ` +
          `Zod silently strips unknown keys — fix the typo.`,
      );
    });
  }
});

function getLive(parsed: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = parsed;
  for (const p of parts) {
    if (cur === undefined || cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      out.push(...flattenKeys(v as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}
