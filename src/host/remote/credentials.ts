import { spawn } from "node:child_process";

const TOKEN_COMMAND_TIMEOUT_MS = 5_000;
const TOKEN_COMMAND_MAX_BUFFER = 64 * 1024;

export class TokenCommandError extends Error {
  readonly retainedBytes: number;
  readonly terminationSignals: number;

  constructor(retainedBytes = 0, terminationSignals = 0) {
    super("token_command_failed");
    this.name = "TokenCommandError";
    this.retainedBytes = retainedBytes;
    this.terminationSignals = terminationSignals;
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
  let outputBytes = 0;
  const failure = { tooLarge: false, timedOut: false, aborted: false };
  let terminationSignals = 0;
  const terminate = () => {
    if (terminationSignals > 0) return;
    terminationSignals += 1;
    child.kill();
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (failure.tooLarge) return;
    const bytes = Buffer.byteLength(chunk);
    if (outputBytes + bytes > TOKEN_COMMAND_MAX_BUFFER) {
      failure.tooLarge = true;
      output = "";
      outputBytes = 0;
      terminate();
      return;
    }
    output += chunk;
    outputBytes += bytes;
  });
  const timeout = setTimeout(() => {
    failure.timedOut = true;
    terminate();
  }, timeoutMs);
  timeout.unref();
  const onAbort = () => {
    failure.aborted = true;
    terminate();
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
    throw new TokenCommandError(outputBytes, terminationSignals);
  }
  const token = output.trim();
  if (!token) throw new TokenCommandError(outputBytes, terminationSignals);
  return token;
}
