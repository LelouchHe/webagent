import { readFileSync } from "node:fs";
import { parse as parseTOML } from "smol-toml";
import { z } from "zod";

const ConfigSchema = z.object({
  port: z.number().int().positive().default(6800),
  data_dir: z.string().default("data"),
  default_cwd: z.string().default(process.cwd()),
  public_dir: z.string().default("dist"),
  agent_cmd: z.string().default("copilot --acp"),

  limits: z.object({
    bash_output: z.number().int().positive().default(1_048_576),   // 1 MB
    image_upload: z.number().int().positive().default(10_485_760), // 10 MB
    cancel_timeout: z.number().int().nonnegative().default(10_000), // 10s; 0 disables
  }).default({
    bash_output: 1_048_576,
    image_upload: 10_485_760,
    cancel_timeout: 10_000,
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
