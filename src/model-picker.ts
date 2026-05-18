import type { ConfigOption } from "./types.ts";

/** Find the first available model whose id matches any pattern. */
export function pickModelByPatterns(
  configOptions: ConfigOption[],
  patterns: string[],
): string | null {
  const normalized = patterns
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (normalized.length === 0) return null;

  const modelOpt = configOptions.find((c) => c.id === "model");
  if (!modelOpt || modelOpt.options.length === 0) return null;

  for (const pattern of normalized) {
    const hit = modelOpt.options.find((o) =>
      o.value.toLowerCase().includes(pattern),
    );
    if (hit) return hit.value;
  }
  return null;
}
