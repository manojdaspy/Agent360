"""
project_agent/tools/filesystem.py
"""
from __future__ import annotations
import fnmatch
import os
import urllib.parse
from pathlib import Path

from .base import BaseTool, ToolResult
from ..config import get_setting


# ── Path safety ───────────────────────────────────────────────────────────────

def _normalise_input_path(raw: str) -> str:
    """
    Normalise any path string coming from any OS or client:
      - URL-encoded:         mainapp%2Fviews.py      → mainapp/views.py
      - URL-encoded win:     mainapp%5Ctools%5Cfile  → mainapp/tools/file
      - Windows backslashes: mainapp\\views.py       → mainapp/views.py
      - Mixed separators:    mainapp\\tools/file.py  → mainapp/tools/file.py
    """
    p = urllib.parse.unquote(raw)               # %5C → \, %2F → /
    p = p.replace("\\", os.sep).replace("/", os.sep)  # unify separators
    return str(Path(p))                         # collapse . and ..


def _safe_resolve(project_root: str, raw_path: str) -> Path:
    """
    Resolve a path that may be relative or absolute, from any OS.
    Raises PermissionError if it escapes the project root sandbox.
    """
    root = Path(project_root).resolve()
    normalised = _normalise_input_path(raw_path)
    candidate = Path(normalised)

    # Absolute path → use directly; relative → join with root
    target = candidate.resolve() if candidate.is_absolute() else (root / candidate).resolve()

    # Sandbox check — relative_to() is immune to the string-prefix bug
    try:
        target.relative_to(root)
    except ValueError:
        raise PermissionError(
            f"Path '{raw_path}' resolves to '{target}' "
            f"which is outside project root '{root}'"
        )
    return target


# ── Ignore logic ──────────────────────────────────────────────────────────────

def _ignored_dirs() -> set[str]:
    return set(get_setting("IGNORE_DIRS", []))

def _ignored_file_patterns() -> list[str]:
    return get_setting("IGNORE_FILES", [])

def is_ignored_dir(path: Path) -> bool:
    ignored = _ignored_dirs()
    for part in path.parts:
        if part in ignored:
            return True
        if any(fnmatch.fnmatch(part, pat) for pat in ignored if "*" in pat):
            return True
    return False

def is_ignored_file(path: Path) -> bool:
    return any(fnmatch.fnmatch(path.name, pat) for pat in _ignored_file_patterns())

def is_human_code(path: Path) -> bool:
    if is_ignored_dir(path.parent):
        return False
    if is_ignored_file(path):
        return False
    exts = get_setting("ALLOWED_EXTENSIONS", [])
    return not (exts and path.suffix not in exts)

def _check_size(path: Path) -> None:
    max_kb = get_setting("MAX_FILE_SIZE_KB", 500)
    size_kb = path.stat().st_size / 1024
    if size_kb > max_kb:
        raise ValueError(f"File too large ({size_kb:.0f} KB > {max_kb} KB limit)")


# ── Shared file/dir filter ────────────────────────────────────────────────────

def _visible_entries(target: Path) -> tuple[list[Path], list[Path], int]:
    """
    Return (dirs, files, ignored_count) for a single directory level.
    Applies IGNORE_DIRS, IGNORE_FILES, and ALLOWED_EXTENSIONS filters.
    """
    ignored_dirs = _ignored_dirs()
    exts = get_setting("ALLOWED_EXTENSIONS", [])
    dirs, files = [], []
    ignored_count = 0

    for e in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name)):
        if e.is_dir():
            if e.name in ignored_dirs or any(fnmatch.fnmatch(e.name, p) for p in ignored_dirs if "*" in p):
                ignored_count += 1
                continue
            dirs.append(e)
        else:
            if is_ignored_file(e) or (exts and e.suffix not in exts):
                ignored_count += 1
                continue
            files.append(e)

    return dirs, files, ignored_count


# ── Tools ─────────────────────────────────────────────────────────────────────

