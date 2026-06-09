"""
project_agent/tools/lint_tool.py
"""
from __future__ import annotations
import subprocess
from pathlib import Path

from .base import BaseTool, ToolResult
from .filesystem import _safe_resolve
from ..config import get_setting


def _run(cmd: list[str], cwd: str, timeout: int = 20) -> tuple[str, str, int]:
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return result.stdout.strip(), result.stderr.strip(), result.returncode


class Flake8Tool(BaseTool):
    name = "flake8"
    description = "Run flake8 linter on a file or directory. Returns structured violations."
    input_schema = {
        "type": "object",
        "properties": {
            "path":            {"type": "string",  "description": "File or dir to lint (default: '.')"},
            "max_line_length": {"type": "integer", "description": "Max line length (default 120)."},
        },
        "required": [],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        if not get_setting("ENABLE_SHELL", False):
            return ToolResult(ok=False, error="ENABLE_SHELL must be True to run linters.")
        try:
            target  = _safe_resolve(project_root, params.get("path", "."))
            max_len = params.get("max_line_length", 120)
            root    = Path(project_root)

            out, err, code = _run(
                ["flake8", str(target),
                 f"--max-line-length={max_len}",
                 "--format=%(path)s:%(row)d:%(col)d:%(code)s:%(text)s"],
                cwd=project_root,
            )

            if not out and not err:
                return ToolResult(
                    ok=True,
                    data={"violations": [], "total": 0, "text": "No flake8 violations found."},
                )

            violations = []
            text_lines = []
            for line in (out or err).splitlines():
                try:
                    path_str, row, col, code_str, message = line.split(":", 4)
                    rel = str(Path(path_str).relative_to(root))
                    violations.append({
                        "file":    rel,
                        "line":    int(row),
                        "col":     int(col),
                        "code":    code_str,
                        "message": message.strip(),
                    })
                    text_lines.append(f"{rel}:{row}:{col}: {code_str} {message.strip()}")
                except ValueError:
                    text_lines.append(line)

            return ToolResult(
                ok=code == 0,
                data={
                    "violations": violations,
                    "total":      len(violations),
                    "text":       "\n".join(text_lines),
                },
            )
        except FileNotFoundError:
            return ToolResult(ok=False, error="flake8 not found. Run: pip install flake8")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class DjangoCheckTool(BaseTool):
    name = "django_check"
    description = "Run Django's system check framework (manage.py check)."
    input_schema = {
        "type": "object",
        "properties": {
            "app": {"type": "string", "description": "Specific app to check (default: all)."},
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
            return ToolResult(
                ok=code == 0,
                data={"text": combined or "System check passed.", "passed": code == 0},
            )
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class PytestTool(BaseTool):
    name = "pytest"
    description = "Run pytest. Returns pass/fail summary and tracebacks."
    input_schema = {
        "type": "object",
        "properties": {
            "path":    {"type": "string",  "description": "Test file or directory (default: '.')"},
            "keyword": {"type": "string",  "description": "Filter by test name keyword (-k flag)."},
            "verbose": {"type": "boolean", "description": "Verbose output (default False)."},
        },
        "required": [],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        if not get_setting("ENABLE_SHELL", False):
            return ToolResult(ok=False, error="ENABLE_SHELL must be True.")
        try:
            target = _safe_resolve(project_root, params.get("path", "."))
            cmd    = ["python", "-m", "pytest", str(target), "--no-header", "--tb=short", "-q"]
            if params.get("keyword"):
                cmd += ["-k", params["keyword"]]
            if params.get("verbose"):
                cmd.append("-v")
            out, err, code = _run(cmd, cwd=project_root, timeout=60)
            combined = (out + "\n" + err).strip()
            return ToolResult(
                ok=code == 0,
                data={"passed": code == 0, "text": combined or "(no output)"},
            )
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))