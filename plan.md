# Share feature implementation plan (合一个 draft PR)

> **Revised after rubber-duck critique(2026-04-24 00:40)**:把 CSP 前提左移到 C3,staleness/image-proxy/A1-inline-transform/owner-prefs 从 deferred 升为必做,inline fork 明确 scope cut(不假装 defer),`src/share/routes.ts` 在 C1 就抽出。C6 docs/smoke 合并进 C5,**5 commits**。

**Source of truth**: `~/mine/space/plan/WebAgent/share-plan.md` v10 / `share-ux.md` v0.13
**Tracking**: `~/mine/space/plan/WebAgent/share-dev.md`

## Scope

一个 draft PR(`origin/share` → `main`),**5 commits**。`[share] enabled = false` default,零用户可见副作用。

## 明确的 Scope Cut(显式砍,非 defer)

1. **Viewer 端 inline fork / 继续这里往下问**(share-ux §5.3):v1 需要新 backend API(fork session from share snapshot)+ clone semantics,webagent 暂无此能力。v1 **不做**,viewer footer 显式文案 `继续往下问功能 v2 提供`,UX 上诚实告知而非故作 "polish"。
2. **Viewer hover polish**(share-ux §5.1 美化项):基础渲染先出,hover 动画/按钮出现逻辑等 polish 留 v1.1。
3. **"继续这里往下问" Inline CTA**(v0.5 OT2 方案 X):同 #1 一起砍。

这 3 项进 `share-dev.md` "scope-cut" 列表,PR summary 里透明列出。其他 frozen 必须 v1 交付。

## Preliminary:兼容性 Spike(在 C1 动工前 ≤ 30 分钟)

**目标**:验证 `assertOwner` 的 `Origin + Sec-Fetch-Site` 硬检查在现有调用栈不误伤。

**测试矩阵**(全真实,不 mock):
| Caller | Expected Origin | Expected Sec-Fetch-Site |
|---|---|---|
| 同页面 `fetch('/api/...')` (current frontend) | present, same-origin | `same-origin` |
| 浏览器地址栏打开 index | - (not API) | - |
| Service Worker fetch (push register) | ? | ? |
| Playwright `page.goto('/')` | - | - |
| Playwright `page.evaluate(fetch(...))` | present, same-origin | `same-origin` |
| `curl http://localhost:6800/api/...` | absent | absent |
| Agent subprocess `curl` | absent | absent |

Spike 脚本:`test/share-auth-spike.ts` 临时文件,跑完删。

**若 SW fetch 不带 Origin**:扩展 assertOwner 放行"请求来源是我们自己的 SW 路径"—— 但这违反 spec,更可能是 **SW 根本不打 owner-only 路由**(SW 只调 `/api/beta/push/*`,这些不是 share owner 路由)。先验证。

## Commit 切分

### C1 — 地基 + share routes 抽层(spike 完后)

**Files**
- `src/config.ts` + Zod: 加 `[share]` section
  - `enabled: boolean = false`
  - `ttl_hours: number = 0` (0 = 永不过期; clamp Math.min(val, 168) if > 0)
  - `csp_enforce: boolean = true`
  - `viewer_origin: string | null = null` (null = same host)
  - `internal_hosts: string[] = []` (sanitizer 内网白名单)
- `config.toml` + `config.dev.toml` + `test/config-coverage.test.ts`
- `src/share/token.ts` + `test/share-token.test.ts`
- `src/share/auth.ts` + `test/share-auth.test.ts`(按 spike 结果决定白名单宽度)
- `src/store.ts`:
  - `shares` 表 DDL + `shares_one_active_preview` partial unique index
  - **owner_prefs 表**(key-value):`{ scope, key, value, updated_at }`,用于 display_name 默认值、上次 `/by` 选择的持久化
  - CRUD helpers(见前版 plan 同样列表)+ `getOwnerPref` / `setOwnerPref`
- `src/share/routes.ts` 骨架:
  ```ts
  export function handleShareRoutes(req, res, ctx): boolean { return false; }  // C1 空实现
  ```
  在 `src/routes.ts` 顶部加一次挂接(`if (await handleShareRoutes(...)) return;`),但 `enabled=false` 时直接 return false(不影响任何现有请求)
- `test/share-store.test.ts` + `test/share-routes-skeleton.test.ts`(断言 skeleton 不 intercept 现有路由)

### C2 — sanitize + preview + CSP viewer shell 前提

**Files**
- `src/share/sanitize.ts`:
  - `const SANITIZER_VERSION = "2026-04-24"`
  - `sanitizeEventsForShare({events, cwd, homeDir, internalHosts})`
  - Layer1a 结构化改写 / Layer1b redact+flag / Layer1c hard-reject
