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

```bash
# 开发模式（文件变更自动重启）
npm run dev

# 生产模式
npm start

# 后台运行（关终端不退出）
nohup npm start > agent-web.log 2>&1 &
echo $! > .pid

# 查看日志
tail -f agent-web.log

# 停止
kill $(cat .pid)
```

然后打开 http://localhost:6800

## 通过 Cloudflare Tunnel 远程访问

在 cloudflared 的 ingress 配置中加入：

```yaml
- hostname: agent.yourdomain.com
  service: http://host.docker.internal:6800
```

然后浏览器访问 `https://agent.yourdomain.com`。
