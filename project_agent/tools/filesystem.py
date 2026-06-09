"""
project_agent/tools/filesystem.py
Safe, sandboxed filesystem operations.
Only shows human-written code — ignores __pycache__, .git, node_modules, venv etc.
"""
from __future__ import annotations
import fnmatch
from pathlib import Path

from .base import BaseTool, ToolResult
from ..config import get_setting


# ── path safety ───────────────────────────────────────────────────────────────

def _safe_resolve(project_root: str, rel_path: str) -> Path:
    root = Path(project_root).resolve()
    target = (root / rel_path).resolve()
    if not str(target).startswith(str(root)):
        raise PermissionError(f"Path traversal blocked: {rel_path!r}")
    return target


# ── ignore logic ──────────────────────────────────────────────────────────────

def _ignored_dirs() -> set[str]:
    return set(get_setting("IGNORE_DIRS", []))

def _ignored_file_patterns() -> list[str]:
    return get_setting("IGNORE_FILES", [])

def is_ignored_dir(path: Path) -> bool:
    """True if this directory should be skipped entirely."""
    ignored = _ignored_dirs()
    for part in path.parts:
        if part in ignored:
            return True
        # glob patterns like *.egg-info
        if any(fnmatch.fnmatch(part, pat) for pat in ignored if "*" in pat):
            return True
    return False

def is_ignored_file(path: Path) -> bool:
    """True if this file should be hidden from the LLM."""
    patterns = _ignored_file_patterns()
    return any(fnmatch.fnmatch(path.name, pat) for pat in patterns)

def is_human_code(path: Path) -> bool:
    """Combined check: not in ignored dir, not ignored file, allowed extension."""
    if is_ignored_dir(path.parent):
        return False
    if is_ignored_file(path):
        return False
    exts = get_setting("ALLOWED_EXTENSIONS", [])
    if exts and path.suffix not in exts:
        return False
    return True


def _check_size(path: Path) -> None:
    max_kb = get_setting("MAX_FILE_SIZE_KB", 500)
    size_kb = path.stat().st_size / 1024
    if size_kb > max_kb:
        raise ValueError(f"File too large ({size_kb:.0f} KB > {max_kb} KB limit)")


# ── tools ─────────────────────────────────────────────────────────────────────

class DirTool(BaseTool):
    name = "dir"
    description = "List files and subdirectories at a path. Ignores __pycache__, .git, node_modules, venv, and other non-human directories."
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

            ignored_dirs = _ignored_dirs()
            lines = []
            entries = sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name))
            for e in entries:
                # skip ignored dirs
                if e.is_dir():
                    if e.name in ignored_dirs or any(fnmatch.fnmatch(e.name, p) for p in ignored_dirs if "*" in p):
                        continue
                    lines.append(f"DIR  {e.name}/")
                else:
                    if is_ignored_file(e):
                        continue
                    exts = get_setting("ALLOWED_EXTENSIONS", [])
                    if exts and e.suffix not in exts:
                        continue
                    lines.append(f"FILE {e.name}  ({e.stat().st_size:,} B)")

            return ToolResult(ok=True, data="\n".join(lines) or "(empty or all files ignored)")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class TreeTool(BaseTool):
    name = "tree"
    description = "Recursively list the full directory tree showing only human-written source files. Skips __pycache__, .git, node_modules, venv, and build artifacts."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Root path. Use '.' for project root."},
            "max_depth": {"type": "integer", "description": "Max depth (default 6)."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params.get("path", "."))
            max_depth = int(params.get("max_depth", 6))
            lines: list[str] = []
            self._walk(target, "", 0, max_depth, lines)
            if not lines:
                return ToolResult(ok=True, data="(no human-written source files found)")
            return ToolResult(ok=True, data="\n".join(lines))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))

    def _walk(self, path: Path, prefix: str, depth: int, max_depth: int, lines: list):
        if depth > max_depth:
            lines.append(prefix + "... (max depth reached)")
            return

        ignored_dirs = _ignored_dirs()
        try:
            entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name))
        except PermissionError:
            return

        # filter before rendering
        visible = []
        for entry in entries:
            if entry.is_dir():
                if entry.name in ignored_dirs:
                    continue
                if any(fnmatch.fnmatch(entry.name, p) for p in ignored_dirs if "*" in p):
                    continue
                visible.append(entry)
            else:
                if is_ignored_file(entry):
                    continue
                exts = get_setting("ALLOWED_EXTENSIONS", [])
                if exts and entry.suffix not in exts:
                    continue
                visible.append(entry)

        for i, entry in enumerate(visible):
            connector = "└── " if i == len(visible) - 1 else "├── "
            lines.append(prefix + connector + entry.name + ("/" if entry.is_dir() else ""))
            if entry.is_dir():
                extension = "    " if i == len(visible) - 1 else "│   "
                self._walk(entry, prefix + extension, depth + 1, max_depth, lines)


