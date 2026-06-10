"""
project_agent/urls.py
════════════════════════════════════════════════════════════════
Mount in root urls.py:
    path("api/agent/", include("project_agent.urls")),

MCP lives at a SEPARATE mount point — see root_urls.py example below.
════════════════════════════════════════════════════════════════
"""
from django.urls import path

from .views import (
    ChatView,
    ChatStreamView,
    PushToExtensionView,
    SessionDetailView,
    SessionListView,
    SessionUndoView,
    ToolDiscoveryView,
)

urlpatterns = [
    # Chat
    path("chat/",                            ChatView.as_view(),          name="agent-chat"),
    path("chat/stream/",                     ChatStreamView.as_view(),    name="agent-chat-stream"),

    # Server → Extension push
    path("push/",                            PushToExtensionView.as_view(), name="agent-push"),

    # Tool discovery (lists all registered MCP tools)
    path("tools/",                           ToolDiscoveryView.as_view(), name="agent-tools"),

    # Sessions
    path("sessions/",                        SessionListView.as_view(),       name="agent-sessions"),
    path("sessions/<uuid:session_id>/",      SessionDetailView.as_view(),     name="agent-session-detail"),
    path("sessions/<uuid:session_id>/undo/", SessionUndoView.as_view(),       name="agent-session-undo"),
]