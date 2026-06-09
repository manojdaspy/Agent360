# VibesCode Agent

> **An LLM-powered Django project assistant. The human types, the LLM thinks, the Django server acts — over plain HTTP.**

---

## The Big Picture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         THE FULL FLOW                               │
│                                                                     │
│  Human types: "Fix the NameError in mainapp/views.py"               │
│       │                                                             │
│       ▼                                                             │
│  ┌─────────────┐   any of these clients:                            │
│  │   Cline     │──┐  VSCode extension, OpenAI-compatible            │
│  │  Continue   │──┤  VSCode/JetBrains plugin                        │
│  │   Cursor    │──┤  IDE with custom API mode                       │
│  │   Aider     │──┤  terminal tool, --openai-api-base flag          │
│  │  Your UI    │──┤  any frontend hitting the REST API              │
│  │  CLI        │──┘  python manage.py vibescode "..."               │
│  └─────────────┘                                                    │
│          │                                                          │
│          │  HTTP/HTTPS  (OpenAI, MCP, or REST format)              │
│          ▼                                                          │
│  ┌───────────────────────────────────────────────────────────┐      │
│  │              YOUR DJANGO SERVER (this app)                │      │
│  │                                                           │      │
│  │   /openai/v1/chat/completions  ← Cline, Aider, Continue  │      │
│  │   /mcp/                        ← Claude Desktop, MCP clients│    │
│  │   /api/agent/chat/             ← your own frontend/API    │      │
│  │   /api/agent/cmd/?op=...       ← raw LLM HTTP tool calls  │      │
│  │                                                           │      │
│  │   QueryRouter: resolves op aliases, handles fallback      │      │
│  │        │                                                  │      │
│  │        ▼                                                  │      │
│  │   [cat] [dir] [tree] [search] [write] [patch] [shell]    │      │
│  │   [git_status] [git_diff] [flake8] [django_check] [pytest]│      │
│  └───────────────────────────────────────────────────────────┘      │
│          │                                                          │
│          │  LLM API call (Claude / GPT-4 / Ollama)                 │
│          ▼                                                          │
│  ┌───────────────┐                                                  │
│  │  LLM reasons  │  reads file → finds bug → writes fix → verifies │
│  └───────────────┘                                                  │
│          │                                                          │
│          ▼                                                          │
│  Student sees: "Fixed! The variable `name` was used but never       │
│  defined. I imported it from models.py on line 3."                  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## How Each Client Connects

### Cline (VSCode Extension)

Cline is a VSCode AI coding extension. It natively speaks the OpenAI tool-calling protocol. Point it at this server and it will autonomously read files, run commands, and write fixes — just like it would with the real OpenAI API, but running against your actual project.

```json
// VSCode settings.json
{
  "cline.apiProvider": "openai-compatible",
  "cline.openAiBaseUrl": "http://localhost:8000/openai/v1",
  "cline.openAiApiKey": "your-vibescode-token",
  "cline.openAiModelId": "vibescode-agent"
}
```

What happens:
```
Cline → POST /openai/v1/chat/completions
      → Django injects VibesCode tools into LLM call
      → LLM replies with tool_use: cat(views.py)
      → Django executes cat, feeds result back to LLM
      → LLM replies with tool_use: patch(views.py, old, new)
      → Django applies the patch
      → LLM replies: "Fixed. Here's what I changed."
      → Cline shows the response in VSCode
```

Cline never sees your filesystem directly. It just talks to your Django server.

---

### Continue.dev (VSCode / JetBrains Plugin)

```json
// ~/.continue/config.json
{
  "models": [{
    "title": "VibesCode Agent",
    "provider": "openai",
    "model": "vibescode-agent",
    "apiBase": "http://localhost:8000/openai/v1",
    "apiKey": "your-vibescode-token"
  }]
}
```

---

### Cursor (Custom API Mode)

In Cursor settings → Models → Add Model:
```
Model name:  vibescode-agent
API base:    http://localhost:8000/openai/v1
API key:     your-vibescode-token
```

---

### Aider (Terminal)

```bash
aider \
  --openai-api-base http://localhost:8000/openai/v1 \
  --openai-api-key your-vibescode-token \
  --model vibescode-agent \
  mainapp/views.py
```

---

### Claude Desktop (MCP)

```json
// ~/.claude/claude_desktop_config.json
{
  "mcpServers": {
    "vibescode": {
      "url": "http://localhost:8000/mcp/",
      "headers": { "Authorization": "Bearer your-vibescode-token" }
    }
  }
}
```

Claude Desktop connects via MCP (Model Context Protocol) — a JSON-RPC 2.0 protocol over HTTP/SSE. It discovers tools automatically via `GET /mcp/tools/`.

