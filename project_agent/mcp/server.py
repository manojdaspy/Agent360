"""
project_agent/mcp/server.py
════════════════════════════════════════════════════════════════
Official MCP SDK server — FastMCP over SSE (ASGI)

Transport:   SSE  (MCP 2024-11-05 spec)
SDK:         pip install mcp>=1.27
Protocol:    JSON-RPC 2.0 over SSE — ZERO hand-rolled JSON parsing

Mount options
─────────────
A) Standalone (recommended for production)
   Run separately from Django on port 8001:

       python -m project_agent.mcp.server

   Django background.js points to http://localhost:8001

B) Mounted inside Django via a2wsgi
   In your root urls.py add BEFORE any catch-all:

       from project_agent.mcp.server import get_asgi_app
       from django.urls import re_path
       from a2wsgi import ASGIMiddleware

       urlpatterns = [
           ...
           re_path(r"^mcp/", ASGIMiddleware(get_asgi_app())),
       ]

   Works with gunicorn/uvicorn; NOT with standard WSGI + threads.

Push-to-AI channel
──────────────────
Django code calls  push_to_extension(message)  anywhere:

    from project_agent.mcp.server import push_to_extension
    push_to_extension("Redeploy triggered — check /deploy status.")

The extension picks this up via its SSE control channel and types
the message into the active AI chat box automatically.
════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import anyio
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.middleware.cors import CORSMiddleware

logger = logging.getLogger("vibescode.mcp")

# ── Project root (set via env or Django settings) ─────────────────────────────
def _get_project_root() -> str:
    # Try Django settings first, fall back to env var, then cwd
    try:
        from django.conf import settings
        return getattr(settings, "VIBESCODE", {}).get("PROJECT_ROOT", os.getcwd())
    except Exception:
        return os.environ.get("VIBESCODE_PROJECT_ROOT", os.getcwd())


# ═════════════════════════════════════════════════════════════════════════════
# 1.  PUSH-TO-EXTENSION CHANNEL
#
#     A simple asyncio.Queue per connected extension client.
#     Django code calls the synchronous helper push_to_extension().
#     The SSE /mcp/push/stream endpoint drains the queue to the browser.
#
#     Queue holds plain strings (the text to inject into the AI chat box).
# ═════════════════════════════════════════════════════════════════════════════

_push_queue: asyncio.Queue[str] = asyncio.Queue()
_push_loop: asyncio.AbstractEventLoop | None = None


def push_to_extension(message: str) -> None:
    """
    Thread-safe — call from ANY Django view, signal, Celery task, etc.
    The message will be delivered to the connected browser extension and
    typed into the active AI chat input box automatically.
    """
    global _push_loop
    if _push_loop and _push_loop.is_running():
        _push_loop.call_soon_threadsafe(_push_queue.put_nowait, message)
    else:
        logger.warning("[push] No running event loop — message dropped: %s", message)


# ═════════════════════════════════════════════════════════════════════════════
# 2.  FastMCP SERVER  (tools are registered here)
#
#     FastMCP handles ALL MCP protocol details:
#       • JSON-RPC 2.0 framing
#       • SSE keep-alive pings
#       • initialize / tools/list / tools/call dispatch
#       • Pydantic validation of every input → zero parse errors
#
#     To add a new tool: just add a @mcp.tool() decorated function.
# ═════════════════════════════════════════════════════════════════════════════

mcp = FastMCP(name="vibescode-agent")


# ── Filesystem tools ──────────────────────────────────────────────────────────

@mcp.tool()
def tree(path: str = ".") -> str:
    """Recursively list directory tree."""
    root = Path(_get_project_root()) / path
    if not root.exists():
        return f"ERROR: path does not exist: {path}"
    lines: list[str] = []
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root)
        depth = len(rel.parts) - 1
        prefix = "  " * depth + ("📁 " if p.is_dir() else "📄 ")
        lines.append(prefix + p.name)
    return "\n".join(lines) or "(empty)"


@mcp.tool()
def cat(path: str) -> str:
    """Read file content."""
    target = _safe_path(path)
    if isinstance(target, str):          # error string
        return target
    try:
        return target.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        return f"ERROR reading {path}: {exc}"


@mcp.tool()
def dir(path: str = ".") -> str:         # noqa: A001
    """List immediate directory contents."""
    root = Path(_get_project_root()) / path
    if not root.exists():
        return f"ERROR: {path} not found"
    items = sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name))
    return "\n".join(
        ("📁 " if p.is_dir() else "📄 ") + p.name for p in items
    )


@mcp.tool()
def write(path: str, content: str) -> str:
    """Create or overwrite a file."""
    target = Path(_get_project_root()) / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return f"OK: wrote {len(content)} chars to {path}"


@mcp.tool()
def patch(path: str, old_str: str, new_str: str) -> str:
    """Atomic search-and-replace inside a file."""
    target = _safe_path(path)
    if isinstance(target, str):
        return target
    text = target.read_text(encoding="utf-8")
    if old_str not in text:
        return f"ERROR: old_str not found in {path}"
    target.write_text(text.replace(old_str, new_str, 1), encoding="utf-8")
    return f"OK: patched {path}"


@mcp.tool()
def search(pattern: str, path: str = ".", extensions: str = "") -> str:
    """Grep-style search across project files. extensions: comma-separated e.g. '.py,.html'"""
    import re
    root = Path(_get_project_root()) / path
    exts = [e.strip() for e in extensions.split(",") if e.strip()] if extensions else []
    results: list[str] = []
    try:
        rx = re.compile(pattern, re.IGNORECASE)
    except re.error as exc:
        return f"ERROR: invalid regex: {exc}"
    for fpath in sorted(root.rglob("*")):
        if not fpath.is_file():
            continue
        if exts and fpath.suffix not in exts:
            continue
        try:
            for i, line in enumerate(fpath.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if rx.search(line):
                    rel = fpath.relative_to(Path(_get_project_root()))
                    results.append(f"{rel}:{i}: {line.rstrip()}")
        except Exception:
            pass
    return "\n".join(results[:200]) or "No matches found."


@mcp.tool()
def mkdir(path: str) -> str:
    """Create directory (including parents)."""
    target = Path(_get_project_root()) / path
    target.mkdir(parents=True, exist_ok=True)
    return f"OK: created {path}"


@mcp.tool()
def delete(path: str) -> str:
    """Delete a file."""
    target = _safe_path(path)
    if isinstance(target, str):
        return target
    target.unlink()
    return f"OK: deleted {path}"


# ── Git tools ─────────────────────────────────────────────────────────────────

@mcp.tool()
def git_status() -> str:
    """Run git status in the project root."""
    return _run_cmd("git status --short")


@mcp.tool()
def git_diff(path: str = "", staged: bool = False) -> str:
    """Show git diff. staged=True for --cached."""
    args = ["git", "diff"]
    if staged:
        args.append("--cached")
    if path:
        args.append(path)
    return _run_cmd(" ".join(args))


@mcp.tool()
def git_log(n: int = 10, path: str = "") -> str:
    """Show last N git commits."""
    cmd = f"git log --oneline -{n}"
    if path:
        cmd += f" -- {path}"
    return _run_cmd(cmd)


# ── Shell / diagnostics ───────────────────────────────────────────────────────

@mcp.tool()
def shell(cmd: str) -> str:
    """Run an arbitrary shell command in the project root. Use with care."""
    return _run_cmd(cmd)


@mcp.tool()
def pytest(path: str = ".", keyword: str = "", verbose: bool = False) -> str:
    """Run pytest. Returns combined stdout+stderr."""
    cmd = f"python -m pytest {path}"
    if keyword:
        cmd += f" -k {keyword}"
    if verbose:
        cmd += " -v"
    return _run_cmd(cmd, timeout=120)


@mcp.tool()
def django_check(app: str = "") -> str:
    """Run Django system checks."""
    cmd = "python manage.py check"
    if app:
        cmd += f" {app}"
    return _run_cmd(cmd)


@mcp.tool()
def flake8(path: str = ".", max_line_length: int = 120) -> str:
    """Run flake8 linter."""
    return _run_cmd(f"python -m flake8 {path} --max-line-length={max_line_length}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_path(rel: str) -> Path | str:
    """Resolve relative path inside project root, block traversal."""
    root = Path(_get_project_root()).resolve()
    target = (root / rel).resolve()
    if not str(target).startswith(str(root)):
        return f"ERROR: path traversal blocked: {rel}"
    if not target.exists():
        return f"ERROR: file not found: {rel}"
    return target


def _run_cmd(cmd: str, timeout: int = 30) -> str:
    import subprocess
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            cwd=_get_project_root(), timeout=timeout,
        )
        out = (r.stdout + r.stderr).strip()
        return out or "(no output)"
    except subprocess.TimeoutExpired:
        return f"ERROR: command timed out after {timeout}s"
    except Exception as exc:
        return f"ERROR: {exc}"


# ═════════════════════════════════════════════════════════════════════════════
# 3.  PUSH-TO-EXTENSION SSE ENDPOINT
#
#     GET /mcp/push/stream
#       → Extension connects here; receives server-push messages as SSE.
#       → Event name: "inject"
#       → Data: JSON {"text": "...", "submit": true/false}
#
#     POST /mcp/push/send
#       → Django REST views call this internally (or direct HTTP from anywhere)
#       → Body: {"text": "...", "submit": true}
#       → submit=true  → extension auto-presses the AI Send button
#       → submit=false → extension just fills the input (user reviews first)
# ═════════════════════════════════════════════════════════════════════════════

async def push_stream(request: Request) -> Response:
    """
    SSE endpoint the browser extension keeps open.
    Drains _push_queue and forwards each item as an SSE event.
    """
    global _push_loop
    _push_loop = asyncio.get_running_loop()

    async def event_generator():
        # Keep-alive comment every 15 s
        yield b": keep-alive\n\n"
        while True:
            try:
                text = await asyncio.wait_for(_push_queue.get(), timeout=15.0)
                payload = json.dumps({"text": text, "submit": True})
                yield f"event: inject\ndata: {payload}\n\n".encode()
            except asyncio.TimeoutError:
                yield b": keep-alive\n\n"

    return Response(
        content=event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        },
    )


async def push_send(request: Request) -> JSONResponse:
    """
    REST endpoint to enqueue a push message.
    Body: {"text": "Hello from Django!", "submit": true}
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "invalid JSON"}, status_code=400)

    text = body.get("text", "").strip()
    if not text:
        return JSONResponse({"ok": False, "error": "text required"}, status_code=400)

    submit = bool(body.get("submit", True))
    # Pack submit flag into the text payload via a simple envelope
    envelope = json.dumps({"text": text, "submit": submit})
    await _push_queue.put(envelope)     # raw envelope goes through the queue
    return JSONResponse({"ok": True, "queued": text[:80]})


