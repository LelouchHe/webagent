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
 * Login URL for a freshly minted admin token. Token is placed ONLY in
 * the URL fragment so it never reaches the server in network requests
 * (Referer, access logs, proxy logs all stop at the path+query).
 */
export function buildBootstrapUrl(port: number, token: string): string {
  return `http://localhost:${port}/#t=${token}`;
}

/**
 * Banner printed to stdout on first-run mint. ANSI is gated on isTTY so
 * log capture / journald / supervisor pipes get plain text.
 */
export function formatBootstrapBanner(opts: {
  url: string;
  isTTY: boolean;
}): string {
  const { url, isTTY } = opts;
  const bold = isTTY ? "\x1b[1m" : "";
  const cyan = isTTY ? "\x1b[36m" : "";
  const dim = isTTY ? "\x1b[2m" : "";
  const reset = isTTY ? "\x1b[0m" : "";
  const lines = [
    "",
    `${bold}┌─ first-run ──────────────────────────────────────────────${reset}`,
    `${bold}│${reset}`,
    `${bold}│${reset}  Welcome. WebAgent has minted a one-time admin token`,
    `${bold}│${reset}  for this device. Open this URL in your browser:`,
    `${bold}│${reset}`,
    `${bold}│${reset}    ${cyan}${bold}${url}${reset}`,
    `${bold}│${reset}`,
    `${bold}│${reset}  ${dim}The token lives in the URL fragment (after \`#\`) and is${reset}`,
    `${bold}│${reset}  ${dim}never sent to the server in network requests.${reset}`,
    `${bold}│${reset}  ${dim}It still appears in your terminal scrollback — treat${reset}`,
    `${bold}│${reset}  ${dim}this URL like a password until you redeem it.${reset}`,
    `${bold}└──────────────────────────────────────────────────────────${reset}`,
    "",
  ];
  return lines.join("\n");
}