- `test/share-sanitize.test.ts`:
  **强制向量集**(owner overlay + public viewer 均测):
  - `<script>alert(1)</script>` 原生 HTML
  - `<img src=x onerror=alert(1)>` 事件属性
  - `<svg onload=alert(1)>` / `<svg><script>` 
  - `<iframe srcdoc="...">` / `<math>` / `xlink:href`
  - `[x](javascript:alert(1))` markdown link
  - `![x](data:image/svg+xml,<svg onload=alert(1)>)` md image
  - `javascript:` / `data:` / `vbscript:` / `blob:` / 前置空格 / 大小写混合 / entity 编码
  - `<a href=javascript:...>` raw markdown HTML
  - `display_name` / `owner_label` / `session title` 含 HTML → 断言 DOM 无 script / on* / 危险 scheme
- `src/share/projection.ts` + `test/share-projection.test.ts`:LRU 容量 100,key `session_id:hash:VERSION`
- `src/share/mutex.ts` + `test/share-mutex.test.ts`
- **SessionManager 扩展**(非 event-handler):`flushBufferedChunks(sessionId): lastSeq`,复用现有 `/events` 中途 flush 的触发点(已有 invariant,不新增)
- Routes(在 `src/share/routes.ts`):
  - `POST /api/v1/sessions/:id/share`
  - `GET /api/v1/sessions/:id/share/preview`(X-Share-Token header)
- **Viewer shell 前提(为 C3 铺路)**:
  - `public/share-viewer.html` 独立 HTML shell(**不复用** `index.html`,避免继承 CDN script + inline)
  - 更新 `scripts/build.js` 支持多 entry,bundle share-viewer 独立
  - **Self-host** `marked` / `DOMPurify`:改 esbuild bundle 配置,不 external 这两个(至少对 share-viewer entry 不 external)
  - 验证:`grep -r 'cdn.jsdelivr\|unpkg' public/share-viewer.html` = 空
  - `grep -r '<script>' public/share-viewer.html` = 空(仅 `<script src="...">` external)
- Frontend:
  - `public/js/share/` 新模块
  - `/share` slash command(含 preview overlay 打开逻辑)
  - overlay sticky bar **含 staleness 精确文案**:
    ```
    ⚠ 此 preview 锚在 #<N> events · <X> 前创建;之后新增 <M> 条 events 不在快照内
      /publish  →  冻结旧锚点,这 <M> 条新内容永不进此链接(token 不变)
      /discard  →  丢弃此 preview,然后回原 session 再敲 /share 建含最新内容的新快照(新 token)
    ```
  - redact 三层视觉(CSS classes,非 HTML in sanitized content)
  - `[reuse preview] toast`: `复用 <X> 分钟前的 preview(快照落后 <M> 个事件);sticky bar 查看详情`
- E2E: `test/e2e/share-preview.spec.ts` — create preview / overlay open / token-never-in-URL / X-Share-Token header present / staleness text

### C3 — publish + 完整 public viewer + image proxy

**Files**
- Routes(`src/share/routes.ts`):
  - `POST /api/v1/sessions/:id/share/confirm` — 激活,body `{ token, display_name?, owner_label? }`。display_name/owner_label 写 owner_prefs 持久化,作为下次默认
  - `GET /s/:token` — HTML shell,CSP 头(路由级,仅此处 + shared JSON)
  - `GET /api/v1/shared/:token/events` — JSON 
  - `GET /s/:token/images/:file` — **image token-scoped proxy**(token → session_id → data/uploads/... ),绝不 bypass 原 `/api/v1/sessions/:id/images/*`
  - 410/404 guards
- `public/js/share/viewer.ts`:
  - 终端风 read-only 渲染,复用 `event-interpreter.ts` 的纯函数
  - 图片 URL 重写到 `/s/:token/images/:file`(share-plan §4.5)
  - Footer 显式 `继续往下问功能 v2 提供`(scope-cut 诚实透明)
- CSP 头(路由级):
  - 仅 `/s/:token` 和 `/api/v1/shared/:token/*` emit
  - `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; img-src 'self' data:; connect-src 'self'; style-src 'self'`(**无 unsafe-inline** — 若审计时发现 inline style 就拆出,不妥协)
  - `enforce=false` → `Content-Security-Policy-Report-Only`
- E2E: `test/e2e/share-publish.spec.ts`
  - full flow preview → publish → /s/:token renders
  - CSP header asserted
  - Browser console zero CSP violation(critical)
  - URL 无 session-id 泄漏
  - (如果 session 有 image)image 从 `/s/:token/images/` 加载,原 `/api/v1/sessions/:id/images/` 直连未授权返 401

### C4 — revoke + list + A1 inline + [shared] indicator

