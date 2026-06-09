"""
project_agent/views.py
REST API + SSE streaming views.

Endpoints:
  POST /api/agent/chat/              — full agentic loop, JSON response
  GET  /api/agent/chat/stream/       — same but SSE streaming
  GET  /api/agent/cmd/               — direct tool execution (LLM HTTP calls)
  POST /api/agent/cmd/               — write/patch/shell ops
  GET  /api/agent/sessions/          — list active sessions
  GET  /api/agent/sessions/<id>/     — session detail + full history
  DEL  /api/agent/sessions/<id>/     — close session
  POST /api/agent/sessions/<id>/undo/ — undo last file change
"""
import logging
from django.http import StreamingHttpResponse
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .config import get_setting
from .models import AgentSession, FileChange
from .permissions import AgentTokenPermission
from .serializers import (
    AgentSessionSerializer,
    ChatRequestSerializer,
    DirectCmdSerializer,
    FileChangeSerializer,
    MessageSerializer,
    ToolCallSerializer,
)
from .services import AgentLoop, SessionService
from .services.streaming import agent_sse_stream
from .tools.registry import get_tool, tool_names
from .adapters.query_router import resolve_op, build_tool_params, CustomFallbackHandler
_fallback = CustomFallbackHandler()

logger = logging.getLogger("vibescode.views")


# ── Chat — JSON response ──────────────────────────────────────────────────────

class ChatView(APIView):
    """
    POST /api/agent/chat/
    Runs the full agentic loop synchronously and returns when done.
    For real-time streaming, use ChatStreamView instead.
    """
    permission_classes = [AgentTokenPermission]

    def post(self, request):
        ser = ChatRequestSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data

        # Resolve or create session
        if data.get("session_id"):
            try:
                session = SessionService.get(str(data["session_id"]))
            except AgentSession.DoesNotExist:
                return Response({"error": "Session not found."}, status=404)
        else:
            project_root = data.get("project_root") or get_setting("PROJECT_ROOT")
            if not project_root:
                return Response({"error": "project_root required (or set VIBESCODE.PROJECT_ROOT)."}, status=400)
            session = SessionService.create(project_root=project_root, meta=data.get("meta", {}))

        user_msg = SessionService.save_user_message(session, data["message"])
        history = SessionService.get_history(session)
        loop = AgentLoop(project_root=session.project_root)

        events = []
        final_text = []
        last_tool_call = None

        for event in loop.run(history):
            events.append(event)
            if event["type"] == "llm_response":
                final_text.append(event["content"])
            elif event["type"] == "tool_call":
                last_tool_call = event
            elif event["type"] == "tool_result":
                SessionService.save_tool_call(
                    session=session,
                    message=user_msg,
                    operation=event["name"],
                    params=last_tool_call.get("input", {}) if last_tool_call else {},
                    result=event["result"],
                    duration_ms=event["result"].get("duration_ms", 0),
                )

        SessionService.save_assistant_message(session, "\n".join(final_text), [
            e for e in events if e["type"] == "tool_call"
        ])

        return Response({
            "session_id": str(session.id),
            "response": "\n".join(final_text),
            "events": events,
        })


# ── Chat — SSE streaming ──────────────────────────────────────────────────────

class ChatStreamView(APIView):
    """
    GET /api/agent/chat/stream/?message=<text>&session_id=<uuid>&project_root=<path>
    Returns Server-Sent Events stream.
    
    Client receives events in real-time:
      event: start         → session created
      event: tool_call     → LLM is calling a tool
      event: tool_result   → tool completed
      event: llm_response  → LLM text chunk
      event: done          → finished
      event: error         → something failed
    """
    permission_classes = [AgentTokenPermission]

    def get(self, request):
        message = request.query_params.get("message", "").strip()
        if not message:
            return Response({"error": "message parameter required."}, status=400)

        session_id = request.query_params.get("session_id")
        if session_id:
            try:
                session = SessionService.get(session_id)
            except AgentSession.DoesNotExist:
                return Response({"error": "Session not found."}, status=404)
        else:
            project_root = request.query_params.get("project_root") or get_setting("PROJECT_ROOT")
            if not project_root:
                return Response({"error": "project_root required."}, status=400)
            session = SessionService.create(project_root=project_root)

        response = StreamingHttpResponse(
            agent_sse_stream(session, message),
            content_type="text/event-stream",
        )
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        response["Access-Control-Allow-Origin"] = "*"
        return response


# ── Direct Command — LLM calls this over HTTP ─────────────────────────────────