# ── Health ────────────────────────────────────────────────────────────────────

async def health(request: Request) -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "server": "vibescode-agent",
        "version": "2.0.0",
        "project_root": _get_project_root(),
        "tools": len(mcp._tool_manager._tools),  # type: ignore[attr-defined]
        "timestamp": time.time(),
    })


# ═════════════════════════════════════════════════════════════════════════════
# 4.  COMBINED STARLETTE APP
#
#     /mcp/sse              → MCP SSE transport (FastMCP)
#     /mcp/messages         → MCP message POST (FastMCP)
#     /mcp/push/stream      → Push-to-extension SSE channel
#     /mcp/push/send        → Enqueue a server→extension message
#     /mcp/health           → Liveness probe
# ═════════════════════════════════════════════════════════════════════════════

def get_asgi_app() -> Starlette:
    """
    Returns the combined ASGI application.

    Route map when mounted at /mcp/ in Django urls.py:
      GET  /mcp/sse            → FastMCP SSE handshake
      POST /mcp/messages       → FastMCP JSON-RPC
      GET  /mcp/push/stream    → Django→Extension push channel (EventSource)
      POST /mcp/push/send      → Enqueue a push message
      GET  /mcp/health         → Liveness probe

    Standalone (recommended):
        python -m project_agent.mcp.server          # port 8001
    Mounted inside Django (needs uvicorn, not gunicorn WSGI):
        re_path(r"^mcp/", ASGIMiddleware(get_asgi_app()))
    """
    # FastMCP sse_app() serves /sse and /messages at its own root.
    # We mount it at "/" so the outer app controls the /mcp prefix via
    # Django's url dispatcher.  push/health are additional top-level routes.
    mcp_app = mcp.sse_app()

    extra_routes = [
        Route("/push/stream", push_stream),
        Route("/push/send",   push_send,  methods=["POST"]),
        Route("/health",      health),
    ]

    combined = Starlette(routes=extra_routes)
    combined.mount("/", mcp_app)   # /sse and /messages served here

    return CORSMiddleware(
        combined,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )


# ── Standalone entry-point ────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("MCP_PORT", 8001))
    logger.info("Starting VibesCode MCP server on port %d", port)
    uvicorn.run(get_asgi_app(), host="0.0.0.0", port=port, log_level="info")