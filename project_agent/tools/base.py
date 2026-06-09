"""
project_agent/tools/base.py
"""
from __future__ import annotations
import abc
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolResult:
    ok: bool
    data: Any = None
    error: str | None = None          # None = no error (not "")

    # Filled by timed_run(), not by the tool itself
    op: str = ""
    resolved_op: str | None = None
    duration_ms: int = 0

    def __post_init__(self):
        # Normalise empty string → None so JSON always gets null, never ""
        if self.error == "":
            self.error = None

    def to_dict(self) -> dict:
        return {
            "ok":    self.ok,
            "data":  self.data,
            "error": self.error,
            "meta": {
                "op":          self.op          or None,
                "resolved_op": self.resolved_op or None,
                "duration_ms": self.duration_ms,
            },
        }


class BaseTool(abc.ABC):
    name: str = ""
    description: str = ""
    input_schema: dict = {}

    @abc.abstractmethod
    def run(self, params: dict, project_root: str) -> ToolResult:
        """Execute the tool. Returns a ToolResult."""

    def timed_run(
        self,
        params: dict,
        project_root: str,
        op: str = "",
        resolved_op: str | None = None,
    ) -> ToolResult:
        """
        Wraps run() — measures duration, stamps op name.
        Call this from views.py instead of run() directly.
        """
        t0 = time.monotonic()
        result = self.run(params, project_root)
        result.duration_ms = int((time.monotonic() - t0) * 1000)
        result.op = op or self.name
        result.resolved_op = resolved_op
        return result

    def to_llm_schema(self) -> dict:
        return {
            "name":         self.name,
            "description":  self.description,
            "input_schema": self.input_schema,
        }