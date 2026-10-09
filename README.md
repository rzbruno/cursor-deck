# ⚡ Cursor Agent — Mobile Web Control Panel

A self-hosted, mobile-first web control panel running on your laptop that lets you drive the **Cursor CLI (`agent`)** across your projects directly from an Android browser, without touching SSH or Termux.

---

## 🌟 Key Features

* **Tailscale Private Networking**:
  * Auto-detects your laptop's private Tailscale IP (`100.64.0.0/10`).
  * Supports `--tailscale-only` network enforcement to reject all non-Tailscale incoming traffic.
  * Prints an ASCII QR code directly into your terminal on startup—point your Android camera to connect instantly.
  * Zero port forwarding, zero public exposure, zero SSH keys on your mobile phone.

* **Shared Root Directory Architecture (`~/code`)**:
  * Designed to run at a shared parent folder (e.g. `~/code`) containing multiple independent projects.
  * Instant project switcher with bottom-sheet modal, fuzzy search filter, and Git branch / modified file badges.

* **Strict Target Scoping**:
  * Every CLI invocation and Git operation is strictly validated and scoped to `~/code/<selected-project>`.
  * Hardened against directory traversal attacks (`..`, symlinks, or cross-project path bleed). Cursor indexes only the chosen codebase.

* **Headless Process Execution**:
  * Spawns `agent -p --force --trust` with **detached stdin** (`stdio: ['ignore', 'pipe', 'pipe']`) to eliminate terminal prompt hangs.
  * **Single-Task Lock**: Strictly manages process locking (one task at a time) and prevents concurrent collisions (returns `409 Conflict` with active task details).
  * **Immediate Abort**: Instant abort button sends `SIGTERM` (and graceful `SIGKILL` fallback) to the process group.
  * **Multi-Turn Session Continuation**: Toggle switch in the prompt dock seamlessly appends `--continue` to continue prior conversations within the same project.

* **Resilient Mobile Log Streaming**:
  * Live log streaming powered by **Server-Sent Events (SSE)**.
  * **ANSI Escape Cleaner**: Cleans raw ANSI codes into styled HTML spans while stripping cursor jumps and carriage returns.
  * **Ring-Buffer Replay**: Keeps a 5,000-line memory ring buffer. If your Android phone locks its screen or hands off between Wi-Fi and mobile data, SSE reconnects automatically via `Last-Event-ID` and replays missed lines with zero dropped output.
  * Smart auto-scroll lock with a "↓ Follow live" pill if you scroll up to inspect previous output.
  * Integrated **Screen Wake Lock API** toggle to prevent your Android phone screen from dimming during long executions.

* **Local Git Controls (Zero Remote / Zero GitHub Account Required)**:
  * **Git Status Tab**: Displays staged, modified, and untracked files with status tags and stage/unstage buttons.
  * **Git Diff Tab**: Unified, syntax-highlighted diff viewer with addition/deletion line counters and collapsible files.
  * **Local Commit Box**: Make quick local checkpoint commits before running your next Cursor prompt.
  * **Emergency Discard**: Guarded danger button that runs `git reset --hard HEAD && git clean -fd` to instantly wipe changes made by Cursor.

---

## 🚀 Quick Start

### 1. Installation
Clone or navigate to this directory and install dependencies:
```bash
cd ~/code/cursor-agent
npm install
```

### 2. Launch the Control Panel
```bash
# Start with standard settings (auto-detects Tailscale IP and ~/code)
npm start
```

Or run via the CLI executable directly:
```bash
./bin/cursor-agent-web.js
```

### 3. CLI Options & Flags
```bash
./bin/cursor-agent-web.js [options]

Options:
  -p, --port <number>      HTTP port to listen on (default: 4040, env: PORT)
  -h, --host <ip>          Host address to bind (default: 0.0.0.0, env: HOST)
  -r, --root <path>        Root directory containing projects (default: ~/code, env: PROJECTS_ROOT)
  --tailscale-only         Restrict access exclusively to Tailscale IPs (100.64.0.0/10)
  -t, --token <secret>     Require authentication token/PIN for remote access
  --agent-cmd <command>    Custom Cursor CLI executable (default: agent)
  --help                   Show help message
```

#### Example: Tailscale-Only Mode with Auth Token
```bash
node bin/cursor-agent-web.js --tailscale-only --token mysecretpass
```

---

## 📱 Connecting from Android

1. Open your terminal where `cursor-agent-web` is running.
2. Scan the ASCII QR code printed in the terminal with your Android camera.
3. Your browser will open:
   ```text
   http://100.x.y.z:4040
   ```
4. **Optional PWA Experience**: Tap your browser's menu (⋮) and select **"Add to Home Screen"** or **"Install app"**. The control panel will run full-screen as a standalone web app with its own custom icon.

---

## 🧪 Testing

Run the automated test suite covering ANSI parsing, Tailscale IP validation, directory scoping, SSE ring buffer replay, and process locking:
```bash
npm test
```

---

## 🛠️ Architecture

```
cursor-agent/
├── bin/
│   └── cursor-agent-web.js       # CLI launcher, terminal banner & QR generator
├── src/
│   ├── server.js                 # HTTP server, REST router, SSE endpoint & static file server
│   ├── tailscale.js              # Tailscale CGNAT subnet validation & IP extraction
│   ├── project-manager.js        # Scans ~/code, target scoping & traversal security
│   ├── process-manager.js        # Spawns agent -p --force --trust, detached stdin, abort
│   ├── git-manager.js            # Scoped git status, unified diff, commit & emergency discard
│   ├── sse-hub.js                # Server-Sent Events hub with 5,000-event ring buffer
│   └── ansi-parser.js            # Terminal ANSI to sanitized HTML & plain text parser
├── public/
│   ├── index.html                # Responsive mobile-first single page app
│   ├── css/style.css             # Obsidian dark theme, glassmorphism, mobile ergonomics
│   ├── js/app.js                 # Frontend application logic, SSE client, Wake Lock
│   ├── manifest.json             # Web App Manifest for Android PWA installation
│   └── icons/icon.svg            # Vector icon
└── test/
    └── agent-server.test.js      # Unit and integration test suite
```

---

## 📄 License
MIT
