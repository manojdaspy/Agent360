"""
project_agent/tools/registry.py
Central registry. Import this to get all tools.
Add a new tool class anywhere → import it here and add to _ALL_TOOL_CLASSES.
"""
from .filesystem import DirTool, TreeTool, CatTool, WriteTool, PatchTool, MkdirTool, DeleteTool
from .search import SearchTool
from .executor import ShellTool
from .git_tool import GitStatusTool, GitDiffTool, GitLogTool, GitBlameTool, GitRestoreTool
from .lint_tool import Flake8Tool, DjangoCheckTool, PytestTool
from .base import BaseTool

_ALL_TOOL_CLASSES = [
    # Filesystem
    DirTool, TreeTool, CatTool, WriteTool, PatchTool, MkdirTool, DeleteTool,
    # Search
    SearchTool,
    # Shell
    ShellTool,
    # Git
    GitStatusTool, GitDiffTool, GitLogTool, GitBlameTool, GitRestoreTool,
    # Lint / Diagnostics
    Flake8Tool, DjangoCheckTool, PytestTool,
]

# Singleton instances — one per tool class
_registry: dict[str, BaseTool] = {cls().name: cls() for cls in _ALL_TOOL_CLASSES}


def get_tool(name: str) -> BaseTool | None:
    return _registry.get(name)


def all_tools() -> list[BaseTool]:
    return list(_registry.values())


def llm_tool_schemas() -> list[dict]:
    """JSON schemas the LLM sees in its system prompt / tools param."""
    return [t.to_llm_schema() for t in all_tools()]


def tool_names() -> list[str]:
    return list(_registry.keys())
