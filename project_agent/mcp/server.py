"""
project_agent/mcp/server.py

MCP (Model Context Protocol) — HTTP transport implementation.

The Model Context Protocol is an open standard (anthropic.com/news/model-context-protocol)
that lets any MCP-aware LLM client (Claude Desktop, Cursor, Continue.dev, etc.)
discover and call tools on this server over HTTP/SSE.

Protocol:
  GET  /mcp/               → SSE stream for server-sent events (tool results, notifications)
  POST /mcp/               → client sends JSON-RPC 2.0 messages (tool calls, resource reads)
  GET  /mcp/tools/         → list all available tools (tool manifest)
  GET  /mcp/resources/     → list readable resources (files, directories)

JSON-RPC 2.0 methods implemented:
  tools/list               → return tool schemas
  tools/call               → execute a tool
  resources/list           → list project files
  resources/read           → read a file resource
  initialize               → capability handshake

Reference: https://spec.modelcontextprotocol.io/
"""
from __future__ import annotations
import json
import uuid
import time
import logging
from typing import Any

from django.http import StreamingHttpResponse, JsonResponse
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator

from ..config import get_setting
from ..tools.registry import get_tool, all_tools, llm_tool_schemas
from ..tools.filesystem import _safe_resolve

logger = logging.getLogger("vibescode.mcp")

# ── MCP capability declaration ─────────────────────────────────────────────────

SERVER_INFO = {
    "name": "vibescode-agent",
    "version": "1.0.0",
    "description": "VibesCode: LLM-powered project agent for Django assignments",
}

CAPABILITIES = {
    "tools": {"listChanged": True},
    "resources": {"subscribe": False, "listChanged": True},
    "logging": {},
}


# ── JSON-RPC helpers ──────────────────────────────────────────────────────────

