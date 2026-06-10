# VibesCode — Browser Extension + MCP Agent v11

A browser extension that turns any AI chat (Gemini, ChatGPT, Claude, Perplexity) into a live coding agent connected to your local project via the official MCP protocol. Works with **any project type** on **any drive** — Python, React, Next.js, Node, Rust, Go, and more.

---

## How It Works

```
You type a task in Gemini / ChatGPT / Claude
          │
          ▼
   AI responds with a tool call:
   AGENT_CALL {"op":"cat","path":"src/index.tsx"}
          │
          ▼  (MutationObserver collects ALL message nodes — never split)
   Extension → MCP JSON-RPC 2.0 → Your local server
          │
          ▼
   Server reads the file, returns content
          │
          ▼
   Extension checks LLM state → waits for "injectable"
          │
          ▼
   Injects result into chat + submits (4-strategy fallback)
          │
          ▼
   AI sees the file content and continues working
```

The server also has a **push channel** — send any message into the AI chat from curl, Python, CI/CD, or any HTTP client:

```bash
curl -X POST http://localhost:8000/push/send \
  -H "Content-Type: application/json" \
  -d '{"text": "Run the tests and fix any failures.", "submit": true}'
```

---

## File Structure

```
vibescode/
├── README.md                        ← this file
├── SYSTEM_PROMPT.md                 ← paste into AI custom instructions
│
├── main.py                          ← FastAPI server (single port, all features)
│
└── extension/
    ├── manifest.json
    ├── content.js                   ← MCP client + AI chat interceptor + heartbeat
    └── background.js                ← config storage only
```

---

## Quick Start

```bash
# Install dependencies
pip install fastapi uvicorn fastmcp anyio

# Optional: set initial project root (can be changed at runtime via API)
export VIBESCODE_PROJECT_ROOT=/path/to/your/project

# Optional: set a shared secret for /push/send auth
export VIBESCODE_SECRET=mysecret

# Run on port 8000
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Extension Setup

1. Open Chrome → `chrome://extensions/` → Enable **Developer mode**
2. Click **Load unpacked** → select the `extension/` folder
3. Edit `content.js` line 10 — set `MCP_BASE_URL` to your server address
4. Paste `SYSTEM_PROMPT.md` into the AI's custom instructions / system prompt
5. Open Gemini, ChatGPT, Claude, or Perplexity and start working

The terminal panel appears in the top-right corner of the page. It shows live LLM state, queue depth, MCP status, and a full log of every tool call.

---

## Setting the Project Root

The project root can be set **at runtime** without restarting the server. It accepts any absolute path on any drive.

**Via API:**
```bash
# Set directly
curl -X POST http://localhost:8000/project/set \
  -H "Content-Type: application/json" \
  -d '{"path": "C:\\Users\\luckey\\Desktop\\myreactapp"}'

# Auto-detect from any file inside the project
curl -X POST http://localhost:8000/project/detect \
  -H "Content-Type: application/json" \
  -d '{"hint": "C:\\Users\\luckey\\Desktop\\myapp\\src\\index.tsx"}'

# Check current root
curl http://localhost:8000/project/root
```

**Via the panel:** Click the 📁 button in the terminal panel header and paste any path.

`project/detect` walks up from the hint path looking for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `.git`, `manage.py`, and other project markers.

---

## Sending Messages to the AI from Your Backend

```bash
# curl
curl -X POST http://localhost:8000/push/send \
  -H "Content-Type: application/json" \
  -d '{"text": "The deploy finished. Check if /api/health returns 200.", "submit": true}'

# With auth token (if VIBESCODE_SECRET is set)
curl -X POST http://localhost:8000/push/send \
  -H "Content-Type: application/json" \
  -H "X-Token: mysecret" \
  -d '{"text": "Tests are failing in CI. Fix them."}'

# Fill input but don't submit — let user review first
curl -X POST http://localhost:8000/push/send \
  -d '{"text": "Review these changes before committing.", "submit": false}'
```

**From Python:**
```python
from main import push_to_extension

push_to_extension("Run pytest and fix any failures.")
push_to_extension("Review these changes before committing.", submit=False)
```

Messages are **queued server-side** and only injected when the extension reports the LLM is ready (`llm_state: "injectable"`). If the AI is currently generating, the message waits automatically — no manual timing needed.

---

## Checking Extension & LLM Status

```bash
# Full live status
curl http://localhost:8000/ext/status

# Full health (includes queue depth, tools list, project root)
curl http://localhost:8000/health
```

**`/ext/status` response:**
```json
{
  "connected": true,
  "stale": false,
  "tab_id": "a3f9c12b",
  "platform": "Gemini",
  "llm_state": "injectable",
  "mcp_ready": true,
  "can_inject": true,
  "last_seen_s": 1.2,
  "queue_depth": 0,
  "inject_ack": { "id": "msg_7", "sent": true, "at": 1718000000.0 }
}
```

