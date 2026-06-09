"""
project_agent/serializers.py
"""
from rest_framework import serializers
from .models import AgentSession, Message, ToolCall, FileChange


class MessageSerializer(serializers.ModelSerializer):
    class Meta:
        model = Message
        fields = ["id", "role", "content", "tool_calls", "created_at"]


class ToolCallSerializer(serializers.ModelSerializer):
    class Meta:
        model = ToolCall
        fields = ["id", "operation", "params", "result_preview", "status", "duration_ms", "called_at"]


class FileChangeSerializer(serializers.ModelSerializer):
    class Meta:
        model = FileChange
        fields = ["id", "path", "before", "after", "changed_at"]


class AgentSessionSerializer(serializers.ModelSerializer):
    class Meta:
        model = AgentSession
        fields = ["id", "project_root", "created_at", "updated_at", "is_active", "meta"]


class ChatRequestSerializer(serializers.Serializer):
    message = serializers.CharField()
    session_id = serializers.UUIDField(required=False)
    project_root = serializers.CharField(required=False)
    meta = serializers.DictField(required=False, default=dict)


class DirectCmdSerializer(serializers.Serializer):
    """For direct tool execution without going through the LLM."""
    op = serializers.CharField()           # tool name: dir, cat, write, search, shell …
    path = serializers.CharField(required=False, default=".")
    content = serializers.CharField(required=False, default="")
    pattern = serializers.CharField(required=False, default="")
    extensions = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    context_lines = serializers.IntegerField(required=False, default=2)
    cmd = serializers.CharField(required=False, default="")
    old_str = serializers.CharField(required=False, default="")
    new_str = serializers.CharField(required=False, default="")
    max_depth = serializers.IntegerField(required=False, default=4)
