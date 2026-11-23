import { execFile } from "node:child_process";

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
  const command = configured.slice(1);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        encoding: "utf8",
        maxBuffer: TOKEN_COMMAND_MAX_BUFFER,
        timeout: timeoutMs,
        signal,
      },
      (error, output) => {
        if (error) {
          reject(new TokenCommandError());
          return;
        }
        resolve(output);
      },
    );
  });
  const token = stdout.trim();
  if (!token) throw new TokenCommandError();
  return token;
}
