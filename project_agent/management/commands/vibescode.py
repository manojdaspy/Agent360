"""
project_agent/management/commands/vibescode.py

Django management command — terminal CLI for VibesCode agent.

Usage:
  python manage.py vibescode "Fix the NameError in mainapp/views.py"
  python manage.py vibescode --interactive
  python manage.py vibescode --tool cat --path mainapp/views.py
  python manage.py vibescode --tool search --pattern "NameError" --path .
  python manage.py vibescode --tool git_status
  python manage.py vibescode --tool django_check
  python manage.py vibescode --tool pytest
  python manage.py vibescode --list-tools

This is the "local" mode — no HTTP involved, runs tools directly in-process.
"""
import sys
import json
from django.core.management.base import BaseCommand, CommandError
from ...config import get_setting
from ...tools.registry import get_tool, all_tools
from ...services.agent import AgentLoop


RESET = "\033[0m"
BOLD = "\033[1m"
CYAN = "\033[96m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
BLUE = "\033[94m"
DIM = "\033[2m"
MAGENTA = "\033[95m"


def c(color: str, text: str) -> str:
    """Colorize if stdout is a TTY."""
    if sys.stdout.isatty():
        return color + text + RESET
    return text


BANNER = f"""
{CYAN}{BOLD}
  ██╗   ██╗██╗██████╗ ███████╗███████╗ ██████╗ ██████╗ ██████╗ ███████╗
  ██║   ██║██║██╔══██╗██╔════╝██╔════╝██╔════╝██╔═══██╗██╔══██╗██╔════╝
  ██║   ██║██║██████╔╝█████╗  ███████╗██║     ██║   ██║██║  ██║█████╗  
  ╚██╗ ██╔╝██║██╔══██╗██╔══╝  ╚════██║██║     ██║   ██║██║  ██║██╔══╝  
   ╚████╔╝ ██║██████╔╝███████╗███████║╚██████╗╚██████╔╝██████╔╝███████╗
    ╚═══╝  ╚═╝╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
{RESET}{DIM}  LLM-Powered Django Project Agent  |  MCP-compatible  |  HTTP/SSE{RESET}
"""


