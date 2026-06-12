"""
main.py — VibesCode Agent v13
══════════════════════════════════════════════════════════════════════════════
Single-port FastAPI server.  All endpoints:

  MCP (AI tool bridge)
  ─────────────────────────────────────────────────────
  GET  /mcp/sse              MCP SSE handshake
  POST /mcp/messages         MCP JSON-RPC tool calls

  Extension ↔ Server
  ─────────────────────────────────────────────────────
  GET  /push/stream          Server→Extension SSE channel
  POST /push/send            Enqueue message → AI chat
  POST /push/ack             Extension ACKs after inject
  POST /ext/heartbeat        Extension reports its live state every 2s
  GET  /ext/status           Rich extension+LLM state (generating, send button, etc.)

  Project root management
  ─────────────────────────────────────────────────────
  GET  /project/root         Get current project root
  POST /project/set          Set project root at runtime (any drive)
  POST /project/detect       Auto-detect root from a hint path

  Meta
  ─────────────────────────────────────────────────────
  GET  /health               Full health + queue depth + ext status
  GET  /tools                List registered MCP tools (JSON)
  GET  /docs                 Swagger UI

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Environment:
    VIBESCODE_PROJECT_ROOT   Initial project root (optional)
    VIBESCODE_SECRET         Shared token for /push/send auth (optional)
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


from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from starlette.types import ASGIApp, Scope, Receive, Send

class PrivateNetworkAccessMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            # Handle PNA preflight
            if scope["method"] == "OPTIONS":
                async def send_preflight(message):
                    if message["type"] == "http.response.start":
                        headers_list = list(message.get("headers", []))
                        headers_list += [
                            (b"access-control-allow-origin",          b"*"),
                            (b"access-control-allow-methods",         b"GET, POST, OPTIONS"),
                            (b"access-control-allow-headers",         b"*"),
                            (b"access-control-allow-private-network", b"true"),
                        ]
                        message["headers"] = headers_list
                    await send(message)
                await self.app(scope, receive, send_preflight)
                return

            # Inject PNA header into every response
            async def send_with_pna(message):
                if message["type"] == "http.response.start":
                    headers_list = list(message.get("headers", []))
                    headers_list.append(
                        (b"access-control-allow-private-network", b"true")
                    )
                    message["headers"] = headers_list
                await send(message)

            await self.app(scope, receive, send_with_pna)
        else:
            # websocket / lifespan — pass through untouched
            await self.app(scope, receive, send)
            
# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s — %(message)s",
)
logger = logging.getLogger("vibescode")

# ══════════════════════════════════════════════════════════════════════════════
# PROJECT ROOT  — fully dynamic, changeable at runtime via API or MCP tool
# ══════════════════════════════════════════════════════════════════════════════
_project_root: str = os.environ.get("VIBESCODE_PROJECT_ROOT", os.getcwd())


def get_project_root() -> str:
    return _project_root


def set_project_root(path: str) -> str:
    global _project_root
    # Normalize path separators: convert backslashes to forward slashes first
    path = path.replace("\\\\", "/").replace("\\", "/")
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
    Normalizes backslashes to forward slashes before processing.
    Guards against traversal only when relative.
    """
    # Normalize all backslash variants to forward slash
    rel = rel.replace("\\\\", "/").replace("\\", "/")
    p = Path(rel).expanduser()
    if p.is_absolute():
        return p.resolve()
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
# TEMPLATE / PLAN STORAGE  — persistent JSON file next to main.py
# ══════════════════════════════════════════════════════════════════════════════
_TEMPLATES_FILE = Path(__file__).parent / "vibescode_templates.json"


