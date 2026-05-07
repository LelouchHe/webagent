// Agent auto-detection.
//
// When `agent_cmd` is the sentinel "auto" (the new default), we scan PATH
// in two passes:
//
//   L1 — ACP-ready binaries that speak the protocol directly. First hit
//        wins; we return its exact run command. Order is by perceived
//        popularity / native-vs-wrapper, not alphabetical — see comments
//        on each row.
//
//   L2 — Bare vendor CLIs whose ACP support requires a separate adapter
//        package. We don't auto-`npx` them (silent network downloads /
//        supply-chain trust / startup latency are all real costs); we
//        just tell the user which adapter to install.
//
// If a user explicitly set `agent_cmd` in their TOML, this module is
// skipped — explicit config always wins. Detection is a first-run
// affordance, not a policy.

import { spawnSync } from "node:child_process";

export type DetectResult =
  | { ok: true; cmd: string; bin: string; label: string }
  | {
      ok: false;
      kind: "l2-hint";
      bin: string;
      label: string;
      adapter: string;
      install: string;
    }
  | { ok: false; kind: "none" };

interface L1 {
  bin: string;
  cmd: string;
  label: string;
}

interface L2 {
  bin: string;
  label: string;
  adapter: string;
  install: string;
}

// L1: ACP-ready binaries. Each row is "if `bin` is in PATH, run `cmd`".
// Verified against https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json.
export const L1_CANDIDATES: readonly L1[] = [
  { bin: "copilot", cmd: "copilot --acp", label: "GitHub Copilot CLI" },
  { bin: "gemini", cmd: "gemini --acp", label: "Gemini CLI" },
  { bin: "opencode", cmd: "opencode acp", label: "OpenCode" },
  {
    bin: "claude-agent-acp",
    cmd: "claude-agent-acp",
    label: "Claude Code (via ACP adapter)",
  },
  { bin: "codex-acp", cmd: "codex-acp", label: "Codex (via ACP adapter)" },
  {
    bin: "qwen",
    cmd: "qwen --acp --experimental-skills",
    label: "Qwen Code",
  },
] as const;

// L2: Bare vendor CLIs that need a separate adapter to speak ACP.
export const L2_CANDIDATES: readonly L2[] = [
  {
    bin: "claude",
    label: "Claude Code",
    adapter: "@agentclientprotocol/claude-agent-acp",
    install: "npm i -g @agentclientprotocol/claude-agent-acp",
  },
  {
    bin: "codex",
    label: "Codex",
    adapter: "@zed-industries/codex-acp",
    install: "npm i -g @zed-industries/codex-acp",
  },
] as const;

function inPath(bin: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(which, [bin], { stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function detectAgent(): DetectResult {
  for (const c of L1_CANDIDATES) {
    if (inPath(c.bin)) {
      return { ok: true, cmd: c.cmd, bin: c.bin, label: c.label };
    }
  }
  for (const c of L2_CANDIDATES) {
    if (inPath(c.bin)) {
      return {
        ok: false,
        kind: "l2-hint",
        bin: c.bin,
        label: c.label,
        adapter: c.adapter,
        install: c.install,
      };
    }
  }
  return { ok: false, kind: "none" };
}

// Format a multi-line, copy-pasteable hint for the operator. server.ts
// prints this verbatim and exits non-zero when detection fails.
export function formatDetectionFailure(
  result: Exclude<DetectResult, { ok: true }>,
): string {
  if (result.kind === "l2-hint") {
    return [
      `[bridge] detected ${result.label} (${result.bin}) but no ACP adapter.`,
      ``,
      `  Install the adapter to use ${result.label} with webagent:`,
      `    ${result.install}`,
      ``,
      `  Or set agent_cmd in config.toml to a different ACP agent.`,
    ].join("\n");
  }
  return [
    `[bridge] no ACP-ready agent found in PATH.`,
    ``,
    `  Install one of:`,
    `    npm i -g @github/copilot          # Copilot CLI`,
    `    npm i -g @google/gemini-cli       # Gemini CLI`,
    `    npm i -g opencode-ai              # OpenCode`,
    ``,
    `  Or for Claude Code / Codex, install the ACP adapter:`,
    `    npm i -g @agentclientprotocol/claude-agent-acp`,
    `    npm i -g @zed-industries/codex-acp`,
    ``,
    `  Then re-run webagent (or set agent_cmd in config.toml).`,
  ].join("\n");
}
