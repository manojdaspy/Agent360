"""
main.py
══════════════════════════════════════════════════════════════════════════════
VibesCode — FastAPI single-port server

Runs everything on ONE port (default 8000):
  GET  /mcp/sse         → MCP SSE handshake 
  POST /mcp/messages    → MCP JSON-RPC POST (tool calls)
  GET  /push/stream     → Server→Extension push channel (EventSource)
  POST /push/send       → Enqueue a message to inject into AI chat
  GET  /health          → Liveness probe
  GET  /docs            → FastAPI interactive docs (Swagger UI)

Run:
    uvicorn main:app --port 8000 --reload
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
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

# ✨ Standalone FastMCP package import
from fastmcp import FastMCP

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s — %(message)s",
)
logger = logging.getLogger("vibescode")


def get_project_root() -> str:
    """Resolution order: 1. VIBESCODE_PROJECT_ROOT env var, 2. Current working directory."""
    return os.environ.get("VIBESCODE_PROJECT_ROOT", os.getcwd())


# ── Push Channel ──────────────────────────────────────────────────────────────
_push_queue: asyncio.Queue[str] = asyncio.Queue()
_event_loop: asyncio.AbstractEventLoop | None = None


def push_to_extension(text: str, submit: bool = True) -> None:
    """Thread-safe call to push messages downstream to the browser extension queue."""
    global _event_loop
    envelope = json.dumps({"text": text, "submit": submit})
    if _event_loop and _event_loop.is_running():
        _event_loop.call_soon_threadsafe(_push_queue.put_nowait, envelope)
    else:
        logger.warning("[push] Event loop not ready — message dropped: %.80s", text)


# ── FastMCP Server Instance ───────────────────────────────────────────────────
mcp = FastMCP(name="vibescode-agent")


# ── Path Helpers ──────────────────────────────────────────────────────────────
def _root() -> Path:
    return Path(get_project_root()).resolve()


def _safe(rel: str) -> Path:
    """Resolve relative paths securely, guarding against directory traversal attacks."""
    root = _root()
    target = (root / rel).resolve()
    if not str(target).startswith(str(root)):
        raise ValueError(f"Path traversal blocked: {rel!r}")
    return target


def _run(cmd: str, timeout: int = 30) -> str:
    """Run shell commands from the project root and grab combined stdout + stderr."""
    try:
        r = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            cwd=get_project_root(),
            timeout=timeout,
        )
        return (r.stdout + r.stderr).strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"ERROR: timed out after {timeout}s"
    except Exception as exc:
        return f"ERROR: {exc}"


# ── Filesystem Tools ──────────────────────────────────────────────────────────
@mcp.tool()
def tree(path: str = ".") -> str:
    """Recursively list directory tree from project root skipping noise folders."""
    SKIP = {".git", "__pycache__", "node_modules", ".venv", "venv", ".mypy_cache"}
    root = _root() / path
    if not root.exists():
        return f"ERROR: path not found: {path}"
    lines: list[str] = [str(root)]
    for p in sorted(root.rglob("*")):
        if any(part in SKIP for part in p.parts):
            continue
        rel = p.relative_to(root)
        depth = len(rel.parts) - 1
        icon = "📁 " if p.is_dir() else "📄 "
        lines.append("  " * depth + icon + p.name)
    return "\n".join(lines) or "(empty)"


@mcp.tool()
def dir_list(path: str = ".") -> str:
    """List immediate contents of a directory."""
    target = _root() / path
    if not target.exists():
        return f"ERROR: not found: {path}"
    items = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name))
    return "\n".join(("📁 " if p.is_dir() else "📄 ") + p.name for p in items) or "(empty)"


@mcp.tool()
def cat(path: str) -> str:
    """Read full file contents with clear truncation warnings for large targets."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists() or not target.is_file():
        return f"ERROR: target invalid or not found: {path}"
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
        MAX = 8_000
        if len(text) > MAX:
            return text[:MAX] + f"\n\n[TRUNCATED — showing first {MAX} chars. Use cat_range to read more.]"
        return text
    except Exception as exc:
        return f"ERROR reading {path}: {exc}"


