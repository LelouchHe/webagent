import type { IncomingMessage, ServerResponse } from "node:http";
import { HTTP_STATUS } from "./http-status.ts";
import { log } from "./log.ts";

/**
 * The last-resort boundary around the async HTTP request handler.
 *
 * Route handlers decode URL segments and await storage/agent work; a malformed
 * percent-encoding throws `URIError`, and any unexpected throw rejects the
 * handler promise. Without this boundary Node treats the unhandled rejection as
 * fatal. URIError is a client error; anything else is logged and answered 500.
 * Once headers are sent there is no status left to write, so the response is
 * simply ended.
 */
export function withRequestErrorBoundary(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handler(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (err instanceof URIError) {
        res.writeHead(HTTP_STATUS.BAD_REQUEST, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "Invalid URL encoding" }));
        return;
      }
      log.error("request handler rejected", {
        method: req.method,
        url: req.url,
        error: err instanceof Error ? err.message : "unknown error",
      });
      res.writeHead(HTTP_STATUS.INTERNAL_SERVER_ERROR, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    });
  };
}