**Files**
- Routes(`src/share/routes.ts`):
  - `DELETE /api/v1/sessions/:id/share` — body `{ token }`, returns `{ ok, purge_status: 'skipped' }` (CF purge 留 v1.1,但契约字段保留)
  - `GET /api/v1/shares` — assertOwner, returns owner 所有 live shares
  - `PATCH /api/v1/sessions/:id/share` — owner_label 更新 + 完整 validation pipeline:
    - body schema / UTF-8 decode / 1024 byte cap(413) / ctrl-char 拒绝(`\x00-\x1f` 除 `\t`) / bidi override 拒绝(`U+202A..U+202E`, `U+2066..U+2069`)
- Frontend:
  - `/share list` slash menu — **独立 `.share-item` class**,不污染 `.slash-item` 基类(学 /inbox pattern,CLAUDE.md 已有踩坑教训)
  - **A1 inline row transform**(share-ux §4.6 必做):点 `[×]` → 该行 DOM 替换为 `⚠ 撤销后链接立即 410;Twitter 卡片不会重抓。 [确认撤销] [×取消]`,不用 window.confirm
  - `/share` 四态 dispatch(§2.1 四态矩阵)
  - `[shared]` static indicator beside session title(row.shared_at NOT NULL),点击 → open /share list
  - `/publish` / `/discard` / `/by` / `/label` preview 页命令实现 + autocomplete
- E2E: `test/e2e/share-list-revoke.spec.ts`,含 A1 inline transform 交互验证

### C5 — CSP enforce + xss-grep CI + docs + smoke

**Files**
- `test/xss-grep.test.ts` — CI gate:
  - scan `public/js/**` + `src/**`
  - 禁用 `innerHTML` / `insertAdjacentHTML` / `outerHTML` / `document.write` / `new Function` / `eval(` / `setTimeout(<string>` / `setInterval(<string>`
  - allowlist 通过 `// xss-ok: <reason>` 同行注释(test 正则扫)
  - 首次扫描 baseline:命中项 **全部在 C5 之前清完**(C2-C4 写代码时就 xss-ok 约束;C5 是 CI gate 而非 migration)
- `src/share/safe-url.ts` — `safeUrl(raw): string | null`:
  - 白名单 scheme `http` / `https` / `mailto` / `tel` / relative(`/` 开头)
  - 拒 `javascript` / `data` / `vbscript` / `blob` / `file`
  - 大小写 + leading whitespace + entity 编码归一化后再判
- `src/share/csp-report.ts` — `POST /api/v1/csp-report` handler(log-only, rate-limit 10/min/IP)
- E2E: `test/e2e/share-csp.spec.ts`
  - 每个 share viewer 打开,`page.on('console')` 断言无 CSP violation
  - header 断言
- `README.md` — Share feature 入口 + link to docs
- `docs/share.md` — new doc
- `CHANGELOG.md` — v1 entry
- `test/share-smoke.test.ts` — node:test integration:create → publish → fetch viewer → revoke → 410,一次搞定
- `test/doc-coverage.test.ts` 更新(如果 doc-coverage test 依赖文件清单)

## Review 节奏

- 本 plan 已过 rubber-duck critique(done)
- C1 done → `code-review`(auth / DDL / token)
- C2 done → `code-review`(sanitize XSS / LRU / CSP shell prep)
- C3 done → `code-review`(viewer / image proxy / CSP headers)
- C4 done → built-in self-review
- C5 done → `panel-review` verdict(integration + security)
- push 前最终 `panel-review` verdict

## Constraints / contracts

- 每个 commit 独立 `npm test` + `npm run test:e2e` 全绿
- Commit-level atomicity: 每个 commit 单独 revert 不破坏其他
- `[share] enabled = false` default,严格 zero user-visible change:
  - Share routes handler 顶部 `if (!config.share.enabled) return 410`
  - Slash commands 在 autocomplete 中隐藏(if enabled check)
  - CSP 头只在 share routes emit,**绝不全局 middleware**
  - 新 DDL `CREATE TABLE IF NOT EXISTS` 是唯一 startup 副作用,无害
- 最终 PR `--draft`

## 预期 LOC 规模(revised)

- C1 ~600(加了 owner_prefs 表 + share routes 骨架 + spike 结果内化)
- C2 ~1100(sanitize + XSS 向量 + viewer shell 前提 + multi-entry build)
- C3 ~700(viewer 完整 + image proxy + CSP 路由级头)
- C4 ~600(list + revoke + A1 inline + owner_label validation)
- C5 ~500(xss-grep + csp-report + docs + smoke)
- **Total ~3500 LOC**(按初估上界)

若 C2 因 XSS 测试 + viewer shell 前提爆到 >1500 LOC,拆分 C2a(sanitize+mutex+projection+routes)+ C2b(viewer shell prep + frontend overlay),成 6 commits。