def _load_templates() -> dict:
    if _TEMPLATES_FILE.exists():
        try:
            return json.loads(_TEMPLATES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def _save_templates(data: dict) -> None:
    _TEMPLATES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ══════════════════════════════════════════════════════════════════════════════
# EXTENSION STATE  — heartbeat registry + rich LLM status
# ══════════════════════════════════════════════════════════════════════════════

class ExtensionState:
    """
    Tracks the live state reported by the browser extension every ~2s.

    llm_state values:
        "generating"  — AI is currently streaming a response
        "idle"        — AI finished; input is empty
        "injectable"  — input empty, send button active; safe to inject
        "injecting"   — extension is currently typing/sending
        "unknown"     — no heartbeat received yet

    send_button_status:
        "active"      — button visible and not disabled
        "disabled"    — button found but disabled (e.g. empty input)
        "not_found"   — no send button detected
        "unknown"     — not yet reported
    """

    def __init__(self):
        self.connected:           bool  = False
        self.tab_id:              str   = ""
        self.platform:            str   = ""
        self.llm_state:           str   = "unknown"
        self.send_button_status:  str   = "unknown"
        self.input_empty:         bool  = True
        self.bot_typing:          bool  = False
        self.page_url:            str   = ""
        self.last_seen:           float = 0.0
        self.inject_ack:          dict  = {}
        self.mcp_ready:           bool  = False
        self.queue_depth:         int   = 0

    def update(self, data: dict):
        self.connected          = True
        self.tab_id             = data.get("tab_id",             self.tab_id)
        self.platform           = data.get("platform",           self.platform)
        self.llm_state          = data.get("llm_state",          self.llm_state)
        self.send_button_status = data.get("send_button_status", self.send_button_status)
        self.input_empty        = data.get("input_empty",        self.input_empty)
        self.bot_typing         = data.get("bot_typing",         self.bot_typing)
        self.page_url           = data.get("page_url",           self.page_url)
        self.mcp_ready          = data.get("mcp_ready",          self.mcp_ready)
        self.last_seen          = time.time()

    def is_stale(self) -> bool:
        return self.connected and (time.time() - self.last_seen > 8.0)

    def can_inject(self) -> bool:
        if self.is_stale():
            return False
        return self.llm_state in ("injectable", "idle") and self.connected

    def to_dict(self) -> dict:
        age = round(time.time() - self.last_seen, 1) if self.last_seen else None
        return {
            "connected":           self.connected and not self.is_stale(),
            "stale":               self.is_stale(),
            "tab_id":              self.tab_id,
            "platform":            self.platform,
            "page_url":            self.page_url,
            "llm_state":           self.llm_state,
            "is_generating":       self.bot_typing,
            "send_button_status":  self.send_button_status,
            "send_button_active":  self.send_button_status == "active",
            "input_empty":         self.input_empty,
            "mcp_ready":           self.mcp_ready,
            "can_inject":          self.can_inject(),
            "last_seen_s":         age,
            "queue_depth":         _push_queue.qsize() if _push_queue else 0,
            "inject_ack":          self.inject_ack,
        }


_ext_state = ExtensionState()

# ══════════════════════════════════════════════════════════════════════════════
# PUSH QUEUE
# ══════════════════════════════════════════════════════════════════════════════
_push_queue: asyncio.Queue[dict] = asyncio.Queue()
_push_clients: dict[str, asyncio.Queue] = {}
_event_loop: asyncio.AbstractEventLoop | None = None


def push_to_extension(text: str, submit: bool = True, msg_id: str | None = None) -> str:
    global _event_loop
    mid = msg_id or str(uuid.uuid4())[:8]
    envelope = {"text": text, "submit": submit, "id": mid, "queued_at": time.time()}
    if _event_loop and _event_loop.is_running():
        _event_loop.call_soon_threadsafe(_push_queue.put_nowait, envelope)
    else:
        logger.warning("[push] Event loop not ready — message dropped: %.80s", text)
    return mid


async def _push_dispatcher():
    while True:
        envelope = await _push_queue.get()
        text = envelope.get("text", "")
        deadline = time.time() + 120
        while not _ext_state.can_inject():
            if time.time() > deadline:
                logger.warning("[dispatcher] Dropped message (timeout): %.80s", text)
                break
            await asyncio.sleep(0.4)
        else:
            payload = json.dumps(envelope)
            dead_tabs = []
            for tab_id, q in list(_push_clients.items()):
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    dead_tabs.append(tab_id)
            for tab_id in dead_tabs:
                _push_clients.pop(tab_id, None)
            logger.info("[dispatcher] Injected msg %s: %.80s", envelope.get("id"), text)
        await asyncio.sleep(0.5)


# ══════════════════════════════════════════════════════════════════════════════
# FASTMCP TOOLS
# ══════════════════════════════════════════════════════════════════════════════
mcp = FastMCP(name="vibescode-agent")

SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv",
             ".mypy_cache", ".next", "dist", "build", ".turbo", "coverage",
             ".cache", "out", ".nuxt", ".svelte-kit"}

# ── Project root tools (AI-callable) ──────────────────────────────────────────

@mcp.tool()
def set_root(path: str) -> str:
    """
    Set the project root dynamically to any absolute path on any drive.

    Accepts Windows paths with single or double backslashes, forward slashes,
    and Unix paths. All path separators are normalised automatically.

    Examples:
        {"path": "C:\\\\Users\\\\user\\\\Desktop\\\\myapp"}
        {"path": "C:/Users/user/Desktop/myapp"}
        {"path": "/home/user/projects/myapp"}
        {"path": "D:/work/backend"}

    Call this at the start of every session when the user mentions a project path,
    or when switching to a different project.
    Returns the resolved absolute path of the new root.
    """
    try:
        new_root = set_project_root(path)
        return f"OK: project root set to {new_root}"
    except ValueError as e:
        return f"ERROR: {e}"


