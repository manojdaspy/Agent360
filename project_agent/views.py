"""
project_agent/views.py
════════════════════════════════════════════════════════════════
REST API views — now MCP tools live in mcp/server.py.

The DirectCmdView is REMOVED — every tool call goes through MCP.
This file keeps the chat / session / push management views.

New endpoint:
  POST /api/agent/push/   — push a message to the extension → AI chat
════════════════════════════════════════════════════════════════
"""
from __future__ import annotations

import logging

from django.http import StreamingHttpResponse
from rest_framework.response import Response
from rest_framework.views import APIView

from .config import get_setting
from .models import AgentSession, FileChange
from .serializers import (
    AgentSessionSerializer,
    ChatRequestSerializer,
    FileChangeSerializer,
    MessageSerializer,
    ToolCallSerializer,
)
from .services import AgentLoop, SessionService
from .services.streaming import agent_sse_stream

logger = logging.getLogger("vibescode.views")


# ── Push a message to the extension (→ AI chat box) ──────────────────────────

class PushToExtensionView(APIView):
    """
    POST /api/agent/push/
    Body: {"text": "Hello from Django!", "submit": true}

    Sends 'text' to the browser extension via the MCP push channel.
    The extension types it into the active AI chat and optionally submits.

    submit=true  → auto-press Send  (default)
    submit=false → fill input only, user reviews before sending
    """
    def post(self, request):
        text = request.data.get("text", "").strip()
        if not text:
            return Response({"error": "text required"}, status=400)

        submit = bool(request.data.get("submit", True))

        # push_to_extension is thread-safe — safe to call from Django views
        from .mcp.server import push_to_extension
        push_to_extension(text)

        return Response({"ok": True, "queued": text[:80], "submit": submit})


# ── Chat ──────────────────────────────────────────────────────────────────────

class ChatView(APIView):
    """POST /api/agent/chat/"""

    def post(self, request):
        ser = ChatRequestSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data

        if data.get("session_id"):
            try:
                session = SessionService.get(str(data["session_id"]))
            except AgentSession.DoesNotExist:
                return Response({"error": "Session not found."}, status=404)
        else:
            project_root = data.get("project_root") or get_setting("PROJECT_ROOT")
            if not project_root:
                return Response(
                    {"error": "project_root required (or set VIBESCODE.PROJECT_ROOT)."},
                    status=400,
                )
            session = SessionService.create(
                project_root=project_root, meta=data.get("meta", {})
            )

        user_msg = SessionService.save_user_message(session, data["message"])
        history  = SessionService.get_history(session)
        loop     = AgentLoop(project_root=session.project_root)

        events: list = []
        final_text: list[str] = []
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

        SessionService.save_assistant_message(
            session,
            "\n".join(final_text),
            [e for e in events if e["type"] == "tool_call"],
        )

        return Response({
            "session_id": str(session.id),
            "response":   "\n".join(final_text),
            "events":     events,
        })


class ChatStreamView(APIView):
    """GET /api/agent/chat/stream/?message=<text>&session_id=<uuid>&project_root=<path>"""

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
            project_root = (
                request.query_params.get("project_root") or get_setting("PROJECT_ROOT")
            )
            if not project_root:
                return Response({"error": "project_root required."}, status=400)
            session = SessionService.create(project_root=project_root)

        response = StreamingHttpResponse(
            agent_sse_stream(session, message),
            content_type="text/event-stream",
        )
        response["Cache-Control"]             = "no-cache"
        response["X-Accel-Buffering"]         = "no"
        response["Access-Control-Allow-Origin"] = "*"
        return response


# ── Sessions ──────────────────────────────────────────────────────────────────

class SessionListView(APIView):
    def get(self, request):
        sessions = AgentSession.objects.filter(is_active=True).order_by("-created_at")[:50]
        return Response(AgentSessionSerializer(sessions, many=True).data)

    def post(self, request):
        project_root = request.data.get("project_root") or get_setting("PROJECT_ROOT")
        session = SessionService.create(
            project_root=project_root, meta=request.data.get("meta", {})
        )
        return Response(AgentSessionSerializer(session).data, status=201)


class SessionDetailView(APIView):
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
            "session":      AgentSessionSerializer(session).data,
            "messages":     MessageSerializer(session.messages.all(), many=True).data,
            "tool_calls":   ToolCallSerializer(session.tool_calls.all(), many=True).data,
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
    def post(self, request, session_id):
        try:
            session = AgentSession.objects.get(id=session_id)
        except AgentSession.DoesNotExist:
            return Response({"error": "Not found."}, status=404)

        last_change = (
            FileChange.objects.filter(session=session).order_by("-changed_at").first()
        )
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
                "restored_to": (
                    "previous version" if last_change.before else "deleted (was new file)"
                ),
            })
        except Exception as exc:
            return Response({"error": str(exc)}, status=500)


class ToolDiscoveryView(APIView):
    """GET /api/agent/tools/ — list all MCP tools."""

    def get(self, request):
        from .mcp.server import mcp
        tools = []
        for name, tool in mcp._tool_manager._tools.items():  # type: ignore[attr-defined]
            tools.append({
                "name":        name,
                "description": tool.description or "",
            })
        return Response({"tools": tools, "total": len(tools)})