---

### Raw HTTP / Your Own Frontend

```bash
# Simple chat — LLM reads and fixes things autonomously
curl -X POST http://localhost:8000/api/agent/chat/ \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "Fix the NameError in mainapp/views.py", "project_root": "/home/student/project"}'

# Direct tool call — no LLM involved
curl "http://localhost:8000/api/agent/cmd/?op=cat&path=mainapp/views.py" \
  -H "Authorization: Bearer your-token"

# Streaming — see tool calls in real time
curl -N "http://localhost:8000/api/agent/chat/stream/?message=Fix+my+bug" \
  -H "Authorization: Bearer your-token" \
  -H "Accept: text/event-stream"
```

---

### Terminal (Django CLI)

```bash
# Single shot
python manage.py vibescode "Fix the NameError in mainapp/views.py"

# Interactive session
python manage.py vibescode --interactive

# Direct tool without LLM
python manage.py vibescode --tool cat --path mainapp/views.py
python manage.py vibescode --tool pytest
python manage.py vibescode --tool git_status
```

---

## The Query-Param Router

This is the "universal glue" layer. Every LLM and tool has its own naming convention for operations. The router handles all of them.

```
LLM sends:  ?op=read_file&path=views.py
            ?op=get_file&file=views.py
            ?op=cat&path=views.py
            ?op=view&filename=views.py
                    ↓
        QueryRouter resolves all → canonical: "cat"
                    ↓
            CatTool.run({path: "views.py"})
                    ↓
            {"ok": true, "data": "   1 | from django..."}
```

### Op Alias Table (partial)

| What you send | Resolves to |
|---|---|
| `read`, `read_file`, `get_file`, `open`, `view` | `cat` |
| `ls`, `list`, `list_dir`, `list_files` | `dir` |
| `search`, `grep`, `find`, `regex`, `rg` | `search` |
| `run`, `exec`, `execute`, `terminal`, `bash` | `shell` |
| `write`, `save`, `create`, `write_file` | `write` |
| `patch`, `replace`, `fix`, `edit`, `update` | `patch` |
| `status`, `git_status` | `git_status` |
| `diff`, `git_diff` | `git_diff` |
| `check`, `django_check`, `manage_check` | `django_check` |
| `test`, `pytest`, `run_tests`, `tests` | `pytest` |
| `lint`, `flake8`, `pep8` | `flake8` |

### Parameter Aliases

The router also normalises parameter names:

```
?file=views.py          → path
?filename=views.py      → path
?file_path=views.py     → path
?text=...               → content
?data=...               → content
?grep=NameError         → pattern
?query=NameError        → pattern
?command=pytest         → cmd
```

### Fallback Logic

When an op is completely unknown, the fallback handler tries to recover:

```
Unknown op: "read_source_file"
       │
       ├─ Step 1: Fuzzy match → "read_source_file" contains "read" → try "cat"  ✓
       │
       ├─ Step 2: If fuzzy fails → infer from params:
       │    has path + content → "write"
       │    has pattern        → "search"
       │    has cmd            → "shell"
       │    has path only      → "cat"
       │
       └─ Step 3: If all fails → structured error:
            {
              "ok": false,
              "error": "Unknown operation: read_source_file",
              "suggestions": ["read", "cat", "search"],
              "available_ops": [...all 40+ aliases...],
              "hint": "Pass one of the available_ops as ?op=<name>"
            }
```

---

## Protocol Support Matrix

| Protocol | Endpoint | Used by |
|---|---|---|
| OpenAI Chat Completions | `POST /openai/v1/chat/completions` | Cline, Continue.dev, Cursor, Aider, LiteLLM |
| OpenAI Models List | `GET /openai/v1/models` | Cline, Continue.dev (startup handshake) |
| MCP JSON-RPC 2.0 | `POST /mcp/` | Claude Desktop, any MCP client |
| MCP SSE Stream | `GET /mcp/` | Claude Desktop (server-push events) |
| MCP Tool Manifest | `GET /mcp/tools/` | Claude Desktop, Cursor MCP mode |
| VibesCode REST Chat | `POST /api/agent/chat/` | Your own frontend |
| VibesCode SSE Chat | `GET /api/agent/chat/stream/` | Your own frontend |
| VibesCode Direct Cmd | `GET/POST /api/agent/cmd/` | Raw LLM HTTP, curl, scripts |
| Tool Discovery | `GET /api/agent/tools/` | Any client wanting tool list |

---

## Available Tools