def rpc_result(id_: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def rpc_error(id_: Any, code: int, message: str, data: Any = None) -> dict:
    err: dict = {"code": code, "message": message}
    if data:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": id_, "error": err}


# ── MCP JSON-RPC method handlers ──────────────────────────────────────────────

class MCPDispatcher:
    """Routes JSON-RPC method calls to the right handler."""

    def __init__(self, project_root: str):
        self.project_root = project_root

    def dispatch(self, method: str, params: dict, rpc_id: Any) -> dict:
        handlers = {
            "initialize":      self._initialize,
            "tools/list":      self._tools_list,
            "tools/call":      self._tools_call,
            "resources/list":  self._resources_list,
            "resources/read":  self._resources_read,
            "ping":            self._ping,
        }
        handler = handlers.get(method)
        if handler is None:
            return rpc_error(rpc_id, -32601, f"Method not found: {method}")
        try:
            return rpc_result(rpc_id, handler(params))
        except Exception as exc:
            logger.exception(f"MCP method {method} failed")
            return rpc_error(rpc_id, -32603, "Internal error", str(exc))

    # ── handlers ──────────────────────────────────────────────────────────────

    def _initialize(self, params: dict) -> dict:
        client_info = params.get("clientInfo", {})
        logger.info(f"MCP initialize from: {client_info}")
        return {
            "protocolVersion": "2024-11-05",
            "capabilities": CAPABILITIES,
            "serverInfo": SERVER_INFO,
        }

    def _ping(self, params: dict) -> dict:
        return {"pong": True, "timestamp": time.time()}

    def _tools_list(self, params: dict) -> dict:
        """Return all tools in MCP format."""
        tools = []
        for schema in llm_tool_schemas():
            tools.append({
                "name": schema["name"],
                "description": schema["description"],
                "inputSchema": schema["input_schema"],
            })
        return {"tools": tools}

    def _tools_call(self, params: dict) -> dict:
        """Execute a tool and return MCP-formatted result."""
        tool_name = params.get("name")
        tool_input = params.get("arguments", {})

        tool = get_tool(tool_name)
        if tool is None:
            return {
                "content": [{"type": "text", "text": f"Error: Unknown tool '{tool_name}'"}],
                "isError": True,
            }

        t0 = time.time()
        result = tool.run(tool_input, self.project_root)
        elapsed_ms = int((time.time() - t0) * 1000)

        logger.info(f"[MCP tool] {tool_name} → ok={result.ok} ({elapsed_ms}ms)")

        if result.ok:
            text = str(result.data) if not isinstance(result.data, str) else result.data
            return {
                "content": [{"type": "text", "text": text}],
                "isError": False,
                "_meta": {"duration_ms": elapsed_ms},
            }
        else:
            return {
                "content": [{"type": "text", "text": f"Error: {result.error}"}],
                "isError": True,
            }

    def _resources_list(self, params: dict) -> dict:
        """List project files as MCP resources (URI-addressable)."""
        from pathlib import Path
        from ..config import get_setting

        root = Path(self.project_root)
        allowed_exts = get_setting("ALLOWED_EXTENSIONS", [])
        resources = []

        for fpath in sorted(root.rglob("*")):
            if not fpath.is_file():
                continue
            if allowed_exts and fpath.suffix not in allowed_exts:
                continue
            rel = fpath.relative_to(root)
            resources.append({
                "uri": f"file:///{rel}",
                "name": str(rel),
                "description": f"{fpath.suffix.lstrip('.').upper()} file",
                "mimeType": _mime_for(fpath.suffix),
            })

        return {"resources": resources[:200]}  # cap at 200 for large projects

    def _resources_read(self, params: dict) -> dict:
        """Read a file resource by URI."""
        uri = params.get("uri", "")
        if not uri.startswith("file:///"):
            return {"contents": [{"uri": uri, "text": "Error: only file:/// URIs supported"}]}
        rel_path = uri[len("file:///"):]
        try:
            target = _safe_resolve(self.project_root, rel_path)
            content = target.read_text(encoding="utf-8", errors="replace")
            return {
                "contents": [{
                    "uri": uri,
                    "mimeType": _mime_for(target.suffix),
                    "text": content,
                }]
            }
        except Exception as exc:
            return {"contents": [{"uri": uri, "text": f"Error: {exc}"}]}


def _mime_for(ext: str) -> str:
    return {
        ".py": "text/x-python",
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".yaml": "text/yaml",
        ".toml": "application/toml",
    }.get(ext, "text/plain")


# ── Django views ──────────────────────────────────────────────────────────────

@method_decorator(csrf_exempt, name="dispatch")
class MCPView(View):
    """
    POST /mcp/  — receives JSON-RPC 2.0 messages from MCP clients.
    GET  /mcp/  — SSE stream (required by MCP spec for server push).
    """

    def get_project_root(self):
        return get_setting("PROJECT_ROOT", ".")

    def get(self, request):
        """SSE endpoint — MCP clients hold this open to receive server-push events."""
        def event_stream():
            # Send initial connection established event
            yield self._sse("endpoint", {"uri": request.build_absolute_uri("/mcp/")})
            # Keep-alive ping every 15s (clients expect this)
            import time
            while True:
                time.sleep(15)
                yield self._sse("ping", {"timestamp": time.time()})

        response = StreamingHttpResponse(event_stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        response["Access-Control-Allow-Origin"] = "*"
        return response

    def post(self, request):
        """Handle JSON-RPC 2.0 method calls."""
        try:
            body = json.loads(request.body)
        except json.JSONDecodeError:
            return JsonResponse(rpc_error(None, -32700, "Parse error"), status=400)

        # Support batch requests
        if isinstance(body, list):
            dispatcher = MCPDispatcher(self.get_project_root())
            responses = [dispatcher.dispatch(r.get("method"), r.get("params", {}), r.get("id")) for r in body]
            return JsonResponse(responses, safe=False)

        dispatcher = MCPDispatcher(self.get_project_root())
        method = body.get("method", "")
        params = body.get("params", {})
        rpc_id = body.get("id")

        response = dispatcher.dispatch(method, params, rpc_id)

        # Notifications (id=None) get no response per JSON-RPC spec
        if rpc_id is None:
            return JsonResponse({}, status=204)

        return JsonResponse(response)

    @staticmethod
    def _sse(event: str, data: dict) -> str:
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@method_decorator(csrf_exempt, name="dispatch")
class MCPToolsView(View):
    """GET /mcp/tools/ — human-readable tool manifest (also machine-usable)."""

    def get(self, request):
        project_root = get_setting("PROJECT_ROOT", ".")
        dispatcher = MCPDispatcher(project_root)
        return JsonResponse(dispatcher._tools_list({}))


@method_decorator(csrf_exempt, name="dispatch")
class MCPResourcesView(View):
    """GET /mcp/resources/ — list all readable project resources."""

    def get(self, request):
        project_root = get_setting("PROJECT_ROOT", ".")
        dispatcher = MCPDispatcher(project_root)
        return JsonResponse(dispatcher._resources_list({}))
