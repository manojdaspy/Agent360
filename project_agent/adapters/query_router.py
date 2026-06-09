"""
project_agent/adapters/query_router.py

Universal Query-Param Router
─────────────────────────────
When an LLM sends a raw HTTP request with query parameters
(e.g. GET /api/agent/cmd/?op=cat&path=views.py),
this router figures out which tool to call and handles fallback.

Flow:
  Human prompt → LLM → HTTP request with ?op=X&... → QueryRouter
       → Tool exists?  YES → run tool, return result
                       NO  → CustomLogicFallback → attempt best-effort
                             → still fails? → helpful error + suggestions

This is the "glue" layer. It means:
  - Cline can call /api/agent/cmd/?op=read_file&path=...  (its native format)
  - OpenAI tool calls can call /openai/execute/?function=cat&path=...
  - Raw LLM HTTP calls hit /api/agent/cmd/?op=... (our format)
  - All three paths converge here

Supported op aliases (so every tool naming convention works):
  read / cat / read_file / get_file  → cat
  list / dir / ls / list_dir         → dir
  find / search / grep / regex       → search
  run / exec / shell / terminal      → shell
  edit / write / save / write_file   → write
  patch / replace / fix              → patch
  status / git_status                → git_status
  diff / git_diff                    → git_diff
  check / django_check               → django_check
  test / pytest / run_tests          → pytest
  lint / flake8                      → flake8
  blame / git_blame                  → git_blame
  log / git_log / history            → git_log
"""
from __future__ import annotations
import logging
from ..tools.registry import get_tool, tool_names

logger = logging.getLogger("vibescode.query_router")

# ── Op alias table ────────────────────────────────────────────────────────────
# Maps every name a tool/LLM might use → our canonical tool name

OP_ALIASES: dict[str, str] = {
    # filesystem reads
    "read": "cat", "read_file": "cat", "get_file": "cat", "open": "cat", "view": "cat",
    # filesystem list
    "ls": "dir", "list": "dir", "list_dir": "dir", "listdir": "dir", "list_files": "dir",
    # tree
    "tree": "tree", "list_tree": "tree", "full_tree": "tree",
    # write
    "write": "write", "write_file": "write", "save": "write", "save_file": "write", "create": "write",
    # patch
    "patch": "patch", "replace": "patch", "fix": "patch", "edit": "patch", "update": "patch",
    # mkdir
    "mkdir": "mkdir", "create_dir": "mkdir", "make_dir": "mkdir",
    # delete
    "delete": "delete", "remove": "delete", "rm": "delete", "unlink": "delete",
    # search
    "search": "search", "grep": "search", "find": "search", "regex": "search", "rg": "search",
    # shell
    "shell": "shell", "run": "shell", "exec": "shell", "execute": "shell",
    "terminal": "shell", "bash": "shell", "command": "shell",
    # git
    "git_status": "git_status", "status": "git_status",
    "git_diff": "git_diff", "diff": "git_diff",
    "git_log": "git_log", "log": "git_log", "history": "git_log",
    "git_blame": "git_blame", "blame": "git_blame",
    "git_restore": "git_restore", "restore": "git_restore", "revert": "git_restore",
    # lint
    "flake8": "flake8", "lint": "flake8", "pep8": "flake8",
    "django_check": "django_check", "check": "django_check", "manage_check": "django_check",
    "pytest": "pytest", "test": "pytest", "run_tests": "pytest", "tests": "pytest",
}


def resolve_op(raw_op: str) -> str | None:
    """
    Resolve a raw op name (from query param, function call, etc.)
    to our canonical tool name. Returns None if unresolvable.
    """
    if not raw_op:
        return None
    key = raw_op.strip().lower().replace("-", "_")
    # Direct match first
    if key in tool_names():
        return key
    # Alias lookup
    return OP_ALIASES.get(key)


