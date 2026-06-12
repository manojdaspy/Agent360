# Loop360

**Turn any AI chat into a live coding agent — connected to your local project via MCP.**

Works with Gemini · ChatGPT · Claude · Perplexity. No IDE required.

> Built by [Manoj Das](https://www.linkedin.com/in/manoj-das-python/) · [GitHub](https://github.com/manojdaspy/nextgen)

---

## What is Loop360?

Loop360 is a **browser extension + local MCP server** that gives any AI chat interface direct access to your local filesystem. You type a task in ChatGPT or Gemini, the AI reads and edits your actual project files, runs your tests, and keeps iterating — all inside the chat window you already use.

```
You type a task in any AI chat
        │
        ▼
AI responds with a tool call:
AGENT_CALL {"op":"cat","path":"src/index.tsx"}
        │
        ▼
Extension parses the call (4-tier robust parser)
        │
        ▼
MCP JSON-RPC 2.0 → Your local server (main.py)
        │
        ▼
Server reads/writes your file, returns result
        │
        ▼
Extension injects result back into chat
        │
        ▼
AI sees the result and continues working
```

---

## Features

- **Any AI chat as your agent** — Gemini, ChatGPT, Claude, Perplexity
- **Full filesystem access** — read, write, patch, search, delete
- **Aider-style SEARCH/REPLACE patches** — no JSON escaping nightmares
- **4-tier robust parser** — handles AI's inconsistent JSON with auto-recovery
- **Git operations** — status, diff, log
- **Shell execution** — run tests, linters, any command
- **Push API** — trigger agent tasks from CI pipelines or scripts
- **Rich extension panel** — All / User / AI / Trace / Inject tabs + live LLM state

---

## Requirements

- Python 3.9+
- Google Chrome (or any Chromium browser)
- Git

---

## Installation

### Step 1 — Clone the repository

```bash
git clone https://github.com/manojdaspy/nextgen.git
cd nextgen
```

### Step 2 — Create a virtual environment

```bash
# Windows
python -m venv venv
venv\Scripts\activate

# macOS / Linux
python3 -m venv venv
source venv/bin/activate
```

### Step 3 — Install dependencies

```bash
pip install -r requirements.txt
```

`requirements.txt` includes:
```
fastapi
uvicorn
fastmcp
anyio
```

### Step 4 — Configure environment variables (optional but recommended)

```bash
# Windows
set VIBESCODE_PROJECT_ROOT=C:\Users\you\Desktop\myproject
set VIBESCODE_SECRET=your_secret_token_here

# macOS / Linux
export VIBESCODE_PROJECT_ROOT=/home/you/myproject
export VIBESCODE_SECRET=your_secret_token_here
```

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBESCODE_PROJECT_ROOT` | current directory | Your project root path |
| `VIBESCODE_SECRET` | *(empty)* | Auth token for push API |
| `PORT` | `8000` | Server port |

### Step 5 — Start the server

```bash
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Verify it is running:
```bash
curl http://localhost:8000/health
```

Expected response:
```json
{"status": "ok", "mcp_ready": true}
```

---

## Extension Setup

### Step 1 — Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions/`
2. Toggle **Developer mode** ON (top right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder inside the cloned repo

### Step 2 — Point the extension to your server

Open `extension/content.js` in any text editor and find:

```javascript
const MCP_BASE_URL = "http://localhost:8000";
```

Change the port if needed. Save the file, then click **🔄 refresh** on the extension card in `chrome://extensions/`.

### Step 3 — Load the system prompt into the AI

The AI needs to know Loop360's tool format. Two options:

**Option A — Paste into custom instructions (recommended):**

Copy the full contents of `system_prompt.txt` and paste into your AI platform's system prompt field:
- **ChatGPT:** Settings → Personalization → Custom Instructions
- **Gemini:** Create a Gem → set system instructions
- **Claude:** Projects → Project Instructions
- **Perplexity:** Space instructions

**Option B — Load at runtime:**

Type this in the chat:
```
AGENT_CALL {"op":"rules"}
```
The extension fetches and injects the system prompt automatically.

---

## Setting Your Project Root

**Via chat (easiest):**
> "My project is at C:\Users\me\Desktop\myapp"

The AI will emit:
```
AGENT_CALL {"op":"detect_root","hint":"C:/Users/me/Desktop/myapp"}
```

**Via extension panel:** Click the 📁 icon and paste the path.

**Via API:**
```bash
curl -X POST http://localhost:8000/project/set \
  -H "Content-Type: application/json" \
  -d "{\"path\": \"C:/Users/me/Desktop/myapp\"}"
```

---

## Usage Examples

**Read a file:**
> "Show me what's in src/index.tsx"

**Edit a file:**
> "Add error handling to the login function in src/auth.py"

**Run tests:**
> "Run the test suite and fix any failures"

**Check git status:**
> "Show me what changed since the last commit"

**Push a task from CI:**
```bash
curl -X POST http://localhost:8000/push/send \
  -H "Content-Type: application/json" \
  -H "X-Token: your_secret_token_here" \
  -d "{\"text\": \"Run tests and fix failures.\", \"submit\": true}"
```

---

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| `rules` | Load the system prompt from the server |
| `tree` / `dir_list` | Directory listing |
| `cat` / `cat_range` | Read files (full or by line range) |
| `search` | Search files by keyword |
| `write` | Write or overwrite a file |
| `patch` | Aider-style SEARCH/REPLACE edit |
| `mkdir` / `delete` | File and folder management |
| `shell` | Run any shell command |
| `run_tests` / `lint` | Run tests and linters |
| `git_status` / `git_diff` / `git_log` | Git operations |
| `project_info` | Detect project type and structure |
| `set_root` / `detect_root` / `get_root` | Project root management |
| `template_prompt` | Save and load reusable task plans |
| `list_mcp_tools` | List all available tools |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/ext/status` | Rich extension and LLM state |
| POST | `/push/send` | Push a message into the AI chat |
| POST | `/push/ack` | Extension ACKs after inject |
| POST | `/ext/heartbeat` | Extension reports live state |
| GET | `/project/root` | Get current project root |
| POST | `/project/set` | Set project root |
| POST | `/project/detect` | Auto-detect root from hint path |
| GET | `/tools` | List all MCP tools as JSON |
| GET | `/docs` | Swagger UI (interactive API docs) |
| GET | `/mcp/sse` | MCP SSE handshake |
| POST | `/mcp/messages` | MCP JSON-RPC tool calls |

---

## Project Structure

```
nextgen/
├── main.py                   ← FastAPI + MCP server (all tools)
├── system_prompt.txt         ← Official AI system prompt
├── system_prompt_new.txt     ← Updated prompt (in progress)
├── prompt_rule.txt           ← Prompt formatting rules
├── template_prompt.txt       ← Reusable task plan templates
├── architecture.md           ← Architecture and design notes
├── requirements.txt
├── .gitignore
└── extension/
    ├── manifest.json         ← Chrome extension manifest
    ├── content.js            ← MCP client + parser + panel UI
    └── background.js         ← PNA fetch proxy + config storage
```

---

## Supported Platforms

| Platform | Status |
|----------|--------|
| Gemini | ✅ |
| ChatGPT | ✅ |
| Claude | ✅ |
| Perplexity | ✅ |

> DOM selectors break when AI platforms update their UI. If a platform stops working, check the extension panel (All tab → 🩺 DOM Diagnostics) and open an issue.

---

## Debugging

| Problem | Fix |
|---------|-----|
| Server not responding | `curl http://localhost:8000/health` — check terminal for errors |
| Extension not detecting turns | Panel → All tab → check 🩺 DOM Diagnostics |
| Tool result not injecting | Verify `llm_state: injectable` via `/ext/status` |
| Parse error on tool call | Extension auto-recovers most cases — check Trace tab for details |
| Platform selector broken | Open an issue with the platform name and Chrome version |

---

## Security

- The `shell` tool has **no command allowlist** — the AI can run any command on your machine
- Always set `VIBESCODE_SECRET` if the server is accessible beyond `127.0.0.1`
- Never run with `--host 0.0.0.0` on a public network without authentication
- Tool results are capped at ~6000 chars — use `cat_range` for large files

---

## Terms of Service Notice

This tool automates interactions with third-party AI chat platforms. Users are solely responsible for ensuring their usage complies with the Terms of Service of ChatGPT, Gemini, Claude, Perplexity, or any other platform they connect to. The authors take no responsibility for account suspensions or violations.

---

## Contributing

The number one way to contribute is fixing DOM selectors — AI platforms update their UI constantly and selectors break without notice.

### Steps

1. Fork the repository
2. Create a branch: `git checkout -b fix/chatgpt-selector`
3. Make your changes
4. Commit with a clear message: `git commit -m "fix: update ChatGPT turn selector after UI update"`
5. Push: `git push origin fix/chatgpt-selector`
6. Open a Pull Request describing what broke and what you changed

### Good first contributions

- DOM selector fixes for any platform
- Testing on macOS or Linux
- New MCP tool ideas
- Documentation improvements
- Security hardening for the `shell` tool

Please open an issue before starting large changes so we can align first.

---

## License

MIT License — free to use, modify, and distribute. See [LICENSE](LICENSE) for full terms.

---

## Author

**Manoj Das**
- LinkedIn: [manoj-das-python](https://www.linkedin.com/in/manoj-das-python/)
- GitHub: [manojdaspy](https://github.com/manojdaspy)

---

*If Loop360 saved you time, a ⭐ on GitHub helps others find it.*