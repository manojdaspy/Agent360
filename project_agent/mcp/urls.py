"""
project_agent/mcp/urls.py
══════════════════════════════════════════════════════════════════════════════
MCP is now a Starlette ASGI app (not Django views).
This urls.py mounts it inside Django via a2wsgi.

Add to your ROOT urls.py (not project_agent/urls.py):

    from django.urls import re_path
    from a2wsgi import ASGIMiddleware
    from project_agent.mcp.server import get_asgi_app

    _mcp_asgi = get_asgi_app()   # build once at import time

    urlpatterns = [
        ...
        re_path(r"^mcp/", ASGIMiddleware(_mcp_asgi)),
    ]

Requires uvicorn (or daphne) — standard WSGI gunicorn will NOT work with SSE.

Alternatively run MCP as a standalone process on port 8001:
    python -m project_agent.mcp.server

Then set MCP_BASE_URL = "http://localhost:8001" in content.js and remove
the re_path mount from urls.py entirely.
══════════════════════════════════════════════════════════════════════════════
"""

# This file is intentionally empty — MCP does not use Django URL routing.
# See the docstring above for mounting instructions.
urlpatterns = []