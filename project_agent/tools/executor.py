"""
project_agent/tools/executor.py
Sandboxed shell command execution.
Only active when VIBESCODE['ENABLE_SHELL'] = True.
"""
from __future__ import annotations
import subprocess
import shlex
from .base import BaseTool, ToolResult
from ..config import get_setting

# Commands never allowed regardless of config
BLOCKED_COMMANDS = {
    "rm", "rmdir", "mkfs", "dd", "shutdown", "reboot", "halt",
    "kill", "killall", "sudo", "su", "chmod", "chown",
    "wget", "curl", "nc", "netcat", "nmap",
}


class ShellTool(BaseTool):
    name = "shell"
    description = (
        "Run a shell command inside the project directory. "
        "Safe subset only: python, pip, manage.py, git, pytest, flake8, etc."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "cmd": {
                "type": "string",
                "description": "The shell command to execute (e.g. 'python manage.py check').",
            },
        },
        "required": ["cmd"],
    }

    def run(self, params: dict, project_root: str) -> ToolResult:
        if not get_setting("ENABLE_SHELL", False):
            return ToolResult(ok=False, error="Shell execution is disabled in VIBESCODE settings.")
        try:
            cmd = params["cmd"].strip()
            tokens = shlex.split(cmd)
            if not tokens:
                return ToolResult(ok=False, error="Empty command.")
            base = tokens[0].split("/")[-1]  # strip path prefix
            if base in BLOCKED_COMMANDS:
                return ToolResult(ok=False, error=f"Command '{base}' is blocked for safety.")

            timeout = get_setting("SHELL_TIMEOUT_SECONDS", 10)
            result = subprocess.run(
                cmd,
                shell=True,
                cwd=project_root,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            output = result.stdout + result.stderr
            return ToolResult(
                ok=result.returncode == 0,
                data=output.strip() or "(no output)",
                error="" if result.returncode == 0 else f"Exit code {result.returncode}",
            )
        except subprocess.TimeoutExpired:
            return ToolResult(ok=False, error=f"Command timed out after {get_setting('SHELL_TIMEOUT_SECONDS', 10)}s.")
        except Exception as exc:
            return ToolResult(ok=False, error=str(exc))
