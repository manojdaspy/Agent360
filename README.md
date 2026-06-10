# VibesCode v9 — Architecture & Setup Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser (Gemini / ChatGPT / Claude)      │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  content.js (Extension)                              │   │
│  │                                                      │   │
│  │  MutationObserver                                    │   │
│  │    └─ detects "AGENT_CALL {…}" lines in AI output   │   │
│  │         └─ McpClient.callTool(name, args)            │   │
│  │              ├─ POST /mcp/messages  (JSON-RPC 2.0)   │   │
│  │              └─ waits for SSE response               │   │
│  │                                                      │   │
│  │  Push Channel (EventSource /mcp/push/stream)         │   │
│  │    └─ on "inject" event → typeIntoInput(text, true)  │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────┬───────────────────┬──────────────────────┘
                   │ SSE + POST        │ SSE (push)
                   ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│  MCP Server  (FastMCP / Starlette ASGI — port 8001)         │
│                                                             │
│  GET  /mcp/sse           → SSE transport (MCP handshake)    │
│  POST /mcp/messages      → JSON-RPC 2.0 method dispatch     │
│  GET  /mcp/push/stream   → Server→Extension push channel    │
│  POST /mcp/push/send     → Enqueue a push message           │
│  GET  /mcp/health        → Liveness probe                   │
│                                                             │
│  Tools (all Pydantic-validated, zero parse errors):         │
│    tree · dir · cat · search · write · patch · mkdir        │
│    delete · shell · pytest · django_check · git_* · flake8  │
└──────────────────┬──────────────────────────────────────────┘
                   │ Python calls
                   ▼
┌─────────────────────────────────────────────────────────────┐
│  Django REST API  (port 8000)                               │
│                                                             │
│  POST /api/agent/chat/          → Agentic loop              │
│  GET  /api/agent/chat/stream/   → SSE streaming             │
│  POST /api/agent/push/          → push_to_extension()       │
│  GET  /api/agent/tools/         → List all MCP tools        │
│  CRUD /api/agent/sessions/…     → Session management        │
└─────────────────────────────────────────────────────────────┘
```

## Why This Design

| Concern | Old approach | New approach |
|---------|-------------|--------------|
| Protocol | Hand-rolled JSON parsing in content.js | Official MCP SDK (FastMCP) — JSON-RPC 2.0 |
| Parse errors | Regex + string matching | `JSON.parse()` on a single line — throws or succeeds |
| Django→AI push | Not supported | EventSource `/mcp/push/stream` + `push_to_extension()` |
| Tool definition | Hand-written dict matching in views.py | `@mcp.tool()` decorator — Pydantic auto-validates |
| Background.js HTTP | Background did all API calls | Content.js speaks MCP directly; background is config-only |

---

## Installation

### 1. Server dependencies

```bash
pip install mcp>=1.27 uvicorn starlette anyio a2wsgi
```

### 2. Run MCP server (standalone — recommended)

```bash
# Set project root
export VIBESCODE_PROJECT_ROOT=/path/to/your/django/project

# Start MCP on port 8001
python -m project_agent.mcp.server
```

Or with uvicorn directly:
```bash
uvicorn project_agent.mcp.server:get_asgi_app --factory --port 8001 --host 0.0.0.0
```

### 3. Run Django (separate process)

```bash
python manage.py runserver 8000
```

### 4. Extension

Update `MCP_BASE_URL` in `content.js`:
```javascript
const MCP_BASE_URL = "http://localhost:8001";  // or your production URL
```

Load the `extension/` folder as an unpacked Chrome extension.

---

## Option B: Mount MCP inside Django (single process)

Requires uvicorn (not gunicorn WSGI):

**myproject/urls.py:**
```python
from a2wsgi import ASGIMiddleware
from project_agent.mcp.server import get_asgi_app
from django.urls import re_path

_mcp = get_asgi_app()

urlpatterns = [
    path("api/agent/", include("project_agent.urls")),
    re_path(r"^mcp/", ASGIMiddleware(_mcp)),
]
```

**myproject/asgi.py:**
```python
import os
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "myproject.settings")
application = get_asgi_application()
```

Run:
```bash
uvicorn myproject.asgi:application --port 8000
```

Then set in content.js:
```javascript
const MCP_BASE_URL = "https://your-domain.com";
```

---

## Pushing Messages from Django to the AI

From anywhere in your Django codebase:

```python
from project_agent.mcp.server import push_to_extension

# Simple push — extension types this into AI and presses Send
push_to_extension("Run pytest and fix any test failures.")

# From a view:
class DeployView(APIView):
    def post(self, request):
        deploy()
        push_to_extension("Deployment complete. Verify the /health endpoint.")
        return Response({"ok": True})

# From a Celery task:
@app.task
def nightly_check():
    push_to_extension("Run django_check and flake8 on the entire project.")
```

Or via REST API from any service:
```bash
curl -X POST https://your-server.com/api/agent/push/ \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello from CI/CD pipeline!", "submit": true}'
```

`submit: true`  → extension auto-presses Send (default)
`submit: false` → extension fills the input; user reviews before sending

---

## The AI System Prompt

Paste the contents of `SYSTEM_PROMPT.md` into the AI's system prompt or
custom instructions. Key points:

- AI emits `AGENT_CALL {"op":"cat","path":"views.py"}` — **one compact line**
- Extension intercepts it via MutationObserver
- Result injected back as `__TOOL_RESULT__` … `__END_RESULT__`
- AI continues from result

The single-line compact JSON format means:
- No indentation/whitespace parse errors
- No markdown fence confusion  
- `JSON.parse()` either succeeds completely or fails completely (no partial matches)

---

## Security Notes

- `_safe_path()` blocks directory traversal (`../`) in all file tools
- The push channel has no auth by default — add token validation in `push_stream()` for production
- The MCP server should run on localhost or behind a firewall in production; only expose `/api/agent/push/` publicly if needed