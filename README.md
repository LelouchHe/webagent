# WebAgent

通过浏览器远程使用 Copilot CLI 的 Web 应用，基于 ACP (Agent Client Protocol)。

技术栈：Node.js + TypeScript（`--experimental-strip-types`，无需构建），WebSocket 实时通信，SQLite 持久化。

## 功能

### 对话

- 实时流式响应，支持 Markdown 渲染 + 代码高亮
- Thinking 过程可折叠展示
- 工具调用显示（状态动画、可展开详情、diff 渲染）
- Agent 执行计划展示（待定 ○ / 进行中 ◉ / 完成 ●）
- 敏感操作权限确认弹窗（Allow / Deny），跨设备同步

### 图片

- 上传图片（按钮或 `^U` 快捷键）
- 粘贴图片（Ctrl+V / Cmd+V）
- 发送前预览 + 可移除，支持多图
- 服务端存储，聊天中内联显示

### Bash 执行

- `!<command>` 直接执行 shell 命令
- 实时输出流（stderr 红色显示）
- 可折叠输出，显示退出码
- 支持取消运行中的进程

### Session 管理

- 打开页面自动恢复上次 session，无需手动切换
- 服务重启后通过 ACP `loadSession` 恢复 session 上下文，对话可继续
- 自动生成标题（使用快速模型异步生成）
- 历史 session 持久化（SQLite），重启不丢失
- `/sessions` 列出所有 session（git branch 风格，`*` 绿色标记当前）
- 切换 session 完整回放消息历史

### Slash 命令

输入 `/` 触发自动补全菜单（方向键导航，Tab 选择，Esc 关闭）。

| 命令 | 作用 |
|---|---|
| `/new [cwd]` | 新建 session（可选指定工作目录） |
| `/cwd` | 显示当前工作目录 |
| `/model [name]` | 查看或切换模型（支持模糊匹配，如 `/model opus`） |
| `/cancel` | 取消当前回复 |
| `/sessions` | 列出所有 session |
| `/switch <title\|id>` | 切换到指定 session（标题或 ID 前缀匹配） |
| `/delete <title\|id>` | 删除指定 session |
| `/help` | 显示帮助 |

### 快捷键

| 快捷键 | 作用 |
|---|---|
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Ctrl+C` | 取消当前回复 |
| `Ctrl+U` | 上传图片 |

### 主题

- 深色 / 浅色 / 跟随系统，点击 `◑` 切换
- 终端风格 UI（等宽字体、`>_` logo）
- 偏好保存到 localStorage

### 其他

- PWA 支持（可安装到主屏幕）
- WebSocket 自动重连（断线 3 秒重试）
- 30 秒心跳保活
- 输入框自动伸缩
- 自动滚动到底部
- 移动端适配

## 架构

```
浏览器 ←WebSocket→ server.ts ←ACP→ copilot CLI
                        ↕
                    store.ts (SQLite)
```

- **server.ts** — HTTP 静态文件 + WebSocket + 图片上传 API
- **bridge.ts** — ACP 桥接，管理 Copilot CLI 子进程，处理权限、文件读写
- **store.ts** — SQLite 持久化（sessions 表 + events 表，WAL 模式）

## 前置条件

- [fnm](https://github.com/Schniz/fnm) + Node.js 22.6+（需要 `--experimental-strip-types`）
- [Copilot CLI](https://github.com/github/copilot-cli) 已安装并登录

## 安装

```bash
npm install
```

## 运行

### 生产（launchd 服务）

服务通过 macOS launchd 管理，开机自启 + 崩溃自动重启，端口 6800。

```bash
npm run svc:status    # 查看状态
npm run svc:restart   # 重启（改完代码后）
npm run svc:stop      # 停止

# 查看日志
tail -f webagent.log
```

首次安装：
```bash
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.lelouch.webagent.plist
```

### 开发

```bash
npm run dev           # 端口 6801，使用 data-dev/，文件变更自动重启
```

## 通过 Cloudflare Tunnel 远程访问

在 cloudflared 的 ingress 配置中加入：

```yaml
- hostname: agent.yourdomain.com
  service: http://host.docker.internal:6800
```

然后浏览器访问 `https://agent.yourdomain.com`。
