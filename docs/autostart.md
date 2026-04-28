# Auto-Start on Boot

WebAgent's `start` command manages the server as a background daemon with
crash recovery, but does **not** configure auto-start on system boot.

Below are platform-specific recipes. In each example, replace the paths with
your actual install location and config file.

---

## macOS — launchd

Create `~/Library/LaunchAgents/com.webagent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.webagent</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/webagent</string>
        <string>--config</string>
        <string>/path/to/config.toml</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/path/to/working-directory</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/path/to/working-directory/webagent.log</string>
    <key>StandardErrorPath</key>
    <string>/path/to/working-directory/webagent.log</string>
</dict>
</plist>
```

Install and start:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.webagent.plist
```

Stop and unload:

```bash
launchctl bootout gui/$(id -u)/com.webagent
```

> **Note**: When using launchd, the service manager handles crash recovery and
> boot start directly — you do **not** need `webagent start`. Use the
> foreground command (`webagent --config config.toml`) in the plist, and let
> launchd manage the lifecycle.

---

## Linux — systemd (user)

Create `~/.config/systemd/user/webagent.service`:

```ini
[Unit]
Description=WebAgent
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/working-directory
ExecStart=/usr/local/bin/webagent --config /path/to/config.toml
Restart=on-failure
RestartSec=2s

StandardOutput=append:/path/to/working-directory/webagent.log
StandardError=append:/path/to/working-directory/webagent.log

[Install]
WantedBy=default.target
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now webagent
```

Check status / stop:

```bash
systemctl --user status webagent
systemctl --user stop webagent
```

> **Note**: Same as launchd — use the foreground command in `ExecStart` and let
> systemd handle restart and boot start.

---

## Linux / macOS — crontab

A lightweight alternative that works everywhere cron is available:

```bash
crontab -e
# Add this line:
@reboot cd /path/to/working-directory && webagent start --config /path/to/config.toml
```

This runs `webagent start` (the daemon mode with built-in crash recovery) once
at boot.

---

## Windows — Task Scheduler

Open **Task Scheduler** → Create Basic Task:

| Field     | Value                                                                        |
| --------- | ---------------------------------------------------------------------------- |
| Trigger   | **When the computer starts** (or **When I log on**)                          |
| Action    | **Start a program**                                                          |
| Program   | `node` (or full path to `node.exe`)                                          |
| Arguments | `C:\path\to\webagent\bin\webagent.mjs start --config C:\path\to\config.toml` |
| Start in  | `C:\path\to\working-directory`                                               |

Alternatively, use a PowerShell one-liner:

```powershell
$action = New-ScheduledTaskAction `
  -Execute "node" `
  -Argument "C:\path\to\webagent\bin\webagent.mjs start --config C:\path\to\config.toml" `
  -WorkingDirectory "C:\path\to\working-directory"

$trigger = New-ScheduledTaskTrigger -AtLogOn

Register-ScheduledTask -TaskName "WebAgent" -Action $action -Trigger $trigger
```

---

## Which approach to choose?

| Method                               | Crash recovery          | Boot start | Complexity |
| ------------------------------------ | ----------------------- | ---------- | ---------- |
| `webagent start` only                | ✓ (built-in supervisor) | ✗          | Lowest     |
| crontab `@reboot` + `webagent start` | ✓                       | ✓          | Low        |
| launchd / systemd (foreground mode)  | ✓ (OS-level)            | ✓          | Medium     |

For most users, `webagent start` is sufficient. Add a crontab `@reboot` line
if you need boot persistence. Use launchd/systemd only if you want full
OS-level service integration.
