"""
main.py — VibesCode Agent v11
══════════════════════════════════════════════════════════════════════════════
Single-port FastAPI server.  All endpoints:

  MCP (AI tool bridge)
  ─────────────────────────────────────────────────────
  GET  /mcp/sse              MCP SSE handshake
  POST /mcp/messages         MCP JSON-RPC tool calls

  Extension ↔ Server
  ─────────────────────────────────────────────────────
  GET  /push/stream          Server→Extension SSE channel
  POST /push/send            Enqueue message → AI chat   ← use this from curl/API
  POST /push/ack             Extension ACKs after inject
  POST /ext/heartbeat        Extension reports its live state every 2s
  GET  /ext/status           Poll current extension+LLM state

  Project root management (dynamic, any drive, any language)
  ─────────────────────────────────────────────────────
  GET  /project/root         Get current project root
  POST /project/set          Set project root at runtime
  POST /project/detect       Auto-detect root from a hint path

  Meta
  ─────────────────────────────────────────────────────
  GET  /health               Full health + queue depth + ext status
  GET  /tools                List registered MCP tools
  GET  /docs                 Swagger UI

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Environment variables:
    VIBESCODE_PROJECT_ROOT   Initial project root (optional; can be changed at runtime)
    VIBESCODE_SECRET         Shared token for /push/send auth (optional but recommended)
══════════════════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

from fastapi import FastAPI, HTTPException, Request, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from fastmcp import FastMCP

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s — %(message)s",
)
logger = logging.getLogger("vibescode")

# ══════════════════════════════════════════════════════════════════════════════
# PROJECT ROOT  — fully dynamic, changeable at runtime via API
# ══════════════════════════════════════════════════════════════════════════════
_project_root: str = os.environ.get("VIBESCODE_PROJECT_ROOT", os.getcwd())

def get_project_root() -> str:
    return _project_root

def set_project_root(path: str) -> str:
    global _project_root
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise ValueError(f"Path does not exist: {path}")
    if not p.is_dir():
        raise ValueError(f"Path is not a directory: {path}")
    _project_root = str(p)
    logger.info("Project root changed to: %s", _project_root)
    return _project_root

def _root() -> Path:
    return Path(get_project_root())

def _safe(rel: str) -> Path:
    """
    Accept EITHER:
      • An absolute path on any drive  (C:\\..., /home/..., D:\\...)
      • A path relative to project root
    Guards against traversal only when relative.
    """
    p = Path(rel).expanduser()
    if p.is_absolute():
        # Allow any absolute path — the user explicitly pointed here
        return p.resolve()
    # Relative — must stay inside project root
    root = _root()
    target = (root / rel).resolve()
    if not str(target).startswith(str(root)):
        raise ValueError(f"Path traversal blocked: {rel!r}")
    return target

def _run(cmd: str, timeout: int = 60, cwd: str | None = None) -> str:
    """Run a shell command; returns combined stdout + stderr."""
    work_dir = cwd or get_project_root()
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            cwd=work_dir, timeout=timeout,
        )
        return (r.stdout + r.stderr).strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"ERROR: command timed out after {timeout}s"
    except Exception as exc:
        return f"ERROR: {exc}"

# ══════════════════════════════════════════════════════════════════════════════
# EXTENSION STATE  — heartbeat registry, injection queue
# ══════════════════════════════════════════════════════════════════════════════

class ExtensionState:
    """
    Tracks the live state reported by the browser extension every ~2s.

    llm_state values (reported by extension DOM scan):
        "generating"  — AI is currently streaming a response
        "idle"        — AI finished, input is empty, send button may be inactive
        "injectable"  — input is empty and ready; safe to inject a new message
        "injecting"   — extension is currently typing/sending
        "unknown"     — no heartbeat received yet

    injectable == True when it's safe to inject the next queued message.
    """
    def __init__(self):
        self.connected:    bool  = False
        self.tab_id:       str   = ""
        self.platform:     str   = ""
        self.llm_state:    str   = "unknown"   # generating | idle | injectable | injecting
        self.last_seen:    float = 0.0
        self.inject_ack:   dict  = {}          # last ACK from extension
        self.mcp_ready:    bool  = False
        self.queue_depth:  int   = 0

    def update(self, data: dict):
        self.connected   = True
        self.tab_id      = data.get("tab_id", self.tab_id)
        self.platform    = data.get("platform", self.platform)
        self.llm_state   = data.get("llm_state", self.llm_state)
        self.mcp_ready   = data.get("mcp_ready", self.mcp_ready)
        self.last_seen   = time.time()

    def is_stale(self) -> bool:
        """No heartbeat for >8s → extension probably disconnected."""
        return self.connected and (time.time() - self.last_seen > 8.0)

    def can_inject(self) -> bool:
        if self.is_stale():
            return False
        return self.llm_state in ("injectable", "idle") and self.connected

    def to_dict(self) -> dict:
        age = round(time.time() - self.last_seen, 1) if self.last_seen else None
        return {
            "connected":   self.connected and not self.is_stale(),
            "stale":       self.is_stale(),
            "tab_id":      self.tab_id,
            "platform":    self.platform,
            "llm_state":   self.llm_state,
            "mcp_ready":   self.mcp_ready,
            "can_inject":  self.can_inject(),
            "last_seen_s": age,
            "queue_depth": _push_queue.qsize() if _push_queue else 0,
            "inject_ack":  self.inject_ack,
        }


_ext_state = ExtensionState()

# ══════════════════════════════════════════════════════════════════════════════
# PUSH QUEUE  — messages wait here until extension is injectable
# ══════════════════════════════════════════════════════════════════════════════
_push_queue: asyncio.Queue[dict] = asyncio.Queue()
_push_clients: dict[str, asyncio.Queue] = {}   # tab_id → per-client queue
_event_loop: asyncio.AbstractEventLoop | None = None

def push_to_extension(text: str, submit: bool = True, msg_id: str | None = None) -> str:
    """
    Thread-safe enqueue.  Returns the message ID.
    The dispatcher task (below) will inject it when the extension is ready.
    """
    global _event_loop
    mid = msg_id or str(uuid.uuid4())[:8]
    envelope = {"text": text, "submit": submit, "id": mid, "queued_at": time.time()}
    if _event_loop and _event_loop.is_running():
        _event_loop.call_soon_threadsafe(_push_queue.put_nowait, envelope)
    else:
        logger.warning("[push] Event loop not ready — message dropped: %.80s", text)
    return mid

async def _push_dispatcher():
    """
    Background task.
    Drains _push_queue and forwards each message to connected SSE clients,
    but only when the extension reports it is injectable.
    Messages that cannot be sent immediately are re-queued after a short wait.
    """
    while True:
        envelope = await _push_queue.get()
        text = envelope.get("text", "")

        # Wait until injectable (up to 120s total, then drop with a warning)
        deadline = time.time() + 120
        while not _ext_state.can_inject():
            if time.time() > deadline:
                logger.warning("[dispatcher] Dropped message (timeout waiting injectable): %.80s", text)
                break
            await asyncio.sleep(0.4)
        else:
            # Broadcast to all connected SSE clients
            payload = json.dumps(envelope)
            dead_tabs = []
            for tab_id, q in list(_push_clients.items()):
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    dead_tabs.append(tab_id)
            for tab_id in dead_tabs:
                _push_clients.pop(tab_id, None)
                logger.warning("[dispatcher] Removed full/dead client: %s", tab_id)

            logger.info("[dispatcher] Injected msg %s: %.80s", envelope.get("id"), text)

        # Brief cooldown so extension has time to actually start injecting
        await asyncio.sleep(0.5)

# ══════════════════════════════════════════════════════════════════════════════
# FASTMCP TOOLS
# ══════════════════════════════════════════════════════════════════════════════
mcp = FastMCP(name="vibescode-agent")

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv",
             ".mypy_cache", ".next", "dist", "build", ".turbo", "coverage",
             ".cache", "out", ".nuxt", ".svelte-kit"}

@mcp.tool()
def tree(path: str = ".") -> str:
    """Recursive directory tree.  path can be absolute or relative to project root."""
    try:
        root = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not root.exists():
        return f"ERROR: path not found: {path}"
    lines: list[str] = [str(root)]
    for p in sorted(root.rglob("*")):
        if any(part in SKIP_DIRS for part in p.parts):
            continue
        rel   = p.relative_to(root)
        depth = len(rel.parts) - 1
        icon  = "📁 " if p.is_dir() else "📄 "
        lines.append("  " * depth + icon + p.name)
    return "\n".join(lines) or "(empty)"


@mcp.tool()
def dir_list(path: str = ".") -> str:
    """List immediate contents of a directory."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: not found: {path}"
    items = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name))
    return "\n".join(("📁 " if p.is_dir() else "📄 ") + p.name for p in items) or "(empty)"


