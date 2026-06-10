# VibesCode — Browser Extension + MCP Agent v12

A browser extension that turns any AI chat (Gemini, ChatGPT, Claude, Perplexity) into a live coding agent connected to your local project via the official MCP protocol.

---

## What's New in v12

### Shell Power Tool
`shell` now accepts `cwd` and `timeout` parameters and runs with full permissions — pipes, redirects, `&&`, any runtime.

### Dynamic Project Root via MCP
The AI can now set its own project root mid-conversation using `set_root` or `detect_root` MCP tools. Just paste a path into the chat and it auto-detects.

### `list_mcp_tools` MCP Tool
The AI can call `list_mcp_tools` to see every registered operation — useful at the start of a session or after connecting to a new server.

### Rich `/ext/status`
`GET /ext/status` now returns:
```json
{
  "connected": true,
  "llm_state": "injectable",
  "is_generating": false,
  "send_button_status": "active",
  "send_button_active": true,
  "input_empty": true,
  "can_inject": true,
  "platform": "Claude",
  "page_url": "https://claude.ai/...",
  "stale": false
}
```

### Panel Upgrades
- 📁 button → paste any path to set project root instantly
- `$_` button → run any shell command from the panel
- 🔧 button → shows full tool list from `/tools`
- Live status bar shows LLM state + send button status with color codes

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
   Injects result into chat + submits
          │
          ▼
   AI sees the file content and continues working
```

---

## File Structure

```
vibescode/
├── README.md
├── SYSTEM_PROMPT.md        ← paste into AI custom instructions
├── main.py                 ← FastAPI server
└── extension/
    ├── manifest.json
    ├── content.js          ← MCP client + AI interceptor + heartbeat + panel
    └── background.js       ← config storage only
```

---

## Quick Start

```bash
pip install fastapi uvicorn fastmcp anyio

export VIBESCODE_PROJECT_ROOT=/path/to/your/project
export VIBESCODE_SECRET=mysecret     # optional auth

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Extension Setup

1. Chrome → `chrome://extensions/` → Enable Developer mode
2. Load unpacked → select `extension/` folder
3. Edit `content.js` line ~12 — set `MCP_BASE_URL` to your server
4. Paste `SYSTEM_PROMPT.md` into the AI's custom instructions
5. Open any supported AI chat and start working

---

## Setting the Project Root

**Via the AI (preferred — just tell it):**
> "My project is at C:\Users\me\Desktop\myapp"
> 
> → AI emits: `AGENT_CALL {"op":"detect_root","hint":"C:\\Users\\me\\Desktop\\myapp"}`

**Via the panel:** Click 📁 and paste any path

**Via API:**
```bash
# Set directly
curl -X POST http://localhost:8000/project/set \
  -d '{"path": "/home/user/myapp"}'

# Auto-detect from any file inside the project
curl -X POST http://localhost:8000/project/detect \
  -d '{"hint": "C:\\Users\\user\\Desktop\\myapp\\src\\index.tsx"}'
```

---

## Rich Status API

```bash
curl http://localhost:8000/ext/status
```

```json
{
  "connected": true,
  "stale": false,
  "tab_id": "a3f9c12b",
  "platform": "Claude",
  "page_url": "https://claude.ai/chat/...",
  "llm_state": "injectable",
  "is_generating": false,
  "send_button_status": "active",
  "send_button_active": true,
  "input_empty": true,
  "mcp_ready": true,
  "can_inject": true,
  "last_seen_s": 1.2,
  "queue_depth": 0,
  "inject_ack": {"id": "msg_7", "sent": true, "at": 1718000000.0}
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

**`send_button_status` values:**

| Status | Meaning |
|--------|---------|
| `active` | Button found and clickable |
| `disabled` | Button found but grayed out (input may be empty) |
| `not_found` | No send button detected on the page |
| `unknown` | Not yet determined |

---

## Push Messages from API / CI

```bash
# Simple push
curl -X POST http://localhost:8000/push/send \
  -H "Content-Type: application/json" \
  -d '{"text": "Run tests and fix failures.", "submit": true}'