| Tool | Op aliases | Description |
|---|---|---|
| `cat` | read, read_file, get_file, view, open | Read file with line numbers |
| `dir` | ls, list, list_dir, list_files | List directory contents |
| `tree` | tree, list_tree, full_tree | Full recursive directory tree |
| `write` | write, save, write_file, create | Write full file (saves backup) |
| `patch` | patch, fix, edit, replace, update | Surgical single-block replacement |
| `mkdir` | mkdir, create_dir, make_dir | Create directories |
| `delete` | delete, remove, rm | Delete file (saves backup) |
| `search` | search, grep, find, regex, rg | Regex search with context lines |
| `shell` | shell, run, exec, bash, terminal | Run sandboxed shell commands |
| `git_status` | status, git_status | Working tree status |
| `git_diff` | diff, git_diff | Diff vs HEAD |
| `git_log` | log, history, git_log | Commit history |
| `git_blame` | blame, git_blame | Line-by-line authorship |
| `git_restore` | restore, revert | Restore file to last commit |
| `flake8` | lint, flake8, pep8 | PEP8 + syntax linting |
| `django_check` | check, django_check, manage_check | Django system check |
| `pytest` | test, pytest, run_tests, tests | Run test suite |

---

## Installation

### 1. Drop the app into your Django project

```bash
cp -r project_agent/ /path/to/your/project/
```

### 2. Install deps

```bash
pip install django djangorestframework httpx gitpython python-dotenv
```

### 3. settings.py

```python
INSTALLED_APPS = [
    "rest_framework",
    "project_agent",
    # ... your apps
]

VIBESCODE = {
    # Required
    "PROJECT_ROOT": "/home/student/myproject",

    # LLM — swap provider with one line
    "LLM_PROVIDER": "claude",       # "claude" | "openai" | "ollama"
    "LLM_API_KEY":  "sk-ant-...",
    "LLM_MODEL":    "claude-sonnet-4-20250514",
    "LLM_BASE_URL": None,           # set for Ollama: "http://localhost:11434"

    # Security
    "API_TOKEN": "your-secret-token",
    "ALLOWED_EXTENSIONS": [".py", ".html", ".js", ".css", ".json", ".md"],
    "MAX_FILE_SIZE_KB": 500,

    # Shell (opt in)
    "ENABLE_SHELL": True,
    "SHELL_TIMEOUT_SECONDS": 15,

    # Prompt tuning
    "SYSTEM_PROMPT_EXTRA": "Be encouraging. Students are beginners.",
    "MAX_TOKENS": 4096,
}
```

### 4. urls.py

```python
urlpatterns = [
    # VibesCode REST API
    path("api/agent/", include("project_agent.urls")),

    # MCP protocol (Claude Desktop, Cursor MCP mode)
    path("mcp/", include("project_agent.mcp.urls")),

    # OpenAI-compatible (Cline, Continue.dev, Aider, Cursor custom API)
    path("openai/v1/", include("project_agent.openai_compat.urls")),
]
```

### 5. Migrate

```bash
python manage.py makemigrations project_agent
python manage.py migrate
```

---

## API Quick Reference

```
# ── OpenAI-compatible (for Cline, Continue, Aider) ───────────────────────────
POST /openai/v1/chat/completions       # chat + agentic tool loop
GET  /openai/v1/models                 # model list (startup handshake)

# ── MCP protocol (for Claude Desktop, Cursor MCP mode) ───────────────────────
GET  /mcp/                             # SSE stream (hold open for server events)
POST /mcp/                             # JSON-RPC 2.0 method calls
GET  /mcp/tools/                       # tool manifest
GET  /mcp/resources/                   # project files as resources

# ── VibesCode REST API (for your own frontend) ────────────────────────────────
POST /api/agent/chat/                  # full agentic loop, JSON response
GET  /api/agent/chat/stream/           # same, Server-Sent Events stream

# ── Direct tool execution (any naming convention accepted) ───────────────────
GET  /api/agent/cmd/?op=cat&path=mainapp/views.py
GET  /api/agent/cmd/?op=read_file&file=views.py       # alias works too
GET  /api/agent/cmd/?op=dir&path=.
GET  /api/agent/cmd/?op=tree
GET  /api/agent/cmd/?op=search&pattern=NameError&path=.
GET  /api/agent/cmd/?op=git_status
GET  /api/agent/cmd/?op=django_check
GET  /api/agent/cmd/?op=pytest
POST /api/agent/cmd/  {"op": "write",  "path": "views.py", "content": "..."}
POST /api/agent/cmd/  {"op": "patch",  "path": "views.py", "old_str": "...", "new_str": "..."}
POST /api/agent/cmd/  {"op": "shell",  "cmd": "python manage.py check"}

# ── Tool discovery ────────────────────────────────────────────────────────────
GET  /api/agent/tools/                 # all tools + schemas + all op aliases

# ── Sessions ──────────────────────────────────────────────────────────────────
GET    /api/agent/sessions/
GET    /api/agent/sessions/<uuid>/
DELETE /api/agent/sessions/<uuid>/
POST   /api/agent/sessions/<uuid>/undo/   # undo last file change
```

