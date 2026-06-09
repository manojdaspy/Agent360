"""
project_agent/tools/git_tool.py
Git operations: status, diff, log, blame, stash.
Requires gitpython (pip install gitpython).
Only reads unless ENABLE_GIT_WRITE = True.
"""
from __future__ import annotations
import subprocess
from pathlib import Path

from .base import BaseTool, ToolResult
from ..config import get_setting


def _run_git(project_root: str, *args: str, timeout: int = 10) -> tuple[str, str, int]:
    result = subprocess.run(
        ["git", *args],
        cwd=project_root,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.stdout.strip(), result.stderr.strip(), result.returncode


class GitStatusTool(BaseTool):
    name = "git_status"
    description = "Show the working tree status (modified, staged, untracked files)."
    input_schema = {"type": "object", "properties": {}, "required": []}

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            out, err, code = _run_git(project_root, "status", "--short", "--branch")
            return ToolResult(ok=code == 0, data=out or "(clean working tree)", error=err)
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class GitDiffTool(BaseTool):
    name = "git_diff"
    description = "Show the diff of a file or the entire working tree vs HEAD."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path, or '.' for full diff."},
            "staged": {"type": "boolean", "description": "Show staged (cached) diff instead."},
        },
        "required": [],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            args = ["diff"]
            if params.get("staged"):
                args.append("--cached")
            if params.get("path") and params["path"] != ".":
                args += ["--", params["path"]]
            out, err, code = _run_git(project_root, *args)
            return ToolResult(ok=True, data=out or "(no changes)", error=err if code != 0 else "")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class GitLogTool(BaseTool):
    name = "git_log"
    description = "Show recent commit history."
    input_schema = {
        "type": "object",
        "properties": {
            "n": {"type": "integer", "description": "Number of commits (default 10)."},
            "path": {"type": "string", "description": "Filter to commits touching this file."},
        },
        "required": [],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            n = min(int(params.get("n", 10)), 50)
            args = ["log", f"--max-count={n}", "--oneline", "--decorate"]
            if params.get("path"):
                args += ["--", params["path"]]
            out, err, code = _run_git(project_root, *args)
            return ToolResult(ok=code == 0, data=out or "(no commits)", error=err)
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class GitBlameTool(BaseTool):
    name = "git_blame"
    description = "Show who last modified each line of a file."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File path to blame."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        try:
            out, err, code = _run_git(project_root, "blame", "--abbrev=8", params["path"])
            return ToolResult(ok=code == 0, data=out, error=err)
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))


class GitRestoreTool(BaseTool):
    name = "git_restore"
    description = "Restore a file to its last committed state (discard working-tree changes). Only available when ENABLE_GIT_WRITE=True."
    input_schema = {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "File to restore."},
        },
        "required": ["path"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        if not get_setting("ENABLE_GIT_WRITE", False):
            return ToolResult(ok=False, error="git_restore requires ENABLE_GIT_WRITE=True in settings.")
        try:
            out, err, code = _run_git(project_root, "restore", params["path"])
            return ToolResult(ok=code == 0, data=f"Restored: {params['path']}", error=err)
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))