@mcp.tool()
def detect_root(hint: str) -> str:
    """
    Auto-detect project root from any file or folder path inside the project.

    Accepts Windows paths (backslashes, double-backslashes) or Unix paths.
    All separators are normalised before use.

    Walks up from the hint path until it finds a project marker
    (package.json, pyproject.toml, Cargo.toml, go.mod, .git, manage.py, etc.)

    Examples:
        {"hint": "C:\\\\Users\\\\user\\\\Desktop\\\\myapp\\\\src\\\\index.tsx"}
        {"hint": "C:/Users/user/Desktop/myapp/src/index.tsx"}
        → detects C:/Users/user/Desktop/myapp as root

    Use this when the user pastes a file path or folder path and you need
    to determine the project root automatically.
    """
    MARKERS = {
        "package.json", "pyproject.toml", "setup.py", "manage.py", "Cargo.toml",
        "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", ".git",
        "Makefile", "next.config.js", "next.config.ts", "vite.config.ts",
    }
    # Normalise separators
    hint = hint.replace("\\\\", "/").replace("\\", "/")
    p = Path(hint).expanduser().resolve()
    if p.is_file():
        p = p.parent
    candidate = p
    for _ in range(10):
        if any((candidate / m).exists() for m in MARKERS):
            try:
                new_root = set_project_root(str(candidate))
                return f"OK: project root detected and set to {new_root}"
            except ValueError as e:
                return f"ERROR: {e}"
        parent = candidate.parent
        if parent == candidate:
            break
        candidate = parent
    try:
        new_root = set_project_root(str(p))
        return f"OK: no project marker found; set root to hint directory {new_root}"
    except ValueError as e:
        return f"ERROR: {e}"


import inspect

@mcp.tool()
async def list_mcp_tools() -> str:
    """
    List every tool currently registered on this MCP server.

    Returns the tool name and first line of its description.
    Use this at the start of a session to remind yourself what operations
    are available, or when you are unsure which tool to call.
    No parameters required.
    """
    tools = None

    if hasattr(mcp, "list_tools"):
        maybe = mcp.list_tools()
        if inspect.isawaitable(maybe):
            tools = await maybe
        else:
            tools = maybe

    if not tools:
        return "No tools registered (registry not ready or async unavailable)."

    lines = ["Available MCP tools:\n"]
    for t in tools:
        name = getattr(t, "name", str(t))
        raw_desc = getattr(t, "description", "") or getattr(t, "__doc__", "")
        desc = raw_desc if raw_desc is not None else ""
        split_lines = desc.splitlines()
        first_line = split_lines[0][:120] if split_lines else "No description provided."
        lines.append(f"  • {name}: {first_line}")

    return "\n".join(lines)


# ── File & directory tools ─────────────────────────────────────────────────────

@mcp.tool()
def tree(path: str = ".") -> str:
    """
    Recursive directory tree starting at the given path.

    Skips common noise directories: .git, node_modules, __pycache__, .venv,
    dist, build, .next, .turbo, coverage, .cache, out, .nuxt, .svelte-kit.

    path: absolute path (any drive, backslashes or forward slashes) or
          relative to project root. Use "." to list the project root.
    Use set_root / detect_root first if the project root is not yet set correctly.

    Returns a tree with 📁 for directories and 📄 for files.
    """
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
    """
    List the immediate (non-recursive) contents of a directory.

    path: absolute path (any drive, backslashes or forward slashes) or
          relative to project root. Defaults to the project root.

    Returns one entry per line prefixed with 📁 (directory) or 📄 (file).
    Use tree for a deep recursive listing.
    """
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
    """
    Read the full contents of a file and return them as plain text.

    path: absolute path (any drive, backslashes or forward slashes accepted)
          or relative to project root.

    Files larger than 8 000 characters are NOT truncated — the entire file is
    returned so the agent always sees the complete source.  Use cat_range to
    page through very large files when you only need a specific section.

    Always call cat before editing any file so you work with the real content.
    """
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
        return text
    except Exception as exc:
        return f"ERROR reading {path}: {exc}"