---

## Security

| Layer | What it does |
|---|---|
| Bearer token | All endpoints require `Authorization: Bearer <token>` |
| Path sandbox | Every tool resolves paths inside `PROJECT_ROOT`, blocks `../` traversal |
| Extension allowlist | Only configured file types can be read/written |
| File size limit | Files over `MAX_FILE_SIZE_KB` refused |
| Shell blocklist | `rm`, `sudo`, `kill`, `wget`, `curl` etc. always blocked |
| Shell timeout | Commands killed after `SHELL_TIMEOUT_SECONDS` |
| Audit trail | Every tool call, message, file change stored in DB |
| Undo | Every file write saves previous version for rollback |

Per-student isolation: pass a different `project_root` per session. No student can access another's project.

---

## Advantages

**vs local tools (Claude Code, Cursor, Aider):**
Those tools run on the developer's machine. VibesCode runs on a server — so you can serve 100 students from one instance, control and audit every action, rate-limit, and students don't need any local install.

**vs building from scratch:**
- Protocol adapters for Cline, MCP, and OpenAI already done — any tool works day one
- Universal query router — every op alias, every param name variation, handled
- Custom fallback logic — unknown ops don't hard-fail, they try fuzzy match + inference
- Full audit trail (DB) — every file change, every tool call, every session logged
- Undo endpoint — any file change is reversible
- SSE streaming — real-time tool-call visibility
- Multi-LLM — Claude/GPT/Ollama behind one setting change

---

## Limitations

- **Sync workers**: The agentic loop blocks a Django thread. Run `gunicorn --workers 4+` for concurrent users.
- **No streaming writes**: File writes are atomic, not streamed.
- **MCP SSE keep-alive uses `time.sleep()`**: Fine for a few connections; use Django Channels for many.
- **Shell is powerful**: `ENABLE_SHELL=True` lets the LLM run real commands. Use Docker per-project for untrusted code.
- **No built-in rate limiting**: Add DRF throttling or Nginx limits in front.
- **No approve-before-apply**: LLM writes files directly. A diff-preview step would be safer for production.
- **Context window**: Very large projects need selective reading (use `search` first, then `cat` specific files).

---

## Planned

- [ ] Async views + `httpx.AsyncClient` for non-blocking LLM calls
- [ ] Propose/approve mode — LLM shows diff, human confirms before write
- [ ] Docker sandboxing per project (safe shell)
- [ ] Redis pub/sub for SSE behind multiple workers
- [ ] Token usage tracking per session/student
- [ ] WebSocket transport for bidirectional IDE integration
- [ ] Rate limiting per student/IP via DRF throttle classes

---

## File Structure

```
project_agent/
├── adapters/
│   ├── openai_tools.py      ← OpenAI ↔ internal format converters
│   └── query_router.py      ← op aliases, param normalisation, fallback logic
│
├── openai_compat/
│   ├── views.py             ← /openai/v1/chat/completions (Cline, Aider, Continue)
│   └── urls.py
│
├── mcp/
│   ├── server.py            ← MCP JSON-RPC 2.0 + SSE (Claude Desktop)
│   └── urls.py
│
├── tools/
│   ├── base.py              ← BaseTool + ToolResult
│   ├── filesystem.py        ← dir, tree, cat, write, patch, mkdir, delete
│   ├── search.py            ← regex search
│   ├── executor.py          ← shell (sandboxed)
│   ├── git_tool.py          ← git status/diff/log/blame/restore
│   ├── lint_tool.py         ← flake8, django_check, pytest
│   └── registry.py          ← auto-discovery
│
├── services/
│   ├── llm_client.py        ← HTTP to Claude/GPT/Ollama
│   ├── agent.py             ← agentic loop (plan→tool→observe→repeat)
│   ├── session.py           ← DB persistence
│   └── streaming.py         ← SSE generator
│
├── management/commands/
│   └── vibescode.py         ← python manage.py vibescode
│
├── models.py                ← AgentSession, Message, ToolCall, FileChange
├── views.py                 ← REST + SSE views
├── urls.py                  ← all API routes
├── serializers.py
├── permissions.py
└── config.py
```

---

## License

MIT.
#   n e x t g e n  
 #   n e x t g e n  
 #   n e x t g e n  
 