@mcp.tool()
def cat_range(path: str, start_line: int = 1, end_line: int = 100) -> str:
    """Read a precise line slice from a file when cat truncates."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: file not found: {path}"
    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    s = max(1, start_line) - 1
    e = min(total, end_line)
    chunk = lines[s:e]
    header = f"# {path} lines {s+1}-{e} of {total}\n"
    return header + "\n".join(f"{s+i+1:>6} │ {l}" for i, l in enumerate(chunk))


@mcp.tool()
def search(pattern: str, path: str = ".", extensions: str = "") -> str:
    """Regex line matching engine across working directory files."""
    root = _root() / path
    exts = [e.strip() for e in extensions.split(",") if e.strip()] if extensions else []
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"ERROR: invalid regex: {exc}"

    SKIP = {".git", "__pycache__", "node_modules", ".venv", "venv"}
    results: list[str] = []

    for fpath in sorted(root.rglob("*")):
        if any(part in SKIP for part in fpath.parts) or not fpath.is_file():
            continue
        if exts and fpath.suffix not in exts:
            continue
        try:
            for i, line in enumerate(fpath.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if rx.search(line):
                    rel = fpath.relative_to(_root())
                    results.append(f"{rel}:{i}: {line.rstrip()}")
                    if len(results) >= 200:
                        results.append("… (200 match limit reached)")
                        return "\n".join(results)
        except Exception:
            pass
    return "\n".join(results) or "No matches found."


@mcp.tool()
def write(path: str, content: str) -> str:
    """Create or overwrite a file with raw contents (auto-creates parent paths)."""
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
    """Perform atomic text blocks/line updates in a target file."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: file not found: {path}"
    text = target.read_text(encoding="utf-8")
    if old_str not in text:
        snippet = text[:500] + ("…" if len(text) > 500 else "")
        return f"ERROR: old_str not found in {path}.\nFile starts with:\n{snippet}"
    target.write_text(text.replace(old_str, new_str, 1), encoding="utf-8")
    return f"OK: patched {path}"


