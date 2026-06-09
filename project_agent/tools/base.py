"""
project_agent/tools/base.py
Abstract interface every tool must implement.
The LLM sees a JSON schema for each tool; the agent loop calls .run().
"""
from __future__ import annotations
import abc
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolResult:
    ok: bool
    data: Any = None
    error: str = ""
    preview: str = field(init=False)

    def __post_init__(self):
        text = str(self.data or self.error)
        self.preview = text[:500]

    def to_dict(self) -> dict:
        return {"ok": self.ok, "data": self.data, "error": self.error}


class BaseTool(abc.ABC):
    """Every tool registers itself here so the agent can discover it."""

    #: short snake_case name the LLM uses in tool_use blocks
    name: str = ""
    #: one-sentence description shown to the LLM in its system prompt
    description: str = ""
    #: JSON Schema for the input parameters
    input_schema: dict = {}

    @abc.abstractmethod
    def run(self, params: dict, project_root: str) -> ToolResult:
        """Execute the tool. project_root is the sandboxed filesystem root."""

    # ── Schema helper the agent uses when building the LLM system prompt ──

    def to_llm_schema(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }
