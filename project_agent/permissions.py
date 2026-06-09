"""
project_agent/permissions.py
Simple token auth for the agent API.
In production, replace with JWT or session-based auth as needed.
"""
from rest_framework.permissions import BasePermission
from django.conf import settings


class AgentTokenPermission(BasePermission):
    """
    Requires header:  Authorization: Bearer <VIBESCODE_API_TOKEN>
    If VIBESCODE_API_TOKEN is not set in settings, all requests are allowed
    (useful for local dev). Set it in production!
    """
    message = "Invalid or missing agent token."

    def has_permission(self, request, view):
        expected = getattr(settings, "VIBESCODE", {}).get("API_TOKEN")
        if not expected:
            return True  # open in dev mode
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            return auth[7:] == expected
        return False