class Command(BaseCommand):
    help = "VibesCode agent — AI coding assistant for your Django project"

    def add_arguments(self, parser):
        parser.add_argument(
            "message",
            nargs="?",
            help="Message to send to the agent (e.g. 'Fix the NameError in views.py')",
        )
        parser.add_argument(
            "--interactive", "-i",
            action="store_true",
            help="Start interactive chat session",
        )
        parser.add_argument(
            "--tool", "-t",
            help="Run a specific tool directly (bypasses LLM)",
        )
        parser.add_argument(
            "--path", "-p",
            default=".",
            help="Path argument for tools",
        )
        parser.add_argument(
            "--pattern",
            help="Regex pattern for search tool",
        )
        parser.add_argument(
            "--cmd",
            help="Shell command for shell tool",
        )
        parser.add_argument(
            "--list-tools",
            action="store_true",
            help="List all available tools",
        )
        parser.add_argument(
            "--project-root",
            help="Override VIBESCODE.PROJECT_ROOT setting",
        )
        parser.add_argument(
            "--no-color-output",
            action="store_true",
            help="Disable ANSI color output",
        )

    def handle(self, *args, **options):
        project_root = options.get("project_root") or get_setting("PROJECT_ROOT")
        if not project_root and not options.get("list_tools"):
            raise CommandError(
                "PROJECT_ROOT not configured. Set VIBESCODE['PROJECT_ROOT'] in settings.py "
                "or pass --project-root /path/to/project"
            )

        self.stdout.write(BANNER)

        if options.get("list_tools"):
            return self._list_tools()

        if options.get("tool"):
            return self._run_tool(options["tool"], options, project_root)

        if options.get("interactive"):
            return self._interactive(project_root)

        if options.get("message"):
            return self._single_message(options["message"], project_root)

        self.stdout.write(self.style.WARNING(
            "No action specified. Use --interactive, --tool <name>, or pass a message.\n"
            "Run: python manage.py vibescode --help"
        ))

    # ── list tools ────────────────────────────────────────────────────────────

    def _list_tools(self):
        self.stdout.write(c(BOLD, "\n  Available Tools\n  " + "─" * 50))
        for tool in all_tools():
            self.stdout.write(
                f"  {c(CYAN, tool.name):<30} {c(DIM, tool.description)}"
            )
        self.stdout.write("")

    # ── direct tool execution ─────────────────────────────────────────────────

    def _run_tool(self, tool_name: str, options: dict, project_root: str):
        tool = get_tool(tool_name)
        if tool is None:
            raise CommandError(f"Unknown tool: {tool_name!r}. Run --list-tools to see available tools.")

        # Build params from CLI options
        params: dict = {"path": options.get("path", ".")}
        if options.get("pattern"):
            params["pattern"] = options["pattern"]
        if options.get("cmd"):
            params["cmd"] = options["cmd"]

        self.stdout.write(c(DIM, f"\n  ▶ Running tool: {tool_name}  params={params}\n"))

        result = tool.run(params, project_root)

        if result.ok:
            self.stdout.write(c(GREEN, "  ✓ OK\n"))
            self.stdout.write(str(result.data))
        else:
            self.stdout.write(c(RED, f"  ✗ Error: {result.error}"))

    # ── single message ────────────────────────────────────────────────────────

    def _single_message(self, message: str, project_root: str):
        self.stdout.write(c(BOLD, f"\n  You: ") + message)
        self.stdout.write(c(DIM, "  Thinking...\n"))
        self._run_agent(message, [], project_root)

    # ── interactive mode ──────────────────────────────────────────────────────

    def _interactive(self, project_root: str):
        self.stdout.write(c(GREEN, f"  Project: {project_root}"))
        self.stdout.write(c(DIM, "  Type your message and press Enter. Ctrl+C or 'exit' to quit.\n"))

        history = []

        while True:
            try:
                user_input = input(c(CYAN + BOLD, "  You: ")).strip()
            except (KeyboardInterrupt, EOFError):
                self.stdout.write(c(DIM, "\n  Session ended."))
                break

            if not user_input:
                continue
            if user_input.lower() in ("exit", "quit", "q"):
                self.stdout.write(c(DIM, "  Goodbye!"))
                break

            self.stdout.write(c(DIM, "  Thinking...\n"))
            response_text = self._run_agent(user_input, history, project_root)

            # Build history for next turn
            history.append({"role": "user", "content": user_input})
            if response_text:
                history.append({"role": "assistant", "content": response_text})

    # ── agent runner (shared by single + interactive) ─────────────────────────

    def _run_agent(self, message: str, history: list, project_root: str) -> str:
        full_history = history + [{"role": "user", "content": message}]
        loop = AgentLoop(project_root=project_root)
        response_parts = []

        for event in loop.run(full_history):
            etype = event["type"]

            if etype == "llm_response":
                response_parts.append(event["content"])
                self.stdout.write(c(BOLD, "\n  Agent: ") + event["content"] + "\n")

            elif etype == "tool_call":
                tool_label = c(YELLOW, f"  ⚙  {event['name']}")
                param_str = c(DIM, "  " + json.dumps(event["input"], ensure_ascii=False)[:120])
                self.stdout.write(tool_label)
                self.stdout.write(param_str)

            elif etype == "tool_result":
                ok = event["result"].get("ok", False)
                symbol = c(GREEN, "  ✓") if ok else c(RED, "  ✗")
                preview = str(event["result"].get("data") or event["result"].get("error", ""))[:200]
                self.stdout.write(f"{symbol} {c(DIM, preview)}")

            elif etype == "error":
                self.stdout.write(c(RED, f"\n  ✗ Error: {event['message']}"))

            elif etype == "done":
                self.stdout.write(c(DIM, f"\n  Done in {event.get('iterations', '?')} iteration(s).\n"))

        return "\n".join(response_parts)