**`llm_state` values:**

| State | Meaning |
|-------|---------|
| `generating` | AI is streaming a response right now |
| `idle` | AI finished; input box is empty |
| `injectable` | Safe to inject a new message |
| `injecting` | Extension is currently typing/sending |
| `unknown` | No heartbeat received yet |

`can_inject: true` means it is safe to send the next queued message right now.

The extension sends a heartbeat POST every 2 seconds. If no heartbeat arrives for 8 seconds, `connected` flips to `false` and `stale` to `true`.

---

## How the AI Calls Tools

Paste `SYSTEM_PROMPT.md` into the AI. The AI emits one-line tool calls:

```
AGENT_CALL {"op":"cat","path":"src/app/views.py"}
```

The extension intercepts this (MutationObserver on the full joined text of all AI message nodes — fixing the split-node parse error on Gemini), calls your MCP server via JSON-RPC 2.0, and injects the result back:

```
__TOOL_RESULT__
op: cat
# file contents here...
__END_RESULT__

Continue based on the result above.
```

---

## Available Tools

| op | Parameters | What it does |
|----|------------|--------------|
| `tree` | `path` | Recursive directory listing |
| `dir` | `path` | Immediate directory contents |
| `cat` | `path` | Read full file |
| `cat_range` | `path`, `start_line`, `end_line` | Read line slice |
| `search` | `pattern`, `path`, `extensions` | Regex search across files |
| `write` | `path`, `content` | Create or overwrite file |
| `patch` | `path`, `old_str`, `new_str` | Atomic find-and-replace |
| `mkdir` | `path` | Create directory |
| `delete` | `path` | Delete file |
| `shell` | `cmd`, `cwd` | Run any shell command (any runtime) |
| `run_tests` | `cmd`, `path` | Run tests — auto-detects npm/pytest/cargo/go |
| `lint` | `cmd`, `path` | Run linter — auto-detects eslint/clippy/flake8 |
| `git_status` | — | Git status |
| `git_diff` | `path`, `staged` | Git diff |
| `git_log` | `n`, `path` | Git history |
| `get_root` | — | Return current project root |
| `project_info` | — | Detect project type and file summary |

All `path` parameters accept **absolute paths on any drive** (`C:\...`, `D:\...`, `/home/...`) or paths relative to the project root.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/mcp/sse` | MCP SSE handshake |
| POST | `/mcp/messages` | MCP JSON-RPC tool calls |
| GET | `/push/stream` | Extension SSE channel |
| POST | `/push/send` | Enqueue message → AI chat |
| POST | `/push/ack` | Extension ACKs after inject |
| POST | `/ext/heartbeat` | Extension reports live state |
| GET | `/ext/status` | Poll extension + LLM state |
| GET | `/project/root` | Get current project root |
| POST | `/project/set` | Set project root at runtime |
| POST | `/project/detect` | Auto-detect root from hint path |
| GET | `/health` | Full health check |
| GET | `/tools` | List registered MCP tools |
| GET | `/docs` | Swagger UI |

---

## Supported AI Platforms

| Platform | Status |
|----------|--------|
| Gemini | ✅ |
| ChatGPT | ✅ |
| Claude.ai | ✅ |
| Perplexity | ✅ |
| Any chat UI | ✅ (Generic fallback) |

---

## Supported Project Types

Works on any project the shell can reach. `run_tests` and `lint` auto-detect:

| Stack | Test command | Lint command |
|-------|-------------|--------------|
| Python / Django / FastAPI | `pytest` | `flake8` |
| Node / React / Next.js | `npm test` | `npm run lint` / `eslint` |
| Vite / Vue / Nuxt | `npm test` | `npm run lint` |
| Rust | `cargo test` | `cargo clippy` |
| Go | `go test ./...` | — |
| Java (Maven) | `mvn test` via shell | — |
| Ruby | `bundle exec rspec` via shell | — |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESCODE_PROJECT_ROOT` | `cwd` | Initial project root |
| `VIBESCODE_SECRET` | *(empty)* | Shared token for `/push/send` auth (`X-Token` header) |
| `PORT` | `8000` | Server port |

---

## Known Limitations

**Security**
- `shell` has no command allowlist — the AI can run any shell command. Add a blocklist or confirmation step before running destructive commands in production.
- Set `VIBESCODE_SECRET` if the server is reachable from outside localhost.

**Reliability**
- Tool results are capped at 6000 chars. Large files are silently truncated — use `cat_range` to page through them.
- Push queue messages time out after 120 seconds if the extension never reaches `injectable` state (e.g. browser closed).

**`execCommand` deprecation**
- Chrome is phasing out `document.execCommand`. The extension has 4 injection strategies (execCommand → InputEvent → clipboard paste → force-assign) as fallback, but clipboard requires the `clipboardWrite` permission in `manifest.json`.