@mcp.tool()
def mkdir(path: str) -> str:
    """Create directory structure seamlessly."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    target.mkdir(parents=True, exist_ok=True)
    return f"OK: created {path}"


@mcp.tool()
def delete(path: str) -> str:
    """Remove individual files safely."""
    try:
        target = _safe(path)
    except ValueError as e:
        return f"ERROR: {e}"
    if not target.exists():
        return f"ERROR: not found: {path}"
    if target.is_dir():
        return f"ERROR: directory target — run explicit shell commands to drop folders"
    target.unlink()
    return f"OK: deleted {path}"


# ── Execution Tools ───────────────────────────────────────────────────────────
@mcp.tool()
def shell(cmd: str) -> str:
    """Run systems tasks and utility execution blocks."""
    logger.info("[shell] %s", cmd)
    return _run(cmd, timeout=60)


@mcp.tool()
def pytest(path: str = ".", keyword: str = "", verbose: bool = False) -> str:
    """Trigger Python workspace unit testing workflows."""
    cmd = f"python -m pytest {path} --tb=short"
    if keyword:
        cmd += f" -k {keyword!r}"
    if verbose:
        cmd += " -v"
    return _run(cmd, timeout=120)


@mcp.tool()
def django_check(app: str = "") -> str:
    """Verify internal health state frameworks via manage.py."""
    cmd = "python manage.py check"
    if app:
        cmd += f" {app}"
    return _run(cmd)


@mcp.tool()
def flake8(path: str = ".", max_line_length: int = 120) -> str:
    """Scan and enforce codebase structural code lint guidelines."""
    return _run(f"python -m flake8 {path} --max-line-length={max_line_length}")


@mcp.tool()
def git_status() -> str:
    """Expose current tree branch metadata configurations."""
    return _run("git status --short --branch")


@mcp.tool()
def git_diff(path: str = "", staged: bool = False) -> str:
    """Expose modified operational updates files blocks."""
    cmd = "git diff" + (" --cached" if staged else "")
    if path:
        cmd += f" -- {path}"
    return _run(cmd)


@mcp.tool()
def git_log(n: int = 10, path: str = "") -> str:
    """Fetch tracked change history lines."""
    cmd = f"git log --oneline -{n}"
    if path:
        cmd += f" -- {path}"
    return _run(cmd)


# ── FastAPI Layout Construction ────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _event_loop
    _event_loop = asyncio.get_running_loop()
    logger.info("VibesCode started — project root: %s", get_project_root())
    yield
    logger.info("VibesCode shutting down")


app = FastAPI(
    title="VibesCode Agent",
    description="MCP-powered coding agent — works with any project",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# 🚀 Mount FastMCP using the official public ASGI app generator
app.mount("/mcp", mcp.http_app(transport="sse"))


# ── Push Stream Processing ────────────────────────────────────────────────────
async def _push_event_generator() -> AsyncGenerator[bytes, None]:
    yield b": keep-alive\n\n"
    while True:
        try:
            envelope = await asyncio.wait_for(_push_queue.get(), timeout=15.0)
            event = f"event: inject\ndata: {envelope}\n\n"
            yield event.encode()
        except asyncio.TimeoutError:
            yield b": keep-alive\n\n"


@app.get("/push/stream", summary="Server→Extension SSE push channel", tags=["Push"])
async def push_stream():
    return StreamingResponse(
        _push_event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


class PushRequest(BaseModel):
    text: str
    submit: bool = True


@app.post("/push/send", summary="Enqueue a message to inject into AI chat", tags=["Push"])
async def push_send(body: PushRequest) -> dict:
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="text must not be empty")
    push_to_extension(body.text, body.submit)
    return {"ok": True, "queued": body.text[:80]}


# ── Meta / Discovery Handlers ─────────────────────────────────────────────────
def _get_registered_tools() -> list:
    """Safely extracts live tools directly from FastMCP's internal registry dict."""
    try:
        tool_manager = getattr(mcp, "_tool_manager", None)
        if tool_manager and hasattr(tool_manager, "tools"):
            if isinstance(tool_manager.tools, (list, set)):
                return list(tool_manager.tools)
            return list(tool_manager.tools.values())
        
        if tool_manager and hasattr(tool_manager, "_tools"):
            return list(tool_manager._tools.values())
            
        server = getattr(mcp, "_server", None)
        if server and hasattr(server, "list_tools"):
            return server.list_tools()
            
    except Exception as e:
        logger.warning(f"Internal registry fallback check failed: {e}")
    
    return []


@app.get("/health", tags=["Meta"])
async def health() -> dict:
    try:
        raw_tools = _get_registered_tools()
        tools_list = []
        for t in raw_tools:
            name = getattr(t, "name", None) or (t.get("name") if isinstance(t, dict) else str(t))
            if name:
                tools_list.append(name)
    except Exception as e:
        logger.error(f"Failed to inspect tools payload: {e}")
        tools_list = []

    return {
        "ok": True,
        "server": "vibescode-agent",
        "version": "1.0.0",
        "project_root": get_project_root(),
        "tools": tools_list,
        "tool_count": len(tools_list),
        "timestamp": time.time(),
    }


@app.get("/tools", tags=["Meta"])
async def list_tools() -> dict:
    """List all registered MCP tools with descriptions safely."""
    try:
        raw_tools = _get_registered_tools()
        tools = []
        for tool in raw_tools:
            if isinstance(tool, dict):
                name = tool.get("name", "unknown")
                desc = tool.get("description", "") or ""
            else:
                name = getattr(tool, "name", str(tool))
                desc = getattr(tool, "description", "") or ""
                
            tools.append({
                "name": name,
                "description": desc.split("\n")[0] if desc else "No description provided.",
            })
    except Exception as e:
        logger.error(f"Error parsing metadata tools array: {e}")
        tools = []

    return {"tools": tools, "total": len(tools)}


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=port,
        reload=True,
        log_level="info",
    )

# python main.py
# uvicorn main:app --host 127.0.0.1 --port 8000 --reload