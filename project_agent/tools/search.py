"""
project_agent/tools/search.py
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
        "Returns structured matches with file paths, line numbers, and context."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "path":          {"type": "string",  "description": "Directory to search. Use '.' for whole project."},
            "pattern":       {"type": "string",  "description": "Python regex pattern."},
            "extensions":    {"type": "array",   "items": {"type": "string"}, "description": "Extensions to include, e.g. ['.py']. Empty = all allowed."},
            "context_lines": {"type": "integer", "description": "Lines of context before/after each match (default 2)."},
            "max_matches":   {"type": "integer", "description": "Stop after this many matches (default 50)."},
        },
        "required": ["path", "pattern"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            root    = Path(project_root).resolve()
            target  = _safe_resolve(project_root, params.get("path", "."))
            pattern = re.compile(params["pattern"], re.MULTILINE)
            exts    = params.get("extensions") or get_setting("ALLOWED_EXTENSIONS", [])
            ctx     = int(params.get("context_lines", 2))
            max_m   = int(params.get("max_matches", 50))

            # ── structured matches — for UIs ──────────────────────────────────
            matches: list[dict] = []
            # ── text output — for LLMs/terminals ─────────────────────────────
            text_blocks: list[str] = []
            truncated = False

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
                rel   = str(fpath.relative_to(root))

                for lineno, line in enumerate(lines):
                    if not pattern.search(line):
                        continue

                    start = max(0, lineno - ctx)
                    end   = min(len(lines), lineno + ctx + 1)

                    context = [
                        {"n": i + 1, "text": lines[i], "match": i == lineno}
                        for i in range(start, end)
                    ]

                    matches.append({
                        "file":    rel,
                        "line":    lineno + 1,
                        "text":    line.rstrip(),
                        "context": context,
                    })

                    # plain text block
                    ctx_text = "\n".join(
                        f"  {'→' if i == lineno else ' '} {i+1:4d} | {lines[i]}"
                        for i in range(start, end)
                    )
                    text_blocks.append(f"\n── {rel}:{lineno + 1} ──\n{ctx_text}")

                    if len(matches) >= max_m:
                        truncated = True
                        break

                if truncated:
                    break

            if not matches:
                return ToolResult(
                    ok=True,
                    data={
                        "pattern":   params["pattern"],
                        "matches":   [],
                        "total":     0,
                        "truncated": False,
                        "text":      f"No matches for pattern: {params['pattern']!r}",
                    },
                )

            header = f"Found {len(matches)}{'+ (truncated)' if truncated else ''} match(es) for {params['pattern']!r}"
            return ToolResult(
                ok=True,
                data={
                    "pattern":   params["pattern"],
                    "matches":   matches,
                    "total":     len(matches),
                    "truncated": truncated,
                    "text":      header + "\n" + "─" * 60 + "\n" + "\n".join(text_blocks),
                },
            )

        except re.error as exc:
            return ToolResult(ok=False, error=f"Invalid regex: {exc}")
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))