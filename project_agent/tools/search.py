"""
project_agent/tools/search.py
Regex / text search across project files.
"""
from __future__ import annotations
import re
from pathlib import Path

from .base import BaseTool, ToolResult
from .filesystem import _safe_resolve
from ..config import get_setting


class SearchTool(BaseTool):
    name = "search"
    description = (
        "Search for a regex pattern across all files in a directory. "
        "Returns matching file paths, line numbers, and context lines."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Directory to search in (use '.' for whole project).",
            },
            "pattern": {
                "type": "string",
                "description": "Python regex pattern to search for.",
            },
            "extensions": {
                "type": "array",
                "items": {"type": "string"},
                "description": "File extensions to include, e.g. ['.py', '.html']. Empty = all allowed.",
            },
            "context_lines": {
                "type": "integer",
                "description": "Lines of context before/after a match (default 2).",
            },
            "max_matches": {
                "type": "integer",
                "description": "Stop after this many matches (default 50).",
            },
        },
        "required": ["path", "pattern"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            root = Path(project_root).resolve()
            target = _safe_resolve(project_root, params.get("path", "."))
            pattern = re.compile(params["pattern"], re.MULTILINE)
            exts = params.get("extensions") or get_setting("ALLOWED_EXTENSIONS", [])
            ctx = int(params.get("context_lines", 2))
            max_matches = int(params.get("max_matches", 50))

            results: list[str] = []
            total = 0

            files = sorted(target.rglob("*")) if target.is_dir() else [target]
            for fpath in files:
                if not fpath.is_file():
                    continue
                if exts and fpath.suffix not in exts:
                    continue
                try:
                    text = fpath.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                lines = text.splitlines()
                for lineno, line in enumerate(lines):
                    if pattern.search(line):
                        rel = fpath.relative_to(root)
                        start = max(0, lineno - ctx)
                        end = min(len(lines), lineno + ctx + 1)
                        block = [f"  {rel}:{lineno + 1}  >>>  {line.rstrip()}"]
                        if ctx:
                            context_block = "\n".join(
                                f"  {'→' if i == lineno else ' '} {i+1:4d} | {lines[i]}"
                                for i in range(start, end)
                            )
                            block = [f"\n── {rel}:{lineno+1} ──\n{context_block}"]
                        results.append("".join(block))
                        total += 1
                        if total >= max_matches:
                            results.append(f"\n... (stopped at {max_matches} matches)")
                            return ToolResult(ok=True, data="\n".join(results))

            if not results:
                return ToolResult(ok=True, data=f"No matches for pattern: {params['pattern']!r}")
            header = f"Found {total} match(es) for {params['pattern']!r}\n{'─'*60}"
            return ToolResult(ok=True, data=header + "\n" + "\n".join(results))

        except re.error as exc:
            return ToolResult(ok=False, error=f"Invalid regex: {exc}")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))