class CatTool(BaseTool):
    name = "cat"
    description = "Read the full contents of a source file with line numbers."
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
            if is_ignored_dir(target.parent):
                return ToolResult(ok=False, error=f"Path is inside an ignored directory.")
            if is_ignored_file(target):
                return ToolResult(ok=False, error=f"File is in the ignore list.")
            exts = get_setting("ALLOWED_EXTENSIONS", [])
            if exts and target.suffix not in exts:
                return ToolResult(ok=False, error=f"Extension not allowed: {target.suffix}")
            _check_size(target)
            content = target.read_text(encoding="utf-8", errors="replace")
            numbered = "\n".join(f"{i+1:4d} | {line}" for i, line in enumerate(content.splitlines()))
            return ToolResult(ok=True, data=numbered)
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class WriteTool(BaseTool):
    name = "write"
    description = "Write content to a file. Creates parent dirs if needed. Saves previous version for undo."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
        },
        "required": ["path", "content"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if is_ignored_dir(target.parent):
                return ToolResult(ok=False, error="Cannot write inside an ignored directory.")
            exts = get_setting("ALLOWED_EXTENSIONS", [])
            if exts and target.suffix not in exts:
                return ToolResult(ok=False, error=f"Extension not allowed: {target.suffix}")
            before = target.read_text(encoding="utf-8") if target.exists() else ""
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(params["content"], encoding="utf-8")
            return ToolResult(ok=True, data={"written": str(target), "before": before})
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class PatchTool(BaseTool):
    name = "patch"
    description = "Replace old_str with new_str in a file. Fails if old_str not found or not unique."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
            "old_str": {"type": "string"},
            "new_str": {"type": "string"},
        },
        "required": ["path", "old_str", "new_str"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if is_ignored_dir(target.parent):
                return ToolResult(ok=False, error="Cannot patch a file inside an ignored directory.")
            content = target.read_text(encoding="utf-8")
            old = params["old_str"]
            count = content.count(old)
            if count == 0:
                return ToolResult(ok=False, error="old_str not found in file.")
            if count > 1:
                return ToolResult(ok=False, error=f"old_str found {count} times — must be unique.")
            target.write_text(content.replace(old, params["new_str"], 1), encoding="utf-8")
            return ToolResult(ok=True, data=f"Patched {params['path']} successfully.")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class MkdirTool(BaseTool):
    name = "mkdir"
    description = "Create a directory."
    input_schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            target.mkdir(parents=True, exist_ok=True)
            return ToolResult(ok=True, data=f"Created: {params['path']}")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class DeleteTool(BaseTool):
    name = "delete"
    description = "Delete a single source file. Saves backup."
    input_schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if not target.is_file():
                return ToolResult(ok=False, error="Only files can be deleted.")
            if is_ignored_dir(target.parent):
                return ToolResult(ok=False, error="Cannot delete from an ignored directory.")
            content = target.read_text(encoding="utf-8", errors="replace")
            target.unlink()
            return ToolResult(ok=True, data={"deleted": str(target), "backup": content})
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))
