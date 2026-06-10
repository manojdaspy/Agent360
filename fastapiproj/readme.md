# VibesCode — Browser Extension + MCP Agent

A browser extension that turns any AI chat (Gemini, ChatGPT, Claude, Perplexity) into a live coding agent connected to your local project via the official MCP protocol.

---

## How It Works

```
You type a task in Gemini / ChatGPT / Claude
          │
          ▼
   AI responds with a tool call:
   AGENT_CALL {"op":"cat","path":"views.py"}
          │
          ▼ (MutationObserver intercepts)
   Extension → MCP JSON-RPC 2.0 → Your local server
          │
          ▼
   Server reads the file, returns content
          │
          ▼
   Extension injects result into chat input → submits
          │
          ▼
   AI sees the file content and continues working
```

The server also has a **push channel** — your backend can send any message into the AI chat at any time:

```python
push_to_extension("Run the tests and fix any failures.")
# → Extension types this into AI and presses Send
```

---

## File Structure

```
vibescode/
├── README.md                        ← this file
├── SYSTEM_PROMPT.md                 ← paste into AI custom instructions
│
├── server/
│   ├── main.py                      ← FastAPI entry point (single port, prod-ready)
│   └── tools.py                     ← all MCP tools (language-agnostic)
│
├── project_agent/                   ← Django integration (optional)
│   ├── mcp/
│   │   ├── server.py                ← standalone MCP server (port 8001)
│   │   └── urls.py                  ← mounting instructions
│   ├── views.py                     ← Django REST views
│   └── urls.py                      ← Django URL config
│
└── extension/
    ├── manifest.json
    ├── content.js                   ← MCP client + AI chat interceptor
    └── background.js                ← config storage only
```

---

## Quick Start

### Option A — FastAPI (recommended, single port, no Django needed)

```bash
# Install
pip install fastapi uvicorn mcp>=1.27 anyio

# Set your project root
export VIBESCODE_PROJECT_ROOT=/path/to/your/project

# Run everything on port 8000
uvicorn server.main:app --port 8000 --reload
```

Set in `extension/content.js`:
```javascript
const MCP_BASE_URL = "http://127.0.0.1:8000/mcp";
```

### Option B — Django + standalone MCP (current setup)

```bash
# Django on 8000
python manage.py runserver 8000

# MCP on 8001 (separate terminal)
export VIBESCODE_PROJECT_ROOT=/path/to/your/project
python -m project_agent.mcp.server
```

Set in `extension/content.js`:
```javascript
const MCP_BASE_URL = "http://127.0.0.1:8001";
```

---

## Extension Setup

1. Open Chrome → `chrome://extensions/` → Enable **Developer mode**
2. Click **Load unpacked** → select the `extension/` folder
3. Edit `content.js` line 21 to set `MCP_BASE_URL`
4. Paste `SYSTEM_PROMPT.md` into the AI's custom instructions / system prompt
5. Open Gemini, ChatGPT, Claude, or Perplexity and start working

---

## Pushing Messages from Your Server to the AI

From anywhere in your backend:

```python
# FastAPI / anywhere
from server.main import push_to_extension
push_to_extension("The deploy finished. Check if /api/health returns 200.")

# With submit=False — fills the input but waits for user to press Send
push_to_extension("Review these changes before committing.", submit=False)
```

Via HTTP (from any language, CI/CD, shell script):
```bash
curl -X POST http://127.0.0.1:8000/push/send \
  -H "Content-Type: application/json" \
  -d '{"text": "Tests are failing in CI. Fix them.", "submit": true}'
```

---

## How the AI Calls Tools

Paste `SYSTEM_PROMPT.md` into the AI. The AI will emit one-line tool calls:

```
AGENT_CALL {"op":"cat","path":"myapp/views.py"}
```

The extension intercepts this (MutationObserver on the chat DOM), calls your MCP server via JSON-RPC 2.0 over SSE, and injects the result back:

```
__TOOL_RESULT__
op: cat
# views.py content here...
__END_RESULT__

Continue based on the result above.
```

### Why this format never causes parse errors

- One line, `JSON.parse()` on the rest — either works completely or throws
- No markdown fences to strip
- No multi-line JSON to reassemble
- No brace counting, no regex, no unicode normalisation

---

## Available Tools

