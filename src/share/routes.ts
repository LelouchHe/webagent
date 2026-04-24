import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../store.ts";
import type { Config } from "../config.ts";

export interface ShareRouteDeps {
  store: Store;
  config: Config["share"];
}

/**
 * Dispatch share-related routes (/s/*, /api/v1/sessions/:id/share*,
 * /api/v1/shares*). Returns true if the route was handled (response
 * ended) so the main router can short-circuit; false otherwise.
 *
 * When `config.enabled === false`, always returns false — share routes
 * are invisible. Real handlers land in C2-C4; this skeleton only claims
 * the URL space so accidental collisions surface early in dev.
 */
export async function handleShareRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ShareRouteDeps,
): Promise<boolean> {
  if (!deps.config.enabled) return false;

  const url = req.url ?? "/";

  // Viewer HTML — real shell lands in C2.
  if (url === "/s" || url.startsWith("/s/") || url.startsWith("/s?")) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("share viewer not yet implemented");
    return true;
  }

  // Owner-side: /api/v1/sessions/:id/share, /api/v1/sessions/:id/share/publish
  // Listing:    /api/v1/shares, /api/v1/shares/:token
  // Public:     /api/v1/shared/:token, /api/v1/shared/:token/events
  // Real handlers land in C3/C4.
  if (
    /^\/api\/v1\/sessions\/[^/]+\/share(?:\/|$|\?)/.test(url) ||
    url === "/api/v1/shares" ||
    url.startsWith("/api/v1/shares/") ||
    url.startsWith("/api/v1/shared/")
  ) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "share API not yet implemented" }));
    return true;
  }

  return false;
}
