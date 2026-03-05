# Agent Web

通过浏览器远程使用 Copilot CLI 的 Web 应用，基于 ACP (Agent Client Protocol)。

技术栈：Node.js + TypeScript（`--experimental-strip-types`），WebSocket（`ws`）通信，SQLite（`better-sqlite3`）持久化，Zod 校验。

核心模块：
- `server.ts` — HTTP/WebSocket 服务端 + 图片上传 API
- `bridge.ts` — ACP 桥接，管理 Copilot CLI 子进程
- `store.ts` — SQLite 数据持久化（sessions + events 表）
- `public/index.html` — 单文件前端（无构建步骤）

生产通过 macOS launchd 服务运行（端口 6800），支持 Cloudflare Tunnel 远程访问。

## Service Management

Use npm scripts for prod service control:

```bash
npm run svc:restart   # restart prod
npm run svc:stop      # stop prod
npm run svc:status    # check status
```

Do NOT use `start.sh` directly.

## Development

```bash
npm run dev           # dev server on port 6801, uses data-dev/
```

## Architecture Notes

- **Single bridge**: One `CopilotBridge` instance per server, multiple sessions multiplexed over it.
- **Session restore**: `bridge.loadSession()` restores ACP context after server restart. During restore, `restoringSessions` Set suppresses duplicate event storage/broadcast.
- **Pre-warmed session**: A session is pre-created at startup for instant `/new`. Reused if CWD matches, otherwise new one created on demand.
- **Auto-resume**: Frontend auto-resumes last active session on page open (no hash → fetch `/api/sessions` → resume most recent).
- **Event aggregation**: `message_chunk` / `thought_chunk` are buffered in memory, flushed to DB as full `assistant_message` / `thinking` on boundaries (tool_call, plan, prompt_done).
- **Title generation**: Uses a dedicated silent session with fast model (Haiku), async and non-blocking.

## Frontend Conventions

- **Single HTML file** — all JS/CSS inline, no build tools.
- **Terminal aesthetic** — monospace fonts, `^C` / `^U` style button labels, `*` git-branch-style session markers.
- **Keyboard shortcuts** — `Ctrl+C` cancel, `Ctrl+U` upload. Enter only sends (never cancels).
- **Theme** — dark/light/auto, persisted to localStorage.