| op | Params | What it does |
|----|--------|--------------|
| `tree` | `path` | Recursive directory listing |
| `dir` | `path` | Immediate directory contents |
| `cat` | `path` | Read file |
| `search` | `pattern`, `path`, `extensions` | Regex search across files |
| `write` | `path`, `content` | Create or overwrite file |
| `patch` | `path`, `old_str`, `new_str` | Atomic find-and-replace |
| `mkdir` | `path` | Create directory |
| `delete` | `path` | Delete file |
| `shell` | `cmd` | Run any shell command |
| `pytest` | `path`, `keyword`, `verbose` | Run tests |
| `django_check` | — | Django system check |
| `git_status` | — | git status |
| `git_diff` | `path`, `staged` | git diff |
| `git_log` | `n`, `path` | git log |
| `flake8` | `path`, `max_line_length` | Lint |

Works on **any project** — Django, FastAPI, Flask, Node, Rails, plain Python. Tools operate on the filesystem and shell, not on Django internals.

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

## Improvement Roadmap

See the **Known Limitations & Improvement Points** section below for what to fix next.

---

## Known Limitations & Improvement Points

### 🔴 Critical (fix before production)

**1. Push queue is a single global — multi-client unsafe**
One `asyncio.Queue` means if two browser tabs connect, only one gets each message. Replace with a broadcast pattern (one queue per connected client).
```python
# Current (broken for 2 tabs)
_push_queue: asyncio.Queue[str] = asyncio.Queue()

# Fix: per-client queues stored in a dict
_push_clients: dict[str, asyncio.Queue] = {}
```

**2. No auth on any endpoint**
Any process on the machine can call `/push/send` or any MCP tool. Add a shared secret token checked on every request.
```python
# Add to every endpoint
if request.headers.get("X-Token") != SECRET_TOKEN:
    return JSONResponse({"error": "forbidden"}, status_code=403)
```

**3. `shell` tool has no sandboxing**
The AI can run `rm -rf /` if it hallucinates badly. Add an allowlist of safe commands or confirm dangerous operations before running.

**4. `_processed` fingerprint set grows forever**
Tool call fingerprints are never cleared. On a long session this leaks memory. Add a max size with `collections.deque` or clear on SPA navigation.

---

### 🟡 Reliability

**5. Single SSE connection, no reconnect backoff**
Current reconnect is a flat `setTimeout(connect, 5000)`. Use exponential backoff with jitter (1s, 2s, 4s, 8s, max 30s) to avoid thundering herd on server restart.

**6. MCP tool results are capped at 6000 chars arbitrarily**
Large files get silently truncated. The AI doesn't know. Either return a "truncated" warning in the result or paginate with `cat_range(path, start_line, end_line)`.

**7. Push channel loses messages when extension is disconnected**
If the browser is closed, messages in `_push_queue` are dropped silently. Persist the queue to a small SQLite file and replay on reconnect.

**8. `execCommand("insertText")` is deprecated**
Chrome is phasing it out. When it fails the fallback (`input.innerText = text`) breaks React/Vue state. The correct modern approach is `InputEvent` with `dataTransfer`, but that requires per-platform testing.

**9. No heartbeat acknowledgement**
The push channel sends keep-alive comments every 15s but never confirms the extension received and processed a message. Add an ACK: extension POSTs back to `/push/ack` after injecting.

---

### 🟢 Scalability

**10. One tool call at a time (sequential)**
`_busy = true` serialises all tool calls. Fine for a single user, wrong for multi-user. Add a per-session lock keyed on session ID.

**11. No streaming for long-running shell commands**
`pytest` on a large project can take 60+ seconds. The result only arrives when complete. Use `subprocess.Popen` + async generator to stream stdout lines back as SSE events.

**12. File search loads entire file into memory**
`search` reads every file fully before pattern matching. Use `mmap` or `grep` subprocess for large repos.

**13. No rate limiting on tool calls**
A misbehaving AI can call `shell` 100 times per second. Add per-client rate limiting (token bucket, 10 calls/second).

---

### 🔵 Developer Experience

**14. `MCP_BASE_URL` is hardcoded in content.js**
Should be read from `chrome.storage.sync` so it can be changed from the extension popup without editing source.

**15. No tool call history / audit log**
There's no persistent record of what the AI changed. Add append-only logging to a `.vibescode/audit.jsonl` file so you can review and replay.

**16. Platform selectors break when chat UIs update**
Gemini / ChatGPT change their DOM regularly. Add a `🔍 Inspect` button (already in v8, removed in v9) that runs the DOM inspector and shows which selectors match.

**17. No cancel / interrupt**
Once a tool call is in flight there's no way to stop it. Add a `Cancel` button to the terminal panel that aborts the in-flight fetch.