class DirectCmdView(APIView):
    """
    GET  /api/agent/cmd/?op=<tool>&...params
    POST /api/agent/cmd/  body: {op, ...params}

    Direct tool execution without going through the chat/agentic loop.
    This is what an LLM uses when calling tools over raw HTTP
    (as opposed to via the structured chat endpoint or MCP).
    """
    permission_classes = [AgentTokenPermission]

    def get(self, request):
        return self._run(request.query_params.dict())

    def post(self, request):
        ser = DirectCmdSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        return self._run(ser.validated_data)

    def _run(self, data: dict):
        """
        Route to the right tool using the universal QueryRouter.
        Supports every op alias (read, cat, get_file, ls, grep, run, exec, ...).
        Falls back to CustomFallbackHandler on unknown ops.
        """
        raw_op = data.get("op", "").strip()
        project_root = (
            data.get("project_root")
            or get_setting("PROJECT_ROOT")
        )
        if not project_root:
            return Response({"ok": False, "error": "PROJECT_ROOT not configured."}, status=500)

        # Resolve op alias → canonical tool name
        canonical = resolve_op(raw_op)

        if canonical:
            tool = get_tool(canonical)
            params = build_tool_params(canonical, data)
            result = tool.run(params, project_root)
            payload = result.to_dict()
            if canonical != raw_op:
                payload["_resolved_op"] = canonical   # show alias resolution
            return Response(payload, status=200 if result.ok else 422)

        # Unknown op → fallback handler (fuzzy match + param inference)
        fallback_result = _fallback.handle(raw_op, data, project_root)
        http_status = 200 if fallback_result.get("ok") else 400
        return Response(fallback_result, status=http_status)


# ── Sessions ──────────────────────────────────────────────────────────────────

class SessionListView(APIView):
    permission_classes = [AgentTokenPermission]

    def get(self, request):
        sessions = AgentSession.objects.filter(is_active=True).order_by("-created_at")[:50]
        return Response(AgentSessionSerializer(sessions, many=True).data)

    def post(self, request):
        """Create a session explicitly (optional — chat/ creates one automatically)."""
        project_root = request.data.get("project_root") or get_setting("PROJECT_ROOT")
        meta = request.data.get("meta", {})
        session = SessionService.create(project_root=project_root, meta=meta)
        return Response(AgentSessionSerializer(session).data, status=201)


class SessionDetailView(APIView):
    permission_classes = [AgentTokenPermission]

    def _get_or_404(self, session_id):
        try:
            return AgentSession.objects.get(id=session_id)
        except AgentSession.DoesNotExist:
            return None

    def get(self, request, session_id):
        session = self._get_or_404(session_id)
        if not session:
            return Response({"error": "Not found."}, status=404)
        return Response({
            "session": AgentSessionSerializer(session).data,
            "messages": MessageSerializer(session.messages.all(), many=True).data,
            "tool_calls": ToolCallSerializer(session.tool_calls.all(), many=True).data,
            "file_changes": FileChangeSerializer(session.file_changes.all(), many=True).data,
        })

    def delete(self, request, session_id):
        session = self._get_or_404(session_id)
        if not session:
            return Response({"error": "Not found."}, status=404)
        session.is_active = False
        session.save(update_fields=["is_active"])
        return Response({"closed": str(session_id)})


class SessionUndoView(APIView):
    """
    POST /api/agent/sessions/<id>/undo/
    Restores the last file changed by the agent in this session.
    """
    permission_classes = [AgentTokenPermission]

    def post(self, request, session_id):
        try:
            session = AgentSession.objects.get(id=session_id)
        except AgentSession.DoesNotExist:
            return Response({"error": "Not found."}, status=404)

        last_change = FileChange.objects.filter(session=session).order_by("-changed_at").first()
        if not last_change:
            return Response({"error": "No file changes to undo."}, status=400)

        from pathlib import Path
        target = Path(session.project_root) / last_change.path
        try:
            if last_change.before:
                target.write_text(last_change.before, encoding="utf-8")
            else:
                target.unlink(missing_ok=True)
            last_change.delete()
            return Response({
                "undone": last_change.path,
                "restored_to": "previous version" if last_change.before else "deleted (was new file)",
            })
        except Exception as exc:
            return Response({"error": str(exc)}, status=500)


# ── Tool Discovery endpoint ───────────────────────────────────────────────────

class ToolDiscoveryView(APIView):
    """
    GET /api/agent/tools/
    Returns all available tools, their schemas, and all accepted op aliases.
    Useful for LLMs and clients that want to know what ops are supported.
    """
    permission_classes = [AgentTokenPermission]

    def get(self, request):
        from .tools.registry import all_tools, llm_tool_schemas
        from .adapters.query_router import OP_ALIASES
        return Response({
            "tools": llm_tool_schemas(),
            "op_aliases": OP_ALIASES,
            "canonical_names": tool_names(),
            "total": len(tool_names()),
        })
