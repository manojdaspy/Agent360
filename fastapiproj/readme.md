# VibesCode — Browser Extension + MCP Agent v14

A browser extension that turns any AI chat (Gemini, ChatGPT, Claude, Perplexity) into a live coding agent connected to your local project via the official MCP protocol.

---

## What's New in v14

### Robust AGENT_CALL parser (4-tier)
1. **AGENT_PATCH block** — Aider-style SEARCH/REPLACE (no JSON quoting for edits)
2. **Strict JSON** — `JSON.parse`
3. **JSON repair** — trailing commas, single→double quotes
4. **Field-boundary recovery** — unescaped quotes in `old_str` / `new_str`

### Fuzzy patch on server (Aider-inspired)
`patch` tool tries: exact → CRLF normalize → trailing-ws normalize → line-block match.

See `../ARCHITECTURE_RECOMMENDATIONS.md` for full industry mapping and roadmap.

### Per-turn DOM scanner
Gemini, ChatGPT, and Claude use platform-specific turn selectors (`conversation-container`, `section[data-turn]`, etc.) instead of flat message history. See `../DOM_SELECTORS.md` for the full selector reference.

### Trace + Inject panel
Panel tabs: **All**, **User**, **AI**, **Trace**, **Inject**, plus live state machine status.

### Boot DOM diagnostics
On load, the extension probes selectors and logs counts to the All tab so missing DOM nodes are visible immediately.

### PNA-safe fetch
Content script routes MCP requests through the background service worker so `localhost` is reachable from public AI chat origins.

---

## How It Works

```
You type a task in Gemini / ChatGPT / Claude
          │
          ▼
   AI responds with a tool call:
   AGENT_CALL {"op":"cat","path":"src/index.tsx"}
          │
          ▼  (Per-turn scanner — latest unprocessed AI turn only)
   Extension parseAgentCall() → JSON or field recovery
          │
          ▼  MCP JSON-RPC 2.0 → Your local server
   Server reads the file, returns content
          │
          ▼
   Extension checks injectGate() → waits for injectable state
          │
          ▼
   Injects __TOOL_RESULT__ into chat + submits
          │
          ▼
   AI sees the file content and continues working
```

---

## File Structure

```
nextgen/
├── DOM_SELECTORS.md              ← selector reference + improvement notes
├── prompt13.txt                  ← extended prompt (dev copy)
└── fastapiproj/
    ├── README.md                 ← this file
    ├── system_prompt.txt         ← official prompt (served by rules MCP tool)
    ├── main.py                   ← FastAPI + MCP server
    └── extension/
        ├── manifest.json
        ├── content.js            ← MCP client + turn scanner + parser + panel
        └── background.js         ← PNA fetch proxy + config storage
```

---

## Quick Start

```bash
cd fastapiproj
pip install fastapi uvicorn fastmcp anyio

# Optional
set VIBESCODE_PROJECT_ROOT=C:\Users\you\Desktop\myproject
set VIBESCODE_SECRET=mysecret

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

---

## Extension Setup

1. Chrome → `chrome://extensions/` → Enable Developer mode
2. Load unpacked → select `extension/` folder (inside `fastapiproj/` or repo root — wherever your copy lives)
3. Edit `content.js` — set `MCP_BASE_URL` to your server (default `http://localhost:8000`)
4. Load the system prompt into the AI:
   - **Option A:** Paste `system_prompt.txt` into custom instructions / system prompt field
   - **Option B:** At runtime: `AGENT_CALL {"op":"rules"}` (loads from server)
5. Open any supported AI chat and start working

---

## System Prompt

| File | Purpose |
|------|---------|
| `system_prompt.txt` | Official prompt — loaded by MCP `rules` tool and meant for AI custom instructions |
| `../prompt13.txt` | Extended dev copy with extra formatting |

Key rules the AI must follow:
- **One `AGENT_CALL` line per response** — no prose mixed in
- **Escape `"` as `\"`** inside `old_str`, `new_str`, `content`
- **Forward-slash paths** even on Windows
- **Read before write** — `cat` / `cat_range` before `patch`

---

## Setting the Project Root

**Via the AI (preferred):**
> "My project is at C:\Users\me\Desktop\myapp"

→ AI emits: `AGENT_CALL {"op":"detect_root","hint":"C:/Users/me/Desktop/myapp"}`

**Via the panel:** Click 📁 and paste any path

**Via API:**
```bash
curl -X POST http://localhost:8000/project/set \
  -H "Content-Type: application/json" \
  -d "{\"path\": \"C:/Users/me/Desktop/myapp\"}"

curl -X POST http://localhost:8000/project/detect \
  -H "Content-Type: application/json" \
  -d "{\"hint\": \"C:/Users/me/Desktop/myapp/src/index.tsx\"}"
```

---

## AGENT_CALL Parsing (extension side)

| Stage | Method | When |
|-------|--------|------|
| 1 | Path normalize | Backslashes in Windows paths → forward slashes |
| 2 | `JSON.parse` | AI emitted valid JSON |
| 3 | Field-boundary recovery | Unescaped quotes in `old_str` / `new_str` / `content` |
| 4 | Skip turn | Both stages failed — logged as `parse_error` |

Recovery log example: `✅ AGENT_CALL recovered (patch) — unescaped quotes fixed`

The server (`main.py`) receives already-parsed JSON from the extension — it does not re-parse AGENT_CALL text.

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
  "platform": "Gemini",
  "llm_state": "injectable",
  "is_generating": false,
  "send_button_status": "active",
  "input_empty": true,
  "mcp_ready": true,
  "can_inject": true
}
```

**`llm_state` values:**

| State | Meaning |
|-------|---------|
| `generating` | AI is streaming a response |
| `idle` | AI finished; input empty |
| `injectable` | Safe to inject a new message |
| `injecting` | Extension is typing/sending |

---

## Push Messages from API / CI

```bash
curl -X POST http://localhost:8000/push/send \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"Run tests and fix failures.\", \"submit\": true}"
```

```python
from main import push_to_extension

push_to_extension("Run pytest and fix any failures.")
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
| `rules` | Return full `system_prompt.txt` text |
| `set_root` / `detect_root` / `get_root` | Project root management |
| `list_mcp_tools` | List all tools with descriptions |
| `tree` / `dir_list` | Directory listing |
| `cat` / `cat_range` / `search` | Read and search files |
| `write` / `patch` / `mkdir` / `delete` | File operations |
| `shell` / `run_tests` / `lint` | Run commands |
| `git_status` / `git_diff` / `git_log` | Git operations |
| `project_info` | Detect project type |
| `template_prompt` | Save/load/delete task plans |

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
- `shell` has no allowlist — the AI can run any command. Restrict network exposure and set `VIBESCODE_SECRET`.

**Reliability**
- Tool results are capped (~6000 chars). Use `cat_range` for large files.
- Field-boundary recovery handles most quote errors but cannot fix completely malformed payloads.
- Push queue messages time out after 120s if the extension never reaches `injectable`.

**DOM fragility**
- AI chat UIs change selectors without notice. Check `../DOM_SELECTORS.md` and boot diagnostics if turns are not detected.

---

## Debugging Checklist

1. Server running: `curl http://localhost:8000/health`
2. Extension panel → **All** tab → look for `🩺 DOM Diagnostics`
3. Confirm `turn_container`, `user_turn`, `ai_turn` > 0 (Gemini)
4. Confirm `llm_state: injectable` before expecting tool result inject
5. On `parse_error` → AI should escape `\"` in patch strings; extension may auto-recover