@mcp.tool()
def cat_range(path: str, start_line: int = 1, end_line: int = 100) -> str:
    """
    Read a specific range of lines from a file (1-based, inclusive).

    path: absolute path (any drive) or relative to project root.
    start_line: first line to return (1-based, default 1).
    end_line:   last line to return (1-based, inclusive, default 100).

    Use this to page through large files. Each returned line is prefixed with
    its line number so you can reference exact positions when patching.

    Example: {"path": "src/main.py", "start_line": 50, "end_line": 120}
    """
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
    """
    Search files for a regex pattern and return matching lines with locations.

    pattern:    Python regular expression (case-insensitive).
    path:       Root directory to search (absolute or relative to project root).
                Defaults to the entire project root.
    extensions: Optional comma-separated file extension filter, e.g. ".py,.ts".
                Leave empty to search all file types.

    Returns up to 200 matching lines in the format  file:line: content.
    Skips noise directories (.git, node_modules, __pycache__, etc.)

    Examples:
        {"pattern": "def handle_request", "extensions": ".py"}
        {"pattern": "TODO|FIXME", "path": "src"}
        {"pattern": "import.*axios", "extensions": ".ts,.tsx"}
    """
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
                        rel = fpath
                    results.append(f"{rel}:{i}: {line.rstrip()}")
                    if len(results) >= 200:
                        results.append("… (200 match limit)")
                        return "\n".join(results)
        except Exception:
            pass
    return "\n".join(results) or "No matches found."


@mcp.tool()
def write(path: str, content: str) -> str:
    """
    Create a new file or completely overwrite an existing one.

    path:    Absolute path (any drive, backslashes or forward slashes) or
             relative to project root.
    content: The full file content as a plain string.

    Parent directories are created automatically.
    CAUTION: this overwrites existing files without confirmation.
    Prefer patch for targeted edits to avoid accidentally erasing code.
    Always cat the file first unless you are creating it from scratch.
    """
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    lines = content.count("\n") + 1
    return f"OK: wrote {path} ({len(content)} chars, {lines} lines)"


