# Agent Web

通过浏览器远程使用 Copilot CLI 的 Web 应用，基于 ACP (Agent Client Protocol)。

技术栈：Node.js + TypeScript（`--experimental-strip-types`），WebSocket（`ws`）通信，SQLite（`better-sqlite3`）持久化，Zod 校验。

核心模块：
- `server.ts` — HTTP/WebSocket 服务端
- `bridge.ts` — 浏览器与 Copilot CLI 之间的 ACP 桥接
- `store.ts` — SQLite 数据持久化

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
