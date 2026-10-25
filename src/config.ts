import { readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";

/** Agent ids are also display names and TOML table keys. */
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const AgentIdSchema = z
  .string()
  .regex(
    AGENT_ID_PATTERN,
    "agent id must match [a-z0-9][a-z0-9-]* (lowercase, digits, dashes)",
  );

/**
 * One configured local ACP CLI launch context. `cmd` is whitespace-split,
 * matching the bridge's existing launch behavior; paths containing spaces
 * are not supported.
 */
const AgentConfigSchema = z.strictObject({
  cmd: z.string().trim().min(1, "cmd must be a non-empty command string"),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ConfigSchema = z
  .object({
    port: z.number().int().positive().default(6800),
    // Network interface to bind. Default "127.0.0.1" = loopback only
    // (no LAN exposure). Set to "0.0.0.0" to bind all IPv4
    // interfaces, "::" for IPv6/dual-stack, or a specific NIC IP
    // (e.g. "192.168.1.10") to bind one interface on a multi-homed
    // host. Note: "localhost" works but resolves via DNS and may
    // pick IPv6 (`::1`) over IPv4 — prefer the explicit IP form.
    host: z.string().default("127.0.0.1"),
    data_dir: z.string().default("data"),
    default_cwd: z.string().default(process.cwd()),
    public_dir: z.string().default("dist"),

    // Required: the agent for a brand-new workspace and Root rebuild.
    // It is not "the current default" for existing tasks.
    default_agent: AgentIdSchema,
    // [agents.<id>] — at least one entry. The table key is the identity.
    // Root/nested tables stay lenient (unknown keys are stripped); each agent
    // entry is strict so `cmdd` typos fail.
    agents: z
      .record(AgentIdSchema, AgentConfigSchema)
      .refine((agents) => Object.keys(agents).length > 0, {
        message: "at least one [agents.<id>] entry is required",
      }),

    limits: z
      .object({
        bash_output: z.number().int().positive().default(1_048_576), // 1 MB
        image_upload: z.number().int().positive().default(10_485_760), // 10 MB
        file_upload: z.number().int().positive().default(52_428_800), // 50 MB — non-image attachments
        cancel_timeout: z.number().int().nonnegative().default(10_000), // 10s; 0 disables
        recent_paths: z.number().int().nonnegative().default(10), // /new + path-picker display limit; 0 = show all
        recent_paths_ttl: z.number().int().nonnegative().default(30), // days before auto-cleanup; 0 = keep forever
      })
      .default({
        bash_output: 1_048_576,
        image_upload: 10_485_760,
        file_upload: 52_428_800,
        cancel_timeout: 10_000,
        recent_paths: 10,
        recent_paths_ttl: 30,
      }),

    push: z
      .object({
        vapid_subject: z.string().default("mailto:noreply@example.com"),
        global_visibility_suppression: z.boolean().default(true),
      })
      .default({
        vapid_subject: "mailto:noreply@example.com",
        global_visibility_suppression: true,
      }),

    // [debug] — frontend log level.
    // level ∈ off | debug | info | warn | error. Default "off".
    // Users can override per page-load via `?debug=<level>` in the URL,
    // or at runtime via the /log slash command.
    debug: z
      .object({
        level: z.enum(["off", "debug", "info", "warn", "error"]).default("off"),
      })
      .default({ level: "off" }),

    // [messages] — external notifications primitive.
    // `unprocessed_ttl_days` caps how long an unbound message stays in the
    // inbox before TTL cleanup removes it. 0 = keep forever.
    messages: z
      .object({
        unprocessed_ttl_days: z.number().int().nonnegative().default(30),
      })
      .default({ unprocessed_ttl_days: 30 }),

    // [share] — public read-only task share links.
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
    share: z
      .object({
        enabled: z.boolean().default(false),
        ttl_hours: z.number().int().nonnegative().default(0),
        csp_enforce: z.boolean().default(true),
        viewer_origin: z.string().default(""),
        internal_hosts: z.array(z.string()).default([]),
      })
      .default({
        enabled: false,
        ttl_hours: 0,
        csp_enforce: true,
        viewer_origin: "",
        internal_hosts: [],
      }),

    // [auth] — bearer-token auth knobs.
    // first_run_bootstrap controls the zero-config first-run UX:
    //   true  (default) — when auth.json file does NOT exist AND stdin
    //                     is a TTY, server auto-mints a one-time admin
    //                     token and prints it as part of the startup-
    //                     doctor stream. Operator copies the token from
    //                     terminal scrollback and pastes it into the
    //                     /login form.
    //   false           — refuse to serve, print `--create-token` hint,
    //                     exit 78. Use this when deploying behind a
    //                     supervisor that provisions auth.json
    //                     out-of-band (CI, Ansible, k8s init container).
    // Either way: if auth.json exists but list is empty (deleted/parse-
    // error), server still exits 78 — that's a config anomaly, not a
    // fresh install.
    auth: z
      .object({
        first_run_bootstrap: z.boolean().default(true),
      })
      .default({ first_run_bootstrap: true }),
  })
  .superRefine((config, ctx) => {
    if (!(config.default_agent in config.agents)) {
      ctx.addIssue({
        code: "custom",
        path: ["default_agent"],
        message: `default_agent ${JSON.stringify(config.default_agent)} is not a configured [agents.<id>]`,
      });
    }
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
  return loadConfigFromPath(parseArgs());
}

/**
 * Load + validate config from an explicit path (or defaults if null).
 * Lets non-CLI callers (daemon parent) load the same effective config
 * the server would, without needing to mutate process.argv.
 */
export function loadConfigFromPath(configPath: string | null): Config {
  let raw: Record<string, unknown> = {};

  if (configPath) {
    try {
      const content = readFileSync(configPath, "utf-8");
      raw = parseTOML(content);
      console.log(`[config] loaded: ${configPath}`);
    } catch (err) {
      console.error(`[config] failed to read ${configPath}:`, err);
      process.exit(1);
    }
  } else {
    console.log("[config] no --config provided, using defaults");
  }

  // Refuse the pre-multi-agent shape explicitly. A strict object would also
  // reject this key, but a silent strip or a generic "unknown key" is worse
  // than naming the replacement. This runs before any startup side effect.
  if (Object.hasOwn(raw, "agent_cmd")) {
    console.error(
      "[config] `agent_cmd` is no longer supported. Define at least one " +
        '[agents.<id>] table with `cmd = "..."` and set `default_agent` to its id. ' +
        "See docs/configuration.md.",
    );
    process.exit(1);
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