def _normalize_newlines(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\r", "\n")


def _strip_trailing_ws_per_line(s: str) -> str:
    return "\n".join(line.rstrip() for line in s.split("\n"))


def _count_line_block_matches(text: str, old_str: str) -> int:
    text_lines = _normalize_newlines(text).split("\n")
    old_lines = _normalize_newlines(old_str).split("\n")
    if not old_lines or (len(old_lines) == 1 and old_lines[0] == ""):
        return 0
    n = len(old_lines)
    count = 0
    for i in range(len(text_lines) - n + 1):
        window = text_lines[i : i + n]
        if all(window[j].rstrip() == old_lines[j].rstrip() for j in range(n)):
            count += 1
    return count


def _find_line_block_span(text: str, old_str: str) -> tuple[int, int] | None:
    """Find byte span of old_str in text using line-by-line match (trailing ws ignored)."""
    if _count_line_block_matches(text, old_str) != 1:
        return None
    text_lines = _normalize_newlines(text).split("\n")
    old_lines = _normalize_newlines(old_str).split("\n")
    n = len(old_lines)
    for i in range(len(text_lines) - n + 1):
        window = text_lines[i : i + n]
        if all(window[j].rstrip() == old_lines[j].rstrip() for j in range(n)):
            prefix = "\n".join(text_lines[:i])
            if i > 0:
                prefix += "\n"
            start = len(prefix)
            matched = "\n".join(text_lines[i : i + n])
            return start, start + len(matched)
    return None


def _apply_patch(text: str, old_str: str, new_str: str) -> tuple[str | None, str | None]:
    """
    Layered patch matching (Aider-inspired):
      1. exact substring
      2. CRLF-normalized
      3. trailing-whitespace-normalized per line
      4. line-block match (unique only)
    Returns (updated_text, method) or (None, error_message).
    """
    if old_str in text:
        count = text.count(old_str)
        if count == 1:
            return text.replace(old_str, new_str, 1), "exact"
        return None, f"ERROR: old_str appears {count} times — make it more specific so it matches exactly once."

    norm_text = _normalize_newlines(text)
    norm_old = _normalize_newlines(old_str)
    norm_new = _normalize_newlines(new_str)
    if norm_old in norm_text:
        count = norm_text.count(norm_old)
        if count == 1:
            return norm_text.replace(norm_old, norm_new, 1), "crlf_normalized"
        return None, f"ERROR: old_str appears {count} times (after CRLF normalize) — add more context."

    ws_text = _strip_trailing_ws_per_line(norm_text)
    ws_old = _strip_trailing_ws_per_line(norm_old)
    ws_new = _strip_trailing_ws_per_line(norm_new)
    if ws_old in ws_text:
        count = ws_text.count(ws_old)
        if count == 1:
            return ws_text.replace(ws_old, ws_new, 1), "trailing_ws_normalized"
        return None, f"ERROR: old_str appears {count} times (after ws normalize) — add more context."

    span = _find_line_block_span(norm_text, norm_old)
    if span:
        start, end = span
        return norm_text[:start] + norm_new + norm_text[end:], "line_block"

    return None, None


@mcp.tool()
def patch(path: str, old_str: str, new_str: str) -> str:
    """
    Perform a precise, atomic find-and-replace edit inside a file.

    path:    Absolute path or relative to project root.
    old_str: The exact string to locate in the file. Must appear EXACTLY ONCE.
             Make it specific enough to be unique — include surrounding lines if needed.
    new_str: The replacement string. Use an empty string to delete old_str.

    Always cat the file first to confirm old_str is present and unique.
    If old_str appears more than once the tool returns an error; add more context.
    This is the safest way to edit files — prefer it over write for targeted changes.

    Example:
        {
          "path": "src/app.py",
          "old_str": "def hello():\\n    return 'hi'",
          "new_str": "def hello():\\n    return 'hello, world'"
        }
    """
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: file not found: {path}"
    text = target.read_text(encoding="utf-8")
    updated, method = _apply_patch(text, old_str, new_str)
    if updated is None:
        if method:
            return method
        snippet = text[:400] + ("…" if len(text) > 400 else "")
        return f"ERROR: old_str not found in {path}.\nFile preview:\n{snippet}"
    target.write_text(updated, encoding="utf-8")
    suffix = f" ({method})" if method and method != "exact" else ""
    return f"OK: patched {path}{suffix}"


@mcp.tool()
def mkdir(path: str) -> str:
    """
    Create a directory and all its parent directories (equivalent to mkdir -p).

    path: Absolute path (any drive) or relative to project root.
    Does nothing if the directory already exists.
    Returns OK with the resolved path on success.
    """
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    target.mkdir(parents=True, exist_ok=True)
    return f"OK: created {path}"


@mcp.tool()
def delete(path: str) -> str:
    """
    Delete a single file permanently.

    path: Absolute path or relative to project root.
    Only works on files — use shell with rm -rf or rmdir to remove directories.
    Returns an error if the path does not exist or is a directory.

    CAUTION: deletion is irreversible. Confirm the path with cat or dir_list first.
    """
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


# ── Shell / execution tools ───────────────────────────────────────────────────

@mcp.tool()
def shell(cmd: str, cwd: str = "", timeout: int = 120) -> str:
    """
    Execute any shell command and return the combined stdout + stderr output.

    cmd:     Any shell command string — supports pipes, redirection, &&, ||, etc.
    cwd:     Working directory (absolute path or relative to project root).
             Defaults to the project root if empty.
    timeout: Maximum seconds before the command is killed. Default 120, max 600.

    Works for ALL runtimes and tools:
        Python  — pip, pytest, manage.py, scripts
        Node    — npm, yarn, pnpm, npx, node
        Rust    — cargo build, cargo test, cargo run
        Go      — go build, go test, go run
        Java    — mvn, gradle
        Git     — git status, git commit, git push
        System  — curl, find, cat, ls, type, dir, powershell

    Safe command patterns (no quoting issues):
        {"cmd": "npm install && npm run build"}
        {"cmd": "python -m pytest tests/ -v --tb=short"}
        {"cmd": "cargo build --release", "timeout": 300}
        {"cmd": "git log --oneline -20"}
        {"cmd": "dir C:/Users/foo/project"}

    CAUTION: runs with server process permissions.
    Avoid destructive commands (rm -rf, DROP TABLE) unless explicitly requested.
    Use cat instead of shell for reading files.
    """
    work = get_project_root()
    if cwd:
        try:
            work = str(_safe(cwd))
        except ValueError as e:
            return f"ERROR: {e}"
    timeout = min(timeout, 600)
    logger.info("[shell] %s  (cwd=%s, timeout=%ss)", cmd, work, timeout)
    return _run(cmd, timeout=timeout, cwd=work)


@mcp.tool()
def run_tests(cmd: str = "", path: str = ".") -> str:
    """
    Run the project test suite with auto-detection of the test framework.

    cmd:  Custom test command. If empty, the tool detects the right command:
          • package.json  → npm test --if-present
          • Cargo.toml    → cargo test
          • go.mod        → go test ./...
          • pyproject.toml / setup.py → python -m pytest <path> --tb=short
          • Makefile      → make test
          • fallback      → python -m pytest <path> --tb=short

    path: Scope pytest to a specific directory or file (only used for Python).

    Examples:
        {}                              — auto-detect and run all tests
        {"cmd": "npm run test:unit"}    — run a specific npm script
        {"cmd": "pytest src/ -k login"} — run only tests matching "login"
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
    Run the project linter with auto-detection of the linting tool.

    cmd:  Custom lint command. If empty, the tool detects the right command:
          • package.json  → npm run lint --if-present
          • Cargo.toml    → cargo clippy
          • .eslintrc.*   → npx eslint <path>
          • fallback      → python -m flake8 <path> --max-line-length=120

    path: Scope linting to a specific directory or file (used in fallback mode).

    Examples:
        {}                              — auto-detect and lint everything
        {"cmd": "npx eslint src/ --fix"} — lint and auto-fix JS/TS
        {"cmd": "ruff check ."}          — use ruff for Python
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


# ── Git tools ─────────────────────────────────────────────────────────────────

@mcp.tool()
def git_status() -> str:
    """
    Show the current git working tree status in short format with branch name.

    Equivalent to: git status --short --branch
    Returns the branch, staged changes (A/M/D), and unstaged changes (M/D/?).
    No parameters required.
    """
    return _run("git status --short --branch")


@mcp.tool()
def git_diff(path: str = "", staged: bool = False) -> str:
    """
    Show the diff of working tree changes (or staged changes).

    path:   Optional file or directory to scope the diff to.
            Leave empty to diff the entire repository.
    staged: Set to true to show staged (--cached) changes instead of
            unstaged working-tree changes. Default false.

    Examples:
        {}                         — show all unstaged changes
        {"staged": true}           — show what is staged for commit
        {"path": "src/api.py"}     — diff a specific file
    """
    cmd = "git diff" + (" --cached" if staged else "")
    if path:
        cmd += f" -- {path}"
    return _run(cmd)


@mcp.tool()
def git_log(n: int = 10, path: str = "") -> str:
    """
    Show recent git commit history in compact one-line format.

    n:    Number of commits to show. Default 10.
    path: Optional file or directory to scope the log to.
          Leave empty to show the full project history.

    Each line shows: <short-hash> <commit message>

    Examples:
        {}                  — last 10 commits
        {"n": 25}           — last 25 commits
        {"path": "src/"}    — commits that touched the src directory
    """
    cmd = f"git log --oneline -{n}"
    if path:
        cmd += f" -- {path}"
    return _run(cmd)


# ── Info tools ────────────────────────────────────────────────────────────────

@mcp.tool()
def get_root() -> str:
    """
    Return the current project root path as a string.

    No parameters required.
    Call this at the very start of every session to confirm where you are
    before exploring the filesystem or making any edits.
    """
    return get_project_root()


@mcp.tool()
def project_info() -> str:
    """
    Detect the project type and summarise the workspace at a glance.

    Checks the project root for framework/language marker files
    (package.json, pyproject.toml, Cargo.toml, go.mod, manage.py, etc.)
    and reports the top file types by count.

    No parameters required.
    Call this after get_root / detect_root to orient yourself before exploring.
    The output tells you what runtime, framework, and languages are in use
    so you can pick the right commands and tools.
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
    ext_counts: dict[str, int] = {}
    for f in root.rglob("*"):
        if any(p in SKIP_DIRS for p in f.parts) or not f.is_file():
            continue
        ext_counts[f.suffix] = ext_counts.get(f.suffix, 0) + 1
    top = sorted(ext_counts.items(), key=lambda x: -x[1])[:8]
    if top:
        info.append("  File types: " + ", ".join(f"{ext or 'no-ext'}×{n}" for ext, n in top))
    return "\n".join(info)


@mcp.tool()
def rules() -> str:
    """
    Return the VibesCode Agent system prompt / rules.
    
    Call this at the start of every session to load the full agent rules,
    tool reference, and behavior guidelines.
    No parameters required.
    just type AGENT_CALL {"op":"rules"} to get the full text of the human prompt. Keep it handy for reference!
    """
    rules_file = Path(__file__).parent / "system_prompt.txt"
    if not rules_file.exists():
        return "ERROR: system_prompt.txt not found next to main.py"
    try:
        return rules_file.read_text(encoding="utf-8")
    except Exception as exc:
        return f"ERROR reading system_prompt.txt: {exc}"

# ── Template / Plan tools ─────────────────────────────────────────────────────

@mcp.tool()
def template_prompt(
    action: str,
    name: str = "",
    content: str = "",
    tag: str = "",
) -> str:
    """
    Store, retrieve, list, and delete reusable prompt templates and task plans.

    Templates are persisted to disk (vibescode_templates.json next to main.py)
    so they survive server restarts and are shared across all sessions.

    action — one of:
        "save"    Save or overwrite a template.
                  Requires: name (unique key), content (the prompt text).
                  Optional: tag (category label, e.g. "plan", "system", "task").
        "get"     Retrieve a single template by name.
                  Requires: name.
        "list"    List all stored templates (name + tag + first 80 chars).
                  Optional: tag to filter by category.
        "delete"  Delete a template by name.
                  Requires: name.

    Use cases:
        • Store the master system prompt so every session starts consistently.
        • Save a task plan at the start of a large feature so any sub-task
          can load it and know the full context and remaining steps.
        • Keep reusable prompt snippets (debugging guide, code-style rules, etc.)

    Examples:
        Save a plan:
            {
              "action": "save",
              "name": "feature/auth-refactor",
              "tag": "plan",
              "content": "## Goal\\nRefactor auth to use JWT...\\n## Steps\\n1. Read current auth.py\\n2. ..."
            }

        Retrieve it in any later session:
            {"action": "get", "name": "feature/auth-refactor"}

        List all plans:
            {"action": "list", "tag": "plan"}

        Delete when done:
            {"action": "delete", "name": "feature/auth-refactor"}
    """
    data = _load_templates()

    if action == "save":
        if not name:
            return "ERROR: name is required for action=save"
        if not content:
            return "ERROR: content is required for action=save"
        data[name] = {
            "content": content,
            "tag": tag or "general",
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        _save_templates(data)
        return f"OK: saved template '{name}' (tag={tag or 'general'}, {len(content)} chars)"

    elif action == "get":
        if not name:
            return "ERROR: name is required for action=get"
        if name not in data:
            available = ", ".join(sorted(data.keys())) or "(none)"
            return f"ERROR: template '{name}' not found. Available: {available}"
        entry = data[name]
        return (
            f"# Template: {name}\n"
            f"# Tag: {entry.get('tag','')}\n"
            f"# Updated: {entry.get('updated_at','')}\n\n"
            f"{entry['content']}"
        )

    elif action == "list":
        if not data:
            return "No templates stored yet."
        rows = []
        for k, v in sorted(data.items()):
            if tag and v.get("tag", "") != tag:
                continue
            preview = v["content"][:80].replace("\n", " ")
            rows.append(f"  [{v.get('tag',''):10s}] {k}\n             {preview}…")
        return f"Stored templates ({len(rows)} shown):\n" + "\n".join(rows) if rows else "No templates match that tag."

    elif action == "delete":
        if not name:
            return "ERROR: name is required for action=delete"
        if name not in data:
            return f"ERROR: template '{name}' not found."
        del data[name]
        _save_templates(data)
        return f"OK: deleted template '{name}'"

    else:
        return f"ERROR: unknown action '{action}'. Use: save, get, list, delete"


# ══════════════════════════════════════════════════════════════════════════════
# FASTAPI APP
# ══════════════════════════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _event_loop
    _event_loop = asyncio.get_running_loop()
    asyncio.create_task(_push_dispatcher())
    logger.info("VibesCode v13 started — root: %s", get_project_root())
    yield
    logger.info("VibesCode shutting down")


app = FastAPI(
    title="VibesCode Agent v13",
    description="MCP-powered coding agent with dynamic project root, template store, and rich status",
    version="13.0.0",
    lifespan=lifespan,
)

app.add_middleware(PrivateNetworkAccessMiddleware)
# Keep your existing CORSMiddleware too

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


mcp_app = mcp.http_app(transport="sse")
app.mount("/mcp", mcp_app)

SECRET = os.environ.get("VIBESCODE_SECRET", "")


def _check_auth(x_token: str | None):
    if SECRET and x_token != SECRET:
        raise HTTPException(status_code=403, detail="Invalid X-Token")


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


# ══════════════════════════════════════════════════════════════════════════════
# EXTENSION ↔ SERVER ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

async def _per_client_generator(tab_id: str) -> AsyncGenerator[bytes, None]:
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
    _check_auth(x_token)
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    mid = push_to_extension(body.text, body.submit, body.id)
    return {
        "ok":          True,
        "id":          mid,
        "queued":      body.text[:80],
        "queue_depth": _push_queue.qsize(),
        "ext_state":   _ext_state.to_dict(),
    }


class AckRequest(BaseModel):
    tab_id: str = ""
    id:     str = ""
    sent:   bool = True


@app.post("/push/ack", tags=["Extension"])
async def push_ack(body: AckRequest) -> dict:
    _ext_state.inject_ack = {"id": body.id, "sent": body.sent, "at": time.time()}
    logger.info("[ack] tab=%s id=%s sent=%s", body.tab_id, body.id, body.sent)
    return {"ok": True}


class HeartbeatRequest(BaseModel):
    tab_id:             str  = ""
    platform:           str  = ""
    llm_state:          str  = "unknown"
    send_button_status: str  = "unknown"
    input_empty:        bool = True
    bot_typing:         bool = False
    page_url:           str  = ""
    mcp_ready:          bool = False


@app.post("/ext/heartbeat", tags=["Extension"])
async def ext_heartbeat(body: HeartbeatRequest) -> dict:
    _ext_state.update(body.model_dump())
    return {"ok": True, "queue_depth": _push_queue.qsize()}


@app.get("/ext/status", tags=["Extension"])
async def ext_status() -> dict:
    return _ext_state.to_dict()


# ══════════════════════════════════════════════════════════════════════════════
# PROJECT ROOT HTTP ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

class SetRootRequest(BaseModel):
    path: str


@app.get("/project/root", tags=["Project"])
async def project_root_get() -> dict:
    return {"root": get_project_root(), "exists": Path(get_project_root()).exists()}


@app.post("/project/set", tags=["Project"])
async def project_root_set(body: SetRootRequest) -> dict:
    try:
        new_root = set_project_root(body.path)
        return {"ok": True, "root": new_root}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class DetectRootRequest(BaseModel):
    hint: str


@app.post("/project/detect", tags=["Project"])
async def project_root_detect(body: DetectRootRequest) -> dict:
    MARKERS = {
        "package.json", "pyproject.toml", "setup.py", "manage.py", "Cargo.toml",
        "go.mod", "pom.xml", "build.gradle", "Gemfile", "composer.json", ".git",
        "Makefile", "next.config.js", "next.config.ts", "vite.config.ts",
    }
    hint = body.hint.replace("\\\\", "/").replace("\\", "/")
    p = Path(hint).expanduser().resolve()
    if p.is_file():
        p = p.parent
    candidate = p
    for _ in range(10):
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
    try:
        new_root = set_project_root(str(p))
        return {"ok": True, "root": new_root, "detected_from": str(p),
                "warning": "No project marker found; using hint directory"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


# ══════════════════════════════════════════════════════════════════════════════
# TEMPLATES HTTP ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

class TemplateSaveRequest(BaseModel):
    name: str
    content: str
    tag: str = "general"


@app.get("/templates", tags=["Templates"])
async def templates_list(tag: str = "") -> dict:
    """List all stored templates, optionally filtered by tag."""
    data = _load_templates()
    items = []
    for k, v in sorted(data.items()):
        if tag and v.get("tag", "") != tag:
            continue
        items.append({"name": k, "tag": v.get("tag", ""), "updated_at": v.get("updated_at", ""),
                      "preview": v["content"][:120]})
    return {"templates": items, "total": len(items)}


@app.get("/templates/{name:path}", tags=["Templates"])
async def templates_get(name: str) -> dict:
    """Get a single template by name."""
    data = _load_templates()
    if name not in data:
        raise HTTPException(status_code=404, detail=f"Template '{name}' not found")
    return {"name": name, **data[name]}


@app.post("/templates", tags=["Templates"])
async def templates_save(body: TemplateSaveRequest) -> dict:
    """Save or overwrite a template."""
    data = _load_templates()
    data[body.name] = {"content": body.content, "tag": body.tag,
                       "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    _save_templates(data)
    return {"ok": True, "name": body.name}


@app.delete("/templates/{name:path}", tags=["Templates"])
async def templates_delete(name: str) -> dict:
    """Delete a template by name."""
    data = _load_templates()
    if name not in data:
        raise HTTPException(status_code=404, detail=f"Template '{name}' not found")
    del data[name]
    _save_templates(data)
    return {"ok": True, "deleted": name}


# ══════════════════════════════════════════════════════════════════════════════
# META ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health", tags=["Meta"])
async def health() -> dict:
    raw_tools = _get_registered_tools()
    tool_names = []
    for t in raw_tools:
        name = getattr(t, "name", None) or (t.get("name") if isinstance(t, dict) else str(t))
        if name:
            tool_names.append(name)
    return {
        "ok":           True,
        "server":       "vibescode-agent",
        "version":      "13.0.0",
        "project_root": get_project_root(),
        "tools":        tool_names,
        "tool_count":   len(tool_names),
        "queue_depth":  _push_queue.qsize(),
        "extension":    _ext_state.to_dict(),
        "timestamp":    time.time(),
    }


@app.get("/tools", tags=["Meta"])
async def list_tools_endpoint() -> dict:
    raw_tools = _get_registered_tools()
    tools = []
    for t in raw_tools:
        name = getattr(t, "name", t.get("name", "?") if isinstance(t, dict) else "?")
        desc = getattr(t, "description", t.get("description", "") if isinstance(t, dict) else "") or ""
        tools.append({"name": name, "description": desc.strip().split("\n")[0][:200]})
    return {"tools": tools, "total": len(tools)}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="127.0.0.1", port=port, reload=False, log_level="info")

# pyinstaller --onefile --add-data "system_prompt.txt;." --hidden-import="main" main.py