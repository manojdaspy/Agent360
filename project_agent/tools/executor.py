"""
project_agent/tools/executor.py
Sandboxed shell command execution.
Only active when VIBESCODE['ENABLE_SHELL'] = True.

Works on Windows, macOS, and Linux.
"""
from __future__ import annotations
import os
import sys
import subprocess
import shlex
from pathlib import Path

from .base import BaseTool, ToolResult
from ..config import get_setting


# ── Blocked commands (always, on every OS) ────────────────────────────────────

# Base names that are never allowed, regardless of path prefix or extension.
BLOCKED_COMMANDS: set[str] = {
    # Destructive filesystem
    "rm", "rmdir", "del", "erase", "format", "mkfs", "dd",
    # System control
    "shutdown", "reboot", "halt", "poweroff", "init",
    # Privilege escalation
    "sudo", "su", "runas", "doas",
    # Permission changes
    "chmod", "chown", "icacls", "attrib", "cacls",
    # Process control
    "kill", "killall", "taskkill", "pkill",
    # Network exfiltration
    "wget", "curl", "nc", "netcat", "ncat", "nmap",
    "scp", "sftp", "ftp", "tftp", "rsync",
    # Shells (prevent shell escape)
    "bash", "sh", "zsh", "fish", "dash", "ksh",
    "cmd", "powershell", "pwsh",
}


def _extract_base(token: str) -> str:
    """
    Extract just the command name from a token, stripping:
      - Path prefix:   /usr/bin/curl       → curl
      - Windows path:  C:\\Windows\\curl   → curl
      - Extension:     python.exe          → python   (Windows)
    """
    name = Path(token).name          # handles both / and \ separators
    # Strip common executable extensions on Windows
    for ext in (".exe", ".cmd", ".bat", ".com", ".ps1"):
        if name.lower().endswith(ext):
            name = name[: -len(ext)]
            break
    return name.lower()


def _is_blocked(tokens: list[str]) -> str | None:
    """
    Return the offending command name if any token in the pipeline is blocked,
    otherwise None.

    Checks the first token and every token after a pipe/semicolon/&&/||
    so chained commands like  'echo hi | curl ...'  are also caught.
    """
    CHAIN_OPS = {"|", "||", ";", "&&", "&"}
    check_next = True
    for token in tokens:
        if token in CHAIN_OPS:
            check_next = True
            continue
        if check_next:
            base = _extract_base(token)
            if base in BLOCKED_COMMANDS:
                return base
            check_next = False
    return None


def _build_subprocess_args(cmd: str) -> dict:
    """
    Return kwargs for subprocess.run that work on all platforms.

    Windows:  run through cmd.exe /c  (handles .bat, .cmd, built-ins like dir)
    POSIX:    run through /bin/sh -c   (standard on Linux + macOS)

    We always use shell=False with an explicit argv so we control the shell
    binary and avoid double-interpretation of the command string.
    """
    if sys.platform == "win32":
        # cmd.exe /c lets Windows resolve PATH, .exe/.bat/.cmd extensions, etc.
        return {
            "args": ["cmd.exe", "/c", cmd],
            "shell": False,
        }
    else:
        # Explicit /bin/sh avoids relying on $SHELL env var
        return {
            "args": ["/bin/sh", "-c", cmd],
            "shell": False,
        }


class ShellTool(BaseTool):
    name = "shell"
    description = (
        "Run a sandboxed shell command inside the project directory. "
        "Allowed: python, pip, manage.py, git, pytest, flake8, npm, etc. "
        "Blocked: rm, curl, sudo, kill, bash, powershell, and other dangerous commands."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "cmd": {
                "type": "string",
                "description": (
                    "Shell command to run, e.g. 'python manage.py check' or "
                    "'npm run build'. Runs inside the project root directory."
                ),
            },
        },
        "required": ["cmd"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        # ── 0. Feature flag ───────────────────────────────────────────────────
        if not get_setting("ENABLE_SHELL", False):
            return ToolResult(
                ok=False,
                error="Shell execution is disabled. Set VIBESCODE['ENABLE_SHELL'] = True to enable.",
            )

        cmd = params.get("cmd", "").strip()
        if not cmd:
            return ToolResult(ok=False, error="Empty command.")

        # ── 1. Tokenise for blocklist check ───────────────────────────────────
        # shlex.split() is POSIX-only; on Windows it still works for basic
        # commands but won't handle all cmd.exe quoting edge cases.
        # We only need the tokens for the blocklist scan, not for execution.
        try:
            if sys.platform == "win32":
                # Simple split is enough for blocklist scanning on Windows
                tokens = cmd.split()
            else:
                tokens = shlex.split(cmd)
        except ValueError:
            # Unmatched quotes etc. — let the shell surface the real error
            tokens = cmd.split()

        # ── 2. Blocklist check ────────────────────────────────────────────────
        offender = _is_blocked(tokens)
        if offender:
            return ToolResult(
                ok=False,
                error=(
                    f"Command '{offender}' is blocked for safety. "
                    f"Blocked list: {', '.join(sorted(BLOCKED_COMMANDS))}."
                ),
            )

        # ── 3. Resolve & validate project root ────────────────────────────────
        cwd = Path(project_root).resolve()
        if not cwd.exists():
            return ToolResult(ok=False, error=f"Project root does not exist: {cwd}")

        # ── 4. Build a clean environment ──────────────────────────────────────
        env = os.environ.copy()
        # Ensure the project root is on PYTHONPATH so manage.py etc. work
        python_path = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = str(cwd) + (os.pathsep + python_path if python_path else "")

        # ── 5. Execute ────────────────────────────────────────────────────────
        timeout = get_setting("SHELL_TIMEOUT_SECONDS", 10)
        try:
            result = subprocess.run(
                **_build_subprocess_args(cmd),
                cwd=str(cwd),
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
            )
        except FileNotFoundError as exc:
            # Shell binary not found (very unlikely, but handle it)
            return ToolResult(ok=False, error=f"Shell not found: {exc}")
        except subprocess.TimeoutExpired:
            return ToolResult(
                ok=False,
                error=f"Command timed out after {timeout}s.",
            )
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))

        # ── 6. Return result ──────────────────────────────────────────────────
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        # Combine stdout + stderr the same way a terminal would show them,
        # but label stderr so the LLM knows which is which.
        parts = []
        if stdout:
            parts.append(stdout)
        if stderr:
            parts.append(f"[stderr]\n{stderr}")
        output = "\n".join(parts) or "(no output)"

        return ToolResult(
            ok=result.returncode == 0,
            data=output,
            error="" if result.returncode == 0 else f"Exit code {result.returncode}",
        )