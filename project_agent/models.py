"""
vibescode_agent/models.py
Audit trail for every agent session, tool call, and file change.
"""
import uuid
from django.db import models
from django.utils import timezone


class AgentSession(models.Model):
    """One conversation between a student and the LLM agent."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    project_root = models.CharField(max_length=512)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)
    is_active = models.BooleanField(default=True)
    meta = models.JSONField(default=dict, blank=True)  # e.g. student_id, course_id

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Session {self.id} @ {self.project_root}"


class Message(models.Model):
    """A single turn in the conversation (user or assistant)."""

    ROLE_CHOICES = [("user", "User"), ("assistant", "Assistant"), ("tool", "Tool")]

    session = models.ForeignKey(AgentSession, on_delete=models.CASCADE, related_name="messages")
    role = models.CharField(max_length=16, choices=ROLE_CHOICES)
    content = models.TextField()
    created_at = models.DateTimeField(default=timezone.now)
    tool_calls = models.JSONField(default=list, blank=True)   # raw tool call blocks from LLM
    token_count = models.IntegerField(null=True, blank=True)

    class Meta:
        ordering = ["created_at"]


class ToolCall(models.Model):
    """Every individual tool invocation — for audit, debugging, replay."""

    STATUS_CHOICES = [
        ("ok", "Success"),
        ("error", "Error"),
        ("blocked", "Blocked"),
    ]

    session = models.ForeignKey(AgentSession, on_delete=models.CASCADE, related_name="tool_calls")
    message = models.ForeignKey(Message, on_delete=models.SET_NULL, null=True, related_name="tool_call_logs")
    operation = models.CharField(max_length=64)   # dir | cat | write | search | shell
    params = models.JSONField(default=dict)
    result_preview = models.TextField(blank=True)  # first 500 chars of result
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default="ok")
    duration_ms = models.IntegerField(null=True)
    called_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-called_at"]


class FileChange(models.Model):
    """Immutable log of every file write — enables undo / diff."""

    session = models.ForeignKey(AgentSession, on_delete=models.CASCADE, related_name="file_changes")
    path = models.CharField(max_length=1024)
    before = models.TextField(blank=True)
    after = models.TextField()
    changed_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-changed_at"]
