import { readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";

export const ConfigSchema = z.object({
  port: z.number().int().positive().default(6800),
  data_dir: z.string().default("data"),
  default_cwd: z.string().default(process.cwd()),
  public_dir: z.string().default("dist"),
  agent_cmd: z.string().default("copilot --acp"),

  limits: z.object({
    bash_output: z.number().int().positive().default(1_048_576),   // 1 MB
    image_upload: z.number().int().positive().default(10_485_760), // 10 MB
    cancel_timeout: z.number().int().nonnegative().default(10_000), // 10s; 0 disables
    recent_paths: z.number().int().nonnegative().default(10),       // /new menu display limit; 0 = show all
    recent_paths_ttl: z.number().int().nonnegative().default(30),   // days before auto-cleanup; 0 = keep forever
  }).default({
    bash_output: 1_048_576,
    image_upload: 10_485_760,
    cancel_timeout: 10_000,
    recent_paths: 10,
    recent_paths_ttl: 30,
  }),

  push: z.object({
    vapid_subject: z.string().default("mailto:noreply@example.com"),
    global_visibility_suppression: z.boolean().default(true),
  }).default({
    vapid_subject: "mailto:noreply@example.com",
    global_visibility_suppression: true,
  }),

  // [title] — title generation sub-session configuration.
  // `model` is sent via setConfigOption; leave as empty string to skip
  // the call and inherit the session default (useful on CLIs that don't
  // expose claude-haiku-4.5).
  title: z.object({
    model: z.string().default("claude-haiku-4.5"),
  }).default({ model: "claude-haiku-4.5" }),

  // [debug] — frontend log level.
  // level ∈ off | debug | info | warn | error. Default "off".
  // Users can override per page-load via `?debug=<level>` in the URL,
  // or at runtime via the /debug slash command.
  debug: z.object({
    level: z.enum(["off", "debug", "info", "warn", "error"]).default("off"),
  }).default({ level: "off" }),

  // [messages] — external notifications primitive.
  // `unprocessed_ttl_days` caps how long an unbound message stays in the
  // inbox before TTL cleanup removes it. 0 = keep forever.
  messages: z.object({
    unprocessed_ttl_days: z.number().int().nonnegative().default(30),
  }).default({ unprocessed_ttl_days: 30 }),

  // [share] — public read-only session share links.
  // Default: disabled. Dogfood manually flips `enabled = true` after
  // CF Access bypass + Rate Limiting are configured. See docs/share.md.
  //   enabled        — master kill switch; when false, all share routes
  //                    return 410 and slash commands are hidden.
  //   ttl_hours      — global default TTL for public share links. 0 =
  //                    never expire (default). >0 is clamped to 168 (7d).
  //                    Per-share override via `shares.ttl_hours` column.
  //   csp_enforce    — true (default) emits Content-Security-Policy on
  //                    /s/* and /api/v1/shared/* routes. false emits
  //                    Content-Security-Policy-Report-Only for rollback.
  //   viewer_origin  — public viewer URL host; empty string = same as
  //                    webagent host (default). Useful if viewer is
  //                    behind a different CF Worker route (e.g.
  //                    "https://share.example.com").
  //   internal_hosts — sanitizer internal-domain allowlist; any token
  //                    matching these substrings gets rewritten to
  //                    `<internal-host>` before publishing.
  share: z.object({
    enabled: z.boolean().default(false),
    ttl_hours: z.number().int().nonnegative().default(0),
    csp_enforce: z.boolean().default(true),
    viewer_origin: z.string().default(""),
    internal_hosts: z.array(z.string()).default([]),
  }).default({
    enabled: false,
    ttl_hours: 0,
    csp_enforce: true,
    viewer_origin: "",
    internal_hosts: [],
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

function parseArgs(): string | null {
  const idx = process.argv.indexOf("--config");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return null;
}

export function loadConfig(): Config {
  const configPath = parseArgs();
  let raw: Record<string, unknown> = {};

  if (configPath) {
    try {
      const content = readFileSync(configPath, "utf-8");
      raw = parseTOML(content) as Record<string, unknown>;
      console.log(`[config] loaded: ${configPath}`);
    } catch (err) {
      console.error(`[config] failed to read ${configPath}:`, err);
      process.exit(1);
    }
  } else {
    console.log("[config] no --config provided, using defaults");
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error("[config] validation error:", result.error.format());
    process.exit(1);
  }

  _config = result.data;
  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error("Config not loaded. Call loadConfig() first.");
  return _config;
}
