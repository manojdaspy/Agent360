"""
project_agent/tools/lint_tool.py
Static analysis: flake8, pylint, django system check.
Gives the LLM structured error lists to fix one by one.
"""
from __future__ import annotations
import subprocess
import json
from pathlib import Path

from .base import BaseTool, ToolResult
from .filesystem import _safe_resolve
from ..config import get_setting


def _run(cmd: list[str], cwd: str, timeout: int = 20) -> tuple[str, str, int]:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return result.stdout.strip(), result.stderr.strip(), result.returncode


class Flake8Tool(BaseTool):
    name = "flake8"
    description = "Run flake8 linter on a file or directory. Returns list of style/error violations."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File or dir to lint (default: '.')"},
            "max_line_length": {"type": "integer", "description": "Max line length (default 120)."},
        },
        "required": [],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        if not get_setting("ENABLE_SHELL", False):
            return ToolResult(ok=False, error="ENABLE_SHELL must be True to run linters.")
        try:
            path = params.get("path", ".")
            max_len = params.get("max_line_length", 120)
            target = _safe_resolve(project_root, path)
            out, err, code = _run(
                ["flake8", str(target), f"--max-line-length={max_len}", "--format=%(path)s:%(row)d:%(col)d: %(code)s %(text)s"],
                cwd=project_root,
            )
            if not out and not err:
                return ToolResult(ok=True, data="✓ No flake8 violations found.")
            lines = (out or err).splitlines()
            # Make paths relative for cleaner output
            root = Path(project_root)
            clean = []
            for line in lines:
                try:
                    p, rest = line.split(":", 1)
                    rel = Path(p).relative_to(root)
                    clean.append(f"{rel}:{rest}")
                except Exception:
                    clean.append(line)
            return ToolResult(ok=code == 0, data="\n".join(clean))
        except FileNotFoundError:
            return ToolResult(ok=False, error="flake8 not found. Run: pip install flake8")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class DjangoCheckTool(BaseTool):
    name = "django_check"
    description = "Run Django's system check framework (manage.py check). Catches misconfiguration, model errors, URL issues."
    input_schema = {
        "type": "object",
        "properties": {
            "app": {"type": "string", "description": "Specific app to check (default: all apps)."},
        },
        "required": [],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        if not get_setting("ENABLE_SHELL", False):
            return ToolResult(ok=False, error="ENABLE_SHELL must be True.")
        try:
            cmd = ["python", "manage.py", "check", "--no-color"]
            if params.get("app"):
                cmd.append(params["app"])
            out, err, code = _run(cmd, cwd=project_root)
            combined = (out + "\n" + err).strip()
            return ToolResult(ok=code == 0, data=combined or "System check passed.")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class PytestTool(BaseTool):
    name = "pytest"
    description = "Run pytest on a file or directory. Returns pass/fail summary and tracebacks."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Test file or directory (default: '.')"},
            "keyword": {"type": "string", "description": "Filter by test name keyword (-k flag)."},
            "verbose": {"type": "boolean", "description": "Show verbose output (default False)."},
        },
        "required": [],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        if not get_setting("ENABLE_SHELL", False):
            return ToolResult(ok=False, error="ENABLE_SHELL must be True.")
        try:
            path = params.get("path", ".")
            target = _safe_resolve(project_root, path)
            cmd = ["python", "-m", "pytest", str(target), "--no-header", "--tb=short", "-q"]
            if params.get("keyword"):
                cmd += ["-k", params["keyword"]]
            if params.get("verbose"):
                cmd.append("-v")
            out, err, code = _run(cmd, cwd=project_root, timeout=60)
            combined = (out + "\n" + err).strip()
            return ToolResult(ok=code == 0, data=combined or "(no output)")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))
