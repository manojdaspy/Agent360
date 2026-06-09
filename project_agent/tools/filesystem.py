"""
project_agent/tools/filesystem.py
Safe, sandboxed filesystem operations.
All paths are resolved relative to project_root and checked for traversal.
"""
from __future__ import annotations
import os
from pathlib import Path

from .base import BaseTool, ToolResult
from ..config import get_setting


# ── helpers ──────────────────────────────────────────────────────────────────

def _safe_resolve(project_root: str, rel_path: str) -> Path:
    """Resolve rel_path inside project_root; raise if traversal detected."""
    root = Path(project_root).resolve()
    target = (root / rel_path).resolve()
    if not str(target).startswith(str(root)):
        raise PermissionError(f"Path traversal blocked: {rel_path!r}")
    return target


def _allowed_extension(path: Path) -> bool:
    exts = get_setting("ALLOWED_EXTENSIONS", [])
    return not exts or path.suffix in exts


def _check_size(path: Path) -> None:
    max_kb = get_setting("MAX_FILE_SIZE_KB", 500)
    size_kb = path.stat().st_size / 1024
    if size_kb > max_kb:
        raise ValueError(f"File too large ({size_kb:.0f} KB > {max_kb} KB limit)")


# ── tools ─────────────────────────────────────────────────────────────────────

class DirTool(BaseTool):
    name = "dir"
    description = "List files and subdirectories at a path inside the project."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Relative path to list. Use '.' for root."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params.get("path", "."))
            if not target.exists():
                return ToolResult(ok=False, error=f"Path not found: {params['path']}")
            entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name))
            lines = []
            for e in entries:
                marker = "/" if e.is_dir() else ""
                size = f"  ({e.stat().st_size:,} B)" if e.is_file() else ""
                lines.append(f"{'DIR ' if e.is_dir() else 'FILE'} {e.name}{marker}{size}")
            return ToolResult(ok=True, data="\n".join(lines) or "(empty directory)")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class TreeTool(BaseTool):
    name = "tree"
    description = "Recursively list the full directory tree from a given path."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Root path. Use '.' for project root."},
            "max_depth": {"type": "integer", "description": "Max depth (default 4)."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params.get("path", "."))
            max_depth = int(params.get("max_depth", 4))
            lines: list[str] = []
            self._walk(target, "", 0, max_depth, lines)
            return ToolResult(ok=True, data="\n".join(lines))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))

    def _walk(self, path: Path, prefix: str, depth: int, max_depth: int, lines: list):
        if depth > max_depth:
            lines.append(prefix + "... (truncated)")
            return
        entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name))
        for i, entry in enumerate(entries):
            connector = "└── " if i == len(entries) - 1 else "├── "
            lines.append(prefix + connector + entry.name + ("/" if entry.is_dir() else ""))
            if entry.is_dir():
                extension = "    " if i == len(entries) - 1 else "│   "
                self._walk(entry, prefix + extension, depth + 1, max_depth, lines)


class CatTool(BaseTool):
    name = "cat"
    description = "Read the full contents of a file."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Relative file path to read."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if not target.is_file():
                return ToolResult(ok=False, error=f"Not a file: {params['path']}")
            if not _allowed_extension(target):
                return ToolResult(ok=False, error=f"Extension not allowed: {target.suffix}")
            _check_size(target)
            content = target.read_text(encoding="utf-8", errors="replace")
            # Number lines for easy reference in LLM output
            numbered = "\n".join(f"{i+1:4d} | {line}" for i, line in enumerate(content.splitlines()))
            return ToolResult(ok=True, data=numbered)
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class WriteTool(BaseTool):
    name = "write"
    description = "Write content to a file, creating parent directories if needed. Saves the previous version for undo."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Relative file path to write."},
            "content": {"type": "string", "description": "Full new content of the file."},
        },
        "required": ["path", "content"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if not _allowed_extension(target):
                return ToolResult(ok=False, error=f"Extension not allowed: {target.suffix}")
            before = target.read_text(encoding="utf-8") if target.exists() else ""
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(params["content"], encoding="utf-8")
            return ToolResult(ok=True, data={"written": str(target), "before": before})
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class PatchTool(BaseTool):
    """Replace a specific block of text in a file (safer than full rewrite)."""

    name = "patch"
    description = "Replace old_str with new_str inside a file. Fails if old_str not found or not unique."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "old_str": {"type": "string", "description": "Exact string to find and replace."},
            "new_str": {"type": "string", "description": "Replacement string."},
        },
        "required": ["path", "old_str", "new_str"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            content = target.read_text(encoding="utf-8")
            old = params["old_str"]
            count = content.count(old)
            if count == 0:
                return ToolResult(ok=False, error="old_str not found in file.")
            if count > 1:
                return ToolResult(ok=False, error=f"old_str found {count} times; must be unique.")
            new_content = content.replace(old, params["new_str"], 1)
            target.write_text(new_content, encoding="utf-8")
            return ToolResult(ok=True, data=f"Patched {params['path']} successfully.")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class MkdirTool(BaseTool):
    name = "mkdir"
    description = "Create a directory (and parents) at the given path."
    input_schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            target.mkdir(parents=True, exist_ok=True)
            return ToolResult(ok=True, data=f"Created: {params['path']}")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class DeleteTool(BaseTool):
    name = "delete"
    description = "Delete a single file. Directories are NOT deleted for safety."
    input_schema = {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if not target.is_file():
                return ToolResult(ok=False, error="Only files can be deleted via this tool.")
            content = target.read_text(encoding="utf-8", errors="replace")
            target.unlink()
            return ToolResult(ok=True, data={"deleted": str(target), "backup": content})
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))
