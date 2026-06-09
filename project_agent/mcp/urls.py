"""
project_agent/mcp/urls.py
MCP protocol endpoints.
Mount in your project urls.py:
    path("mcp/", include("project_agent.mcp.urls")),
"""
from django.urls import path
from .server import MCPView, MCPToolsView, MCPResourcesView

urlpatterns = [
    path("",           MCPView.as_view(),          name="mcp-endpoint"),
    path("tools/",     MCPToolsView.as_view(),      name="mcp-tools"),
    path("resources/", MCPResourcesView.as_view(),  name="mcp-resources"),
]
