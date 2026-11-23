import { spawn } from "node:child_process";

const TOKEN_COMMAND_TIMEOUT_MS = 5_000;
const TOKEN_COMMAND_MAX_BUFFER = 64 * 1024;

export class TokenCommandError extends Error {
  constructor() {
    super("token_command_failed");
    this.name = "TokenCommandError";
  }
}

export async function resolveHostToken(
  configured: string,
  timeoutMs = TOKEN_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  if (!configured.startsWith("!")) return configured;
  const child = spawn("/bin/sh", ["-c", configured.slice(1)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  const failure = { tooLarge: false, timedOut: false, aborted: false };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (Buffer.byteLength(output) > TOKEN_COMMAND_MAX_BUFFER) {
      failure.tooLarge = true;
      child.kill();
    }
  });
  const timeout = setTimeout(() => {
    failure.timedOut = true;
    child.kill();
  }, timeoutMs);
  timeout.unref();
  const onAbort = () => {
    failure.aborted = true;
    child.kill();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const spawnState = { failed: false };
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => {
      spawnState.failed = true;
    });
    child.once("close", resolve);
  });
  clearTimeout(timeout);
  signal?.removeEventListener("abort", onAbort);
  if (
    spawnState.failed ||
    failure.timedOut ||
    failure.aborted ||
    failure.tooLarge ||
    code !== 0
  ) {
    throw new TokenCommandError();
  }
  const token = output.trim();
  if (!token) throw new TokenCommandError();
  return token;
}