# With auth
curl -X POST http://localhost:8000/push/send \
  -H "X-Token: mysecret" \
  -d '{"text": "Deploy failed. Check logs at /var/log/app.log"}'

# Fill input only (let user review)
curl -X POST http://localhost:8000/push/send \
  -d '{"text": "Review these changes.", "submit": false}'
```

**From Python:**
```python
from main import push_to_extension

push_to_extension("Run pytest and fix any failures.")
push_to_extension("Review these changes before committing.", submit=False)
```

---

## Shell Examples the AI Can Run

```
# Any runtime
AGENT_CALL {"op":"shell","cmd":"pip install -r requirements.txt"}
AGENT_CALL {"op":"shell","cmd":"npm install && npm run build"}
AGENT_CALL {"op":"shell","cmd":"cargo build --release","timeout":300}
AGENT_CALL {"op":"shell","cmd":"go test ./..."}

# Django
AGENT_CALL {"op":"shell","cmd":"python manage.py makemigrations && python manage.py migrate"}
AGENT_CALL {"op":"shell","cmd":"python manage.py collectstatic --noinput"}

# Search
AGENT_CALL {"op":"shell","cmd":"grep -r 'TODO' src/ --include='*.py'"}
AGENT_CALL {"op":"shell","cmd":"find . -name '*.log' -mtime -1"}

# Git
AGENT_CALL {"op":"shell","cmd":"git add . && git commit -m 'fix: resolve failing tests'"}
AGENT_CALL {"op":"shell","cmd":"git stash && git pull && git stash pop"}

# Custom cwd
AGENT_CALL {"op":"shell","cmd":"ls -la","cwd":"/var/log"}
```

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
| GET | `/ext/status` | Rich extension + LLM state |
| GET | `/project/root` | Get current project root |
| POST | `/project/set` | Set project root at runtime |
| POST | `/project/detect` | Auto-detect root from hint path |
| GET | `/health` | Full health check |
| GET | `/tools` | List registered MCP tools (JSON) |
| GET | `/docs` | Swagger UI |

---

## MCP Tools Available to the AI

| Tool | Description |
|------|-------------|
| `set_root` | Set project root to any absolute path |
| `detect_root` | Auto-detect root from any file/folder path |
| `get_root` | Return current root |
| `list_mcp_tools` | List all tools with descriptions |
| `tree` | Recursive directory listing |
| `dir_list` | Immediate directory contents |
| `cat` | Read full file |
| `cat_range` | Read line slice |
| `search` | Regex search across files |
| `write` | Create or overwrite file |
| `patch` | Atomic find-and-replace |
| `mkdir` | Create directory |
| `delete` | Delete file |
| `shell` | Run any shell command |
| `run_tests` | Run test suite (auto-detects framework) |
| `lint` | Run linter (auto-detects framework) |
| `git_status` | Git status |
| `git_diff` | Git diff |
| `git_log` | Git history |
| `project_info` | Detect project type and file summary |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESCODE_PROJECT_ROOT` | `cwd` | Initial project root |
| `VIBESCODE_SECRET` | *(empty)* | Auth token for `/push/send` (`X-Token` header) |
| `PORT` | `8000` | Server port |

---

## Known Limitations

**Security**
- `shell` has no allowlist — the AI can run any command. Add a confirmation step before destructive operations in production environments.
- Set `VIBESCODE_SECRET` if the server is reachable from outside localhost.

**Reliability**
- Tool results are capped at 6000 chars. Large files are truncated — use `cat_range` to page through them.
- Push queue messages time out after 120s if the extension never reaches `injectable`.

**`execCommand` deprecation**
- Chrome is phasing out `document.execCommand`. The extension uses 4 injection strategies as fallback (execCommand → InputEvent → clipboard paste → force-assign).