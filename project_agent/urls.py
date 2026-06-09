"""
project_agent/urls.py — all API routes

Mount in your project's urls.py:
    path("api/agent/", include("project_agent.urls")),
    path("mcp/",       include("project_agent.mcp.urls")),
    path("openai/v1/", include("project_agent.openai_compat.urls")),
"""
from django.urls import path
from .views import (
    ChatView,
    ChatStreamView,
    DirectCmdView,
    SessionListView,
    SessionDetailView,
    SessionUndoView,
    ToolDiscoveryView,
)

urlpatterns = [
    # ── Chat ──────────────────────────────────────────────────────────────────
    path("chat/",                              ChatView.as_view(),          name="agent-chat"),
    path("chat/stream/",                       ChatStreamView.as_view(),    name="agent-chat-stream"),

    # ── Direct tool / cmd execution (all LLMs + query-param routing) ─────────
    path("cmd/",                               DirectCmdView.as_view(),     name="agent-cmd"),

    # ── Tool discovery ────────────────────────────────────────────────────────
    path("tools/",                             ToolDiscoveryView.as_view(), name="agent-tools"),

    # ── Sessions ──────────────────────────────────────────────────────────────
    path("sessions/",                          SessionListView.as_view(),       name="agent-sessions"),
    path("sessions/<uuid:session_id>/",        SessionDetailView.as_view(),     name="agent-session-detail"),
    path("sessions/<uuid:session_id>/undo/",   SessionUndoView.as_view(),       name="agent-session-undo"),
]