@mcp.tool()
def cat(path: str) -> str:
    """Read full file.  path can be absolute (any drive) or relative to project root."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: file not found: {path}"
    if not target.is_file():
        return f"ERROR: not a file: {path}"
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
        MAX  = 8_000
        if len(text) > MAX:
            return text[:MAX] + f"\n\n[TRUNCATED — {len(text)} total chars. Use cat_range to read more.]"
        return text
    except Exception as exc:
        return f"ERROR reading {path}: {exc}"


@mcp.tool()
def cat_range(path: str, start_line: int = 1, end_line: int = 100) -> str:
    """Read a line slice from a file.  path can be absolute or relative."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: file not found: {path}"
    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    s     = max(1, start_line) - 1
    e     = min(total, end_line)
    chunk = lines[s:e]
    header = f"# {path}  lines {s+1}–{e} of {total}\n"
    return header + "\n".join(f"{s+i+1:>6} │ {l}" for i, l in enumerate(chunk))


@mcp.tool()
def search(pattern: str, path: str = ".", extensions: str = "") -> str:
    """Regex search across files.  path can be absolute or relative."""
    try:
        root = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    exts = [x.strip() for x in extensions.split(",") if x.strip()] if extensions else []
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"ERROR: invalid regex: {exc}"
    results: list[str] = []
    for fpath in sorted(root.rglob("*")):
        if any(p in SKIP_DIRS for p in fpath.parts) or not fpath.is_file():
            continue
        if exts and fpath.suffix not in exts:
            continue
        try:
            for i, line in enumerate(fpath.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if rx.search(line):
                    try:
                        rel = fpath.relative_to(_root())
                    except ValueError:
                        rel = fpath  # absolute path outside root — show full path
                    results.append(f"{rel}:{i}: {line.rstrip()}")
                    if len(results) >= 200:
                        results.append("… (200 match limit)")
                        return "\n".join(results)
        except Exception:
            pass
    return "\n".join(results) or "No matches found."


@mcp.tool()
def write(path: str, content: str) -> str:
    """Create or overwrite a file.  path can be absolute or relative."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    lines = content.count("\n") + 1
    return f"OK: wrote {path} ({len(content)} chars, {lines} lines)"


@mcp.tool()
def patch(path: str, old_str: str, new_str: str) -> str:
    """Atomic find-and-replace in a file.  path can be absolute or relative."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: file not found: {path}"
    text = target.read_text(encoding="utf-8")
    if old_str not in text:
        snippet = text[:400] + ("…" if len(text) > 400 else "")
        return f"ERROR: old_str not found in {path}.\nFile preview:\n{snippet}"
    updated = text.replace(old_str, new_str, 1)
    target.write_text(updated, encoding="utf-8")
    return f"OK: patched {path}"


@mcp.tool()
def mkdir(path: str) -> str:
    """Create a directory (including parents)."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    target.mkdir(parents=True, exist_ok=True)
    return f"OK: created {path}"


@mcp.tool()
def delete(path: str) -> str:
    """Delete a single file."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: not found: {path}"
    if target.is_dir():
        return "ERROR: target is a directory — use shell to remove directories"
    target.unlink()
    return f"OK: deleted {path}"


@mcp.tool()
def shell(cmd: str, cwd: str = "") -> str:
    """
    Run any shell command.
    cwd: optional working directory (absolute or relative to project root).
    Defaults to project root.
    Works for Python, Node, npm, cargo, go, make — any runtime.
    """
    work = get_project_root()
    if cwd:
        try:
            work = str(_safe(cwd))
        except ValueError as e:
            return f"ERROR: {e}"
    logger.info("[shell] %s  (cwd=%s)", cmd, work)
    return _run(cmd, timeout=120, cwd=work)


@mcp.tool()
def run_tests(cmd: str = "", path: str = ".") -> str:
    """
    Run tests for any project type.
    cmd: custom test command (e.g. 'npm test', 'cargo test', 'pytest', 'go test ./...')
    If cmd is empty, auto-detects based on project files.
    """
    root = _root()
    if not cmd:
        if (root / "package.json").exists():
            cmd = "npm test --if-present"
        elif (root / "Cargo.toml").exists():
            cmd = "cargo test"
        elif (root / "go.mod").exists():
            cmd = "go test ./..."
        elif (root / "pyproject.toml").exists() or (root / "setup.py").exists():
            cmd = f"python -m pytest {path} --tb=short"
        elif (root / "Makefile").exists():
            cmd = "make test"
        else:
            cmd = f"python -m pytest {path} --tb=short"
    return _run(cmd, timeout=180)


@mcp.tool()
def lint(cmd: str = "", path: str = ".") -> str:
    """
    Run linter for any project type.
    cmd: custom lint command (e.g. 'eslint src', 'cargo clippy', 'flake8')
    Auto-detects if cmd is empty.
    """
    root = _root()
    if not cmd:
        if (root / "package.json").exists():
            cmd = "npm run lint --if-present"
        elif (root / "Cargo.toml").exists():
            cmd = "cargo clippy"
        elif (root / ".eslintrc.js").exists() or (root / ".eslintrc.json").exists():
            cmd = f"npx eslint {path}"
        else:
            cmd = f"python -m flake8 {path} --max-line-length=120"
    return _run(cmd, timeout=60)


@mcp.tool()
def git_status() -> str:
    """Git status."""
    return _run("git status --short --branch")


@mcp.tool()
def git_diff(path: str = "", staged: bool = False) -> str:
    """Git diff."""
    cmd = "git diff" + (" --cached" if staged else "")
    if path:
        cmd += f" -- {path}"
    return _run(cmd)


@mcp.tool()
def git_log(n: int = 10, path: str = "") -> str:
    """Git log."""
    cmd = f"git log --oneline -{n}"
    if path:
        cmd += f" -- {path}"
    return _run(cmd)


@mcp.tool()
def get_root() -> str:
    """Return the current project root path."""
    return get_project_root()


@mcp.tool()
def project_info() -> str:
    """
    Detect project type and give a summary.
    Works for Python, Node/React/Vue/Next, Rust, Go, Java, Ruby, PHP, etc.
    """
    root = _root()
    info: list[str] = [f"Project root: {root}"]

    markers = {
        "package.json":      "Node.js / JavaScript / TypeScript",
        "next.config.js":    "Next.js",
        "next.config.ts":    "Next.js (TypeScript)",
        "vite.config.ts":    "Vite",
        "vite.config.js":    "Vite",
        "nuxt.config.ts":    "Nuxt.js",
        "svelte.config.js":  "SvelteKit",
        "angular.json":      "Angular",
        "pyproject.toml":    "Python (pyproject)",
        "setup.py":          "Python (setup.py)",
        "manage.py":         "Django",
        "requirements.txt":  "Python (requirements)",
        "Cargo.toml":        "Rust",
        "go.mod":            "Go",
        "pom.xml":           "Java (Maven)",
        "build.gradle":      "Java/Kotlin (Gradle)",
        "Gemfile":           "Ruby",
        "composer.json":     "PHP",
        "Makefile":          "Make",
        ".git":              "Git repository",
    }
    for fname, label in markers.items():
        if (root / fname).exists():
            info.append(f"  ✓ {label}  ({fname})")

    # Count files by extension
    ext_counts: dict[str, int] = {}
    for f in root.rglob("*"):
        if any(p in SKIP_DIRS for p in f.parts) or not f.is_file():
            continue
        ext_counts[f.suffix] = ext_counts.get(f.suffix, 0) + 1
    top = sorted(ext_counts.items(), key=lambda x: -x[1])[:8]
    if top:
        info.append("  File types: " + ", ".join(f"{ext or 'no-ext'}×{n}" for ext, n in top))

    return "\n".join(info)


# ══════════════════════════════════════════════════════════════════════════════
# FASTAPI APP
# ══════════════════════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _event_loop
    _event_loop = asyncio.get_running_loop()
    # Start the injection dispatcher
    asyncio.create_task(_push_dispatcher())
    logger.info("VibesCode v11 started — root: %s", get_project_root())
    yield
    logger.info("VibesCode shutting down")


app = FastAPI(
    title="VibesCode Agent v11",
    description="MCP-powered coding agent with live extension state tracking",
    version="11.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.mount("/mcp", mcp.http_app(transport="sse"))

# ── Optional shared-secret auth helper ────────────────────────────────────────
SECRET = os.environ.get("VIBESCODE_SECRET", "")

def _check_auth(x_token: str | None):
    if SECRET and x_token != SECRET:
        raise HTTPException(status_code=403, detail="Invalid X-Token")

# ══════════════════════════════════════════════════════════════════════════════
# EXTENSION ↔ SERVER ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

async def _per_client_generator(tab_id: str) -> AsyncGenerator[bytes, None]:
    """SSE generator for a specific tab; uses a per-client queue."""
    q: asyncio.Queue[str] = asyncio.Queue(maxsize=50)
    _push_clients[tab_id] = q
    try:
        yield b": connected\n\n"
        while True:
            try:
                payload = await asyncio.wait_for(q.get(), timeout=15.0)
                yield f"event: inject\ndata: {payload}\n\n".encode()
            except asyncio.TimeoutError:
                yield b": keep-alive\n\n"
    finally:
        _push_clients.pop(tab_id, None)
        logger.info("[push] Client disconnected: %s", tab_id)


@app.get("/push/stream", tags=["Extension"])
async def push_stream(request: Request, tab: str = "default"):
    """
    SSE channel: extension connects here to receive injected messages.
    Each tab gets its own queue — safe for multiple tabs/windows.
    """
    return StreamingResponse(
        _per_client_generator(tab),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class PushRequest(BaseModel):
    text: str
    submit: bool = True
    id: Optional[str] = None


@app.post("/push/send", tags=["Extension"])
async def push_send(body: PushRequest, x_token: str | None = Header(default=None)) -> dict:
    """
    Enqueue a message to be injected into the AI chat.
    The dispatcher waits until the extension reports 'injectable' state before sending.

    Example:
        curl -X POST http://localhost:8000/push/send \\
          -H "Content-Type: application/json" \\
          -d '{"text": "Run the tests and fix any failures.", "submit": true}'
    """
    _check_auth(x_token)
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    mid = push_to_extension(body.text, body.submit, body.id)
    return {
        "ok":        True,
        "id":        mid,
        "queued":    body.text[:80],
        "queue_depth": _push_queue.qsize(),
        "ext_state": _ext_state.to_dict(),
    }


class AckRequest(BaseModel):
    tab_id: str = ""
    id:     str = ""
    sent:   bool = True


@app.post("/push/ack", tags=["Extension"])
async def push_ack(body: AckRequest) -> dict:
    """Extension calls this after successfully injecting a message."""
    _ext_state.inject_ack = {"id": body.id, "sent": body.sent, "at": time.time()}
    logger.info("[ack] tab=%s id=%s sent=%s", body.tab_id, body.id, body.sent)
    return {"ok": True}


class HeartbeatRequest(BaseModel):
    tab_id:    str  = ""
    platform:  str  = ""
    llm_state: str  = "unknown"   # generating | idle | injectable | injecting
    mcp_ready: bool = False


@app.post("/ext/heartbeat", tags=["Extension"])
async def ext_heartbeat(body: HeartbeatRequest) -> dict:
    """
    Extension POSTs this every ~2s with its live state.
    Server uses this to decide when it's safe to inject the next queued message.
    """
    _ext_state.update(body.model_dump())
    return {"ok": True, "queue_depth": _push_queue.qsize()}


@app.get("/ext/status", tags=["Extension"])
async def ext_status() -> dict:
    """
    Returns the full live state of the extension + LLM.

    llm_state:
        "generating"  — AI is streaming a response right now
        "idle"        — AI is done; input box may be empty
        "injectable"  — safe to inject a new message
        "injecting"   — extension is currently typing/sending
        "unknown"     — no heartbeat received yet

    can_inject:
        True when it is safe to send the next queued message.
    """
    return _ext_state.to_dict()


# ══════════════════════════════════════════════════════════════════════════════
# PROJECT ROOT ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

class SetRootRequest(BaseModel):
    path: str   # absolute path on any drive, e.g. C:\Users\me\myapp  or  /home/me/myapp


@app.get("/project/root", tags=["Project"])
async def project_root_get() -> dict:
    """Get the current project root."""
    return {"root": get_project_root(), "exists": Path(get_project_root()).exists()}


@app.post("/project/set", tags=["Project"])
async def project_root_set(body: SetRootRequest) -> dict:
    """
    Set the project root at runtime — no server restart needed.
    Works for any path on any drive (Windows C:\\, D:\\, Linux /home/, etc.)

    Example:
        curl -X POST http://localhost:8000/project/set \\
          -H "Content-Type: application/json" \\
          -d '{"path": "C:\\\\Users\\\\luckey\\\\Desktop\\\\myreactapp"}'
    """
    try:
        new_root = set_project_root(body.path)
        return {"ok": True, "root": new_root}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class DetectRootRequest(BaseModel):
    hint: str   # any file or folder path inside the project


@app.post("/project/detect", tags=["Project"])
async def project_root_detect(body: DetectRootRequest) -> dict:
    """
    Auto-detect project root from a hint path (any file or folder inside the project).
    Walks up from hint until it finds a known project marker
    (package.json, pyproject.toml, Cargo.toml, go.mod, .git, manage.py, etc.)

    Example:
        {"hint": "C:\\Users\\luckey\\Desktop\\myapp\\src\\index.tsx"}
        → detects "C:\\Users\\luckey\\Desktop\\myapp" as root
    """
    MARKERS = {
        "package.json", "pyproject.toml", "setup.py", "manage.py", "Cargo.toml",
        "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", ".git",
        "Makefile", "next.config.js", "next.config.ts", "vite.config.ts",
    }
    p = Path(body.hint).expanduser().resolve()
    if p.is_file():
        p = p.parent
    candidate = p
    for _ in range(10):  # walk up max 10 levels
        if any((candidate / m).exists() for m in MARKERS):
            try:
                new_root = set_project_root(str(candidate))
                return {"ok": True, "root": new_root, "detected_from": str(p)}
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
        parent = candidate.parent
        if parent == candidate:
            break
        candidate = parent
    # No marker found — just use the hint directory itself
    try:
        new_root = set_project_root(str(p))
        return {"ok": True, "root": new_root, "detected_from": str(p), "warning": "No project marker found; using hint directory"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ══════════════════════════════════════════════════════════════════════════════
# META ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

def _get_registered_tools() -> list:
    try:
        tm = getattr(mcp, "_tool_manager", None)
        if tm:
            tools = getattr(tm, "tools", None) or getattr(tm, "_tools", None)
            if isinstance(tools, dict):
                return list(tools.values())
            if tools:
                return list(tools)
        server = getattr(mcp, "_server", None)
        if server and hasattr(server, "list_tools"):
            return server.list_tools()
    except Exception as e:
        logger.warning("Tool registry introspection failed: %s", e)
    return []


@app.get("/health", tags=["Meta"])
async def health() -> dict:
    """Full health check including extension state and queue depth."""
    raw_tools = _get_registered_tools()
    tool_names = []
    for t in raw_tools:
        name = getattr(t, "name", None) or (t.get("name") if isinstance(t, dict) else str(t))
        if name:
            tool_names.append(name)
    return {
        "ok":          True,
        "server":      "vibescode-agent",
        "version":     "11.0.0",
        "project_root": get_project_root(),
        "tools":       tool_names,
        "tool_count":  len(tool_names),
        "queue_depth": _push_queue.qsize(),
        "extension":   _ext_state.to_dict(),
        "timestamp":   time.time(),
    }


@app.get("/tools", tags=["Meta"])
async def list_tools() -> dict:
    """List all MCP tools."""
    raw_tools = _get_registered_tools()
    tools = []
    for t in raw_tools:
        name = getattr(t, "name", t.get("name", "?") if isinstance(t, dict) else "?")
        desc = getattr(t, "description", t.get("description", "") if isinstance(t, dict) else "") or ""
        tools.append({"name": name, "description": desc.split("\n")[0]})
    return {"tools": tools, "total": len(tools)}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True, log_level="info")