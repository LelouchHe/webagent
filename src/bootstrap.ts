// First-run bootstrap policy + presentation.
//
// Pure functions only — no I/O, no globals. Side effects (token mint,
// stdout write, process exit) belong in server.ts; this module owns the
// decision and the banner formatting so tests can lock down behavior
// without spinning up a server.
//
// Decision matrix (decideBootstrap):
//   tokenCount > 0                                              → proceed
//   tokenCount = 0  +  authJsonExists                           → exit-config
//                      (file existed but parsed empty = config
//                       anomaly; do NOT silently re-mint admin)
//   tokenCount = 0  +  !authJsonExists  +  !isTTY               → exit-config
//                      (daemon path: user must use --create-token)
//   tokenCount = 0  +  !authJsonExists  +  isTTY  +  !enabled   → exit-config
//                      (operator opted out; preserve old UX)
//   tokenCount = 0  +  !authJsonExists  +  isTTY  +  enabled    → mint
//
// On mint, the banner prints the token verbatim and asks the operator
// to paste it into the /login form. We deliberately do NOT print a
// clickable URL with the token in the fragment: although fragments
// don't reach the server in HTTP requests, they do leak via browser
// history sync, history-permission extensions, and "looks like a link
// → click it" muscle memory. Plain-token + manual paste matches the
// existing `--create-token` flow's mental model.

export type BootstrapAction =
  | { kind: "mint" }
  | { kind: "exit-config" }
  | { kind: "proceed" };

export interface DecideInput {
  authJsonExists: boolean;
  tokenCount: number;
  isTTY: boolean;
  firstRunEnabled: boolean;
}

export function decideBootstrap(input: DecideInput): BootstrapAction {
  if (input.tokenCount > 0) return { kind: "proceed" };
  if (input.authJsonExists) return { kind: "exit-config" };
  if (!input.isTTY) return { kind: "exit-config" };
  if (!input.firstRunEnabled) return { kind: "exit-config" };
  return { kind: "mint" };
}

/**
 * Banner printed to stdout on first-run mint. Token is printed verbatim
 * and the operator is asked to paste it into the /login form. ANSI is
 * gated on isTTY so log capture / journald / supervisor pipes get plain
 * text.
 */
export function formatBootstrapBanner(opts: {
  token: string;
  port: number;
  isTTY: boolean;
}): string {
  const { token, port, isTTY } = opts;
  const bold = isTTY ? "\x1b[1m" : "";
  const cyan = isTTY ? "\x1b[36m" : "";
  const dim = isTTY ? "\x1b[2m" : "";
  const reset = isTTY ? "\x1b[0m" : "";
  const url = `http://localhost:${port}/`;
  const lines = [
    "",
    `${bold}┌─ first-run ──────────────────────────────────────────────${reset}`,
    `${bold}│${reset}`,
    `${bold}│${reset}  Welcome. WebAgent has minted a one-time admin token`,
    `${bold}│${reset}  for this device. Copy it and paste it into the`,
    `${bold}│${reset}  login form:`,
    `${bold}│${reset}`,
    `${bold}│${reset}    1. open ${cyan}${url}${reset} in your browser`,
    `${bold}│${reset}    2. paste this token:`,
    `${bold}│${reset}`,
    `${bold}│${reset}       ${bold}${cyan}${token}${reset}`,
    `${bold}│${reset}`,
    `${bold}│${reset}  ${dim}Treat this token like a password — it appears in${reset}`,
    `${bold}│${reset}  ${dim}your terminal scrollback. Revoke from /tokens later${reset}`,
    `${bold}│${reset}  ${dim}if needed.${reset}`,
    `${bold}└──────────────────────────────────────────────────────────${reset}`,
    "",
  ];
  return lines.join("\n");
}