def build_tool_params(canonical_op: str, raw_params: dict) -> dict:
    """
    Build the tool-specific params dict from flat query/body params.
    Handles multiple naming conventions gracefully.
    """
    # Normalise common param aliases
    path = (
        raw_params.get("path")
        or raw_params.get("file")
        or raw_params.get("file_path")
        or raw_params.get("filename")
        or "."
    )
    content = (
        raw_params.get("content")
        or raw_params.get("text")
        or raw_params.get("data")
        or raw_params.get("body")
        or ""
    )
    pattern = (
        raw_params.get("pattern")
        or raw_params.get("query")
        or raw_params.get("search")
        or raw_params.get("regex")
        or ""
    )
    cmd = (
        raw_params.get("cmd")
        or raw_params.get("command")
        or raw_params.get("run")
        or raw_params.get("exec")
        or ""
    )
    old_str = raw_params.get("old_str") or raw_params.get("old") or raw_params.get("find") or ""
    new_str = raw_params.get("new_str") or raw_params.get("new") or raw_params.get("replace_with") or ""

    mappings = {
        "cat":          {"path": path},
        "dir":          {"path": path},
        "tree":         {"path": path, "max_depth": int(raw_params.get("max_depth", 4))},
        "write":        {"path": path, "content": content},
        "patch":        {"path": path, "old_str": old_str, "new_str": new_str},
        "mkdir":        {"path": path},
        "delete":       {"path": path},
        "search":       {
            "path": path,
            "pattern": pattern,
            "extensions": _parse_list(raw_params.get("extensions") or raw_params.get("ext", "")),
            "context_lines": int(raw_params.get("context_lines", 2)),
        },
        "shell":        {"cmd": cmd},
        "git_status":   {},
        "git_diff":     {"path": path, "staged": _truthy(raw_params.get("staged", ""))},
        "git_log":      {"n": int(raw_params.get("n", 10)), "path": path},
        "git_blame":    {"path": path},
        "git_restore":  {"path": path},
        "flake8":       {"path": path, "max_line_length": int(raw_params.get("max_line_length", 120))},
        "django_check": {"app": raw_params.get("app", "")},
        "pytest":       {
            "path": path,
            "keyword": raw_params.get("keyword", ""),
            "verbose": _truthy(raw_params.get("verbose", "")),
        },
    }
    return mappings.get(canonical_op, dict(raw_params))


# ── Custom Fallback Logic ─────────────────────────────────────────────────────

class CustomFallbackHandler:
    """
    When an LLM or tool sends an op we don't recognise,
    this handler tries to make sense of it before giving up.

    Strategy:
      1. Fuzzy-match op name against known tools
      2. Infer intent from params (has 'path' + 'content' → probably 'write')
      3. Return structured error with suggestions + available tools
    """

    def handle(self, raw_op: str, raw_params: dict, project_root: str) -> dict:
        # Step 1: fuzzy match
        suggestion = self._fuzzy_match(raw_op)
        if suggestion:
            logger.info(f"[fallback] fuzzy matched {raw_op!r} → {suggestion}")
            tool = get_tool(suggestion)
            if tool:
                params = build_tool_params(suggestion, raw_params)
                result = tool.run(params, project_root)
                return {
                    "ok": result.ok,
                    "data": result.data,
                    "error": result.error,
                    "fallback_used": True,
                    "matched_op": suggestion,
                    "original_op": raw_op,
                }

        # Step 2: infer from params
        inferred = self._infer_from_params(raw_params)
        if inferred:
            logger.info(f"[fallback] inferred {raw_op!r} → {inferred} from params")
            tool = get_tool(inferred)
            if tool:
                params = build_tool_params(inferred, raw_params)
                result = tool.run(params, project_root)
                return {
                    "ok": result.ok,
                    "data": result.data,
                    "error": result.error,
                    "fallback_used": True,
                    "inferred_op": inferred,
                    "original_op": raw_op,
                }

        # Step 3: give up gracefully
        return {
            "ok": False,
            "error": f"Unknown operation: {raw_op!r}",
            "fallback_used": True,
            "suggestions": self._suggest(raw_op),
            "available_ops": sorted(OP_ALIASES.keys()),
            "canonical_tools": tool_names(),
            "hint": (
                "Pass one of the available_ops as ?op=<name> or in the JSON body. "
                "Common ops: cat, dir, tree, search, write, patch, shell, git_status, pytest"
            ),
        }

    def _fuzzy_match(self, raw: str) -> str | None:
        """Simple substring / prefix match against known aliases."""
        raw_lower = raw.lower().replace("-", "_")
        # substring match
        for alias, canonical in OP_ALIASES.items():
            if alias in raw_lower or raw_lower in alias:
                return canonical
        # prefix match against tool names
        for name in tool_names():
            if raw_lower.startswith(name[:3]):
                return name
        return None

    def _infer_from_params(self, params: dict) -> str | None:
        """Guess the op from which params are present."""
        has_path = bool(params.get("path") or params.get("file"))
        has_content = bool(params.get("content") or params.get("text"))
        has_pattern = bool(params.get("pattern") or params.get("regex") or params.get("grep"))
        has_cmd = bool(params.get("cmd") or params.get("command"))
        has_old_str = bool(params.get("old_str") or params.get("old"))

        if has_cmd:             return "shell"
        if has_pattern:         return "search"
        if has_old_str:         return "patch"
        if has_path and has_content: return "write"
        if has_path:            return "cat"
        return None

    def _suggest(self, raw: str) -> list[str]:
        """Return up to 3 closest-sounding tool names."""
        raw_lower = raw.lower()
        scored = []
        for alias in OP_ALIASES:
            common = sum(c in alias for c in raw_lower)
            if common > 0:
                scored.append((common, alias))
        scored.sort(reverse=True)
        return [s[1] for s in scored[:3]]


def _parse_list(val) -> list:
    if isinstance(val, list):
        return val
    if isinstance(val, str) and val:
        return [v.strip() for v in val.split(",") if v.strip()]
    return []


def _truthy(val) -> bool:
    if isinstance(val, bool):
        return val
    return str(val).lower() in ("1", "true", "yes", "on")
