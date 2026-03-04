# Agent Web

通过浏览器远程使用 Copilot CLI，基于 ACP (Agent Client Protocol)。

## 前置条件

- [fnm](https://github.com/Schniz/fnm) + Node.js (`fnm install --lts`)
- [copilot CLI](https://github.com/github/copilot-cli) 已安装并登录

## 安装

```bash
cd ~/mine/code/agent-web
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
tail -f agent-web.log
```

首次安装：
```bash
launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.lelouch.agent-web.plist
```

### 开发

```bash
npm run dev           # 端口 6801，文件变更自动重启
```

然后打开 http://localhost:6800

## 使用

在输入框中输入消息与 Copilot CLI 对话。支持以下 slash 命令：

| 命令 | 作用 |
|---|---|
| `/new [cwd]` | 新建 session（可选指定工作目录） |
| `/cwd` | 显示当前工作目录 |
| `/model [name]` | 查看或切换模型（支持模糊匹配，如 `/model opus`） |
| `/cancel` | 取消当前回复 |
| `/sessions` | 列出所有 session |
| `/switch <id>` | 切换到指定 session（前缀匹配） |
| `/help` | 显示命令列表 |

## 通过 Cloudflare Tunnel 远程访问

在 cloudflared 的 ingress 配置中加入：

```yaml
- hostname: agent.yourdomain.com
  service: http://host.docker.internal:6800
```

然后浏览器访问 `https://agent.yourdomain.com`。
