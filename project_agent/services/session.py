"""
project_agent/services/session.py
Load / save AgentSession conversation history from the database.
"""
from __future__ import annotations
import uuid
from ..models import AgentSession, Message, ToolCall, FileChange
from ..config import get_setting


class SessionService:

    @staticmethod
    def create(project_root: str | None = None, meta: dict | None = None) -> AgentSession:
        root = project_root or get_setting("PROJECT_ROOT") or "."
        return AgentSession.objects.create(project_root=root, meta=meta or {})

    @staticmethod
    def get(session_id: str) -> AgentSession:
        return AgentSession.objects.get(id=session_id)

    @staticmethod
    def get_history(session: AgentSession) -> list[dict]:
        """Return message list in LLM-ready format."""
        history = []
        for msg in session.messages.all():
            if msg.role == "tool":
                continue  # tool results are embedded in the assistant message in Claude format
            history.append({"role": msg.role, "content": msg.content})
        return history

    @staticmethod
    def save_user_message(session: AgentSession, content: str) -> Message:
        return Message.objects.create(session=session, role="user", content=content)

    @staticmethod
    def save_assistant_message(session: AgentSession, content: str, tool_calls: list) -> Message:
        return Message.objects.create(
            session=session, role="assistant", content=content, tool_calls=tool_calls
        )

    @staticmethod
    def save_tool_call(
        session: AgentSession,
        message: Message,
        operation: str,
        params: dict,
        result: dict,
        duration_ms: int,
    ) -> ToolCall:
        ok = result.get("ok", False)
        preview = str(result.get("data") or result.get("error", ""))[:500]
        tc = ToolCall.objects.create(
            session=session,
            message=message,
            operation=operation,
            params=params,
            result_preview=preview,
            status="ok" if ok else "error",
            duration_ms=duration_ms,
        )
        # If this was a write/patch, also log a FileChange
        if operation in ("write", "patch") and ok and isinstance(result.get("data"), dict):
            FileChange.objects.create(
                session=session,
                path=params.get("path", ""),
                before=result["data"].get("before", ""),
                after=params.get("content", params.get("new_str", "")),
            )
        return tc
