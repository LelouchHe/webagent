import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.ts";
import type { Config } from "./config.ts";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function createRequestHandler(store: Store, publicDir: string, dataDir: string, limits: Config["limits"]) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = req.url ?? "/";

    // --- API routes ---
    if (url.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");

      // GET /api/sessions
      if (url === "/api/sessions" && req.method === "GET") {
        res.end(JSON.stringify(store.listSessions()));
        return;
      }

      // GET /api/sessions/:id/events?thinking=0|1
      const eventsMatch = url.match(/^\/api\/sessions\/([^/]+)\/events(\?.*)?$/);
      if (eventsMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(eventsMatch[1]);
        const params = new URLSearchParams(eventsMatch[2]?.slice(1) ?? "");
        const excludeThinking = params.get("thinking") === "0";
        const afterSeqRaw = params.get("after_seq");
        const afterSeq = afterSeqRaw != null ? Number(afterSeqRaw) : undefined;
        const session = store.getSession(sessionId);
        if (!session) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        const events = store.getEvents(sessionId, { excludeThinking, afterSeq });
        res.end(JSON.stringify(events));
        return;
      }

      // POST /api/images/:sessionId
      const imgMatch = url.match(/^\/api\/images\/([^/]+)$/);
      if (imgMatch && req.method === "POST") {
        const sessionId = decodeURIComponent(imgMatch[1]);
        if (!SAFE_ID.test(sessionId)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid session ID" }));
          return;
        }
        // Enforce upload size limit
        const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
        if (contentLength > limits.image_upload) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: "Upload too large" }));
          return;
        }
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > limits.image_upload) {
            res.writeHead(413);
            res.end(JSON.stringify({ error: "Upload too large" }));
            return;
          }
          chunks.push(chunk as Buffer);
        }
        let body: { data: string; mimeType: string };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const { data, mimeType } = body;
        const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        const seq = Date.now();
        const relPath = `images/${sessionId}/${seq}.${ext}`;
        const absPath = join(dataDir, relPath);
        await mkdir(join(dataDir, "images", sessionId), { recursive: true });
        await writeFile(absPath, Buffer.from(data, "base64"));
        const imgUrl = `/data/${relPath}`;
        res.end(JSON.stringify({ path: relPath, url: imgUrl }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // --- Serve uploaded images: /data/images/... ---
    if (url.startsWith("/data/images/")) {
      const filePath = join(dataDir, url.slice(6)); // strip "/data/"
      if (!filePath.startsWith(join(dataDir, "images"))) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      try {
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[ext] ?? "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    // --- Static files ---
    const filePath = join(publicDir, url === "/" ? "/index.html" : url);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  };
}