class DirTool(BaseTool):
    name = "dir"
    description = "List files and subdirectories at a path. Ignores build artifacts, venv, node_modules, etc."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Relative or absolute path. Use '.' for root."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params.get("path", "."))
            if not target.exists():
                return ToolResult(ok=False, error=f"Path not found: {params.get('path')}")

            dirs, files, ignored = _visible_entries(target)

            dir_items  = [{"name": d.name, "type": "dir"} for d in dirs]
            file_items = [
                {"name": f.name, "type": "file", "size": f.stat().st_size, "ext": f.suffix}
                for f in files
            ]

            text_lines = (
                [f"DIR  {d['name']}/" for d in dir_items] +
                [f"FILE {f['name']}  ({f['size']:,} B)" for f in file_items]
            )

            return ToolResult(
                ok=True,
                data={
                    "path":    str(target),
                    "dirs":    dir_items,
                    "files":   file_items,
                    "summary": {
                        "dirs":    len(dir_items),
                        "files":   len(file_items),
                        "ignored": ignored,
                    },
                    "text": "\n".join(text_lines) or "(empty or all files ignored)",
                },
            )
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class TreeTool(BaseTool):
    name = "tree"
    description = "Recursively list the full directory tree showing only human-written source files."
    input_schema = {
        "type": "object",
        "properties": {
            "path":      {"type": "string",  "description": "Root path. Use '.' for project root."},
            "max_depth": {"type": "integer", "description": "Max depth (default 6)."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target    = _safe_resolve(project_root, params.get("path", "."))
            max_depth = int(params.get("max_depth", 6))

            nodes: list[dict] = []
            text_lines: list[str] = []
            stats = {"dirs": 0, "files": 0, "ignored": 0}

            self._walk(target, "", 0, max_depth, nodes, text_lines, stats)

            return ToolResult(
                ok=True,
                data={
                    "root":    str(target),
                    "nodes":   nodes,           # structured — for UIs
                    "summary": stats,
                    "text":    "\n".join(text_lines) or "(no human-written source files found)",
                },
            )
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))

    def _walk(
        self,
        path: Path,
        prefix: str,
        depth: int,
        max_depth: int,
        nodes: list[dict],
        text_lines: list[str],
        stats: dict,
    ):
        if depth > max_depth:
            text_lines.append(prefix + "... (max depth reached)")
            return

        try:
            dirs, files, ignored = _visible_entries(path)
        except PermissionError:
            return

        stats["ignored"] += ignored
        visible = dirs + files

        for i, entry in enumerate(visible):
            is_last   = i == len(visible) - 1
            connector = "└── " if is_last else "├── "
            is_dir    = entry.is_dir()

            text_lines.append(prefix + connector + entry.name + ("/" if is_dir else ""))

            node: dict = {
                "path":  str(entry),
                "name":  entry.name,
                "type":  "dir" if is_dir else "file",
                "depth": depth,
            }
            if not is_dir:
                node["size"] = entry.stat().st_size
                node["ext"]  = entry.suffix
                stats["files"] += 1
            else:
                stats["dirs"] += 1

            nodes.append(node)

            if is_dir:
                extension = "    " if is_last else "│   "
                self._walk(entry, prefix + extension, depth + 1, max_depth, nodes, text_lines, stats)


class CatTool(BaseTool):
    name = "cat"
    description = "Read the full contents of a source file with line numbers."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Relative or absolute file path to read."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if not target.is_file():
                return ToolResult(ok=False, error=f"Not a file: {params['path']}")
            if is_ignored_dir(target.parent):
                return ToolResult(ok=False, error="Path is inside an ignored directory.")
            if is_ignored_file(target):
                return ToolResult(ok=False, error="File is in the ignore list.")
            exts = get_setting("ALLOWED_EXTENSIONS", [])
            if exts and target.suffix not in exts:
                return ToolResult(ok=False, error=f"Extension not allowed: {target.suffix}")
            _check_size(target)

            content = target.read_text(encoding="utf-8", errors="replace")
            lines   = content.splitlines()

            return ToolResult(
                ok=True,
                data={
                    "path":       str(target),
                    "lines":      len(lines),
                    "size":       target.stat().st_size,
                    "encoding":   "utf-8",
                    # structured — for UIs that want line-by-line access
                    "content":    [{"n": i + 1, "text": line} for i, line in enumerate(lines)],
                    # plain text — for LLMs and terminals
                    "text": "\n".join(f"{i+1:4d} | {line}" for i, line in enumerate(lines)),
                },
            )
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class WriteTool(BaseTool):
    name = "write"
    description = "Write content to a file. Creates parent dirs if needed. Saves previous version for undo."
    input_schema = {
        "type": "object",
        "properties": {
            "path":    {"type": "string"},
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

            before = target.read_text(encoding="utf-8") if target.exists() else None
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(params["content"], encoding="utf-8")

            return ToolResult(
                ok=True,
                data={
                    "path":    str(target),
                    "written": len(params["content"]),
                    "created": before is None,   # True = new file, False = overwrite
                    "before":  before,           # None = new file; string = previous content (for undo)
                },
            )
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class PatchTool(BaseTool):
    name = "patch"
    description = "Replace old_str with new_str in a file. Fails if old_str not found or not unique."
    input_schema = {
        "type": "object",
        "properties": {
            "path":    {"type": "string"},
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
            old     = params["old_str"]
            count   = content.count(old)

            if count == 0:
                return ToolResult(ok=False, error="old_str not found in file.")
            if count > 1:
                return ToolResult(ok=False, error=f"old_str found {count} times — must be unique.")

            new_content = content.replace(old, params["new_str"], 1)
            target.write_text(new_content, encoding="utf-8")

            return ToolResult(
                ok=True,
                data={
                    "path":       str(target),
                    "replaced":   1,
                    "size_delta": len(new_content) - len(content),
                },
            )
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class MkdirTool(BaseTool):
    name = "mkdir"
    description = "Create a directory (and any missing parents)."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            target.mkdir(parents=True, exist_ok=True)
            return ToolResult(ok=True, data={"path": str(target), "created": True})
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class DeleteTool(BaseTool):
    name = "delete"
    description = "Delete a single source file. Content is returned for undo."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string"},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            target = _safe_resolve(project_root, params["path"])
            if not target.is_file():
                return ToolResult(ok=False, error="Only files can be deleted.")
            if is_ignored_dir(target.parent):
                return ToolResult(ok=False, error="Cannot delete from an ignored directory.")

            content = target.read_text(encoding="utf-8", errors="replace")
            target.unlink()

            return ToolResult(
                ok=True,
                data={
                    "path":   str(target),
                    "deleted": True,
                    "before": content,    # for undo
                },
            )
        except PermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))