"""
project_agent/services/llm_client.py
HTTP client that talks to Claude, OpenAI, or any OpenAI-compatible endpoint.
Uses httpx for sync requests (swap for async with httpx.AsyncClient if needed).
"""
from __future__ import annotations
import json
import httpx
from ..config import get_setting
from ..tools.registry import llm_tool_schemas

SYSTEM_PROMPT = """You are VibesCode — a senior Python/Django developer and debugging assistant.
You have direct access to the student's project filesystem through a set of tools.

RULES:
- Always explore files before suggesting any fix. Read the actual code.
- Use `search` to locate undefined variables, missing imports, and syntax errors.
- Use `cat` to read full file contents with line numbers.
- Use `patch` for precise single-block edits. Use `write` only for new files or complete rewrites.
- Use `shell` to run `python manage.py check`, `flake8`, or `pytest` to verify fixes.
- Explain every fix in plain English the student can understand.
- Never hallucinate file contents. Always read first.
- One tool call at a time. Observe the result before proceeding.

{extra}
"""


class LLMClient:
    """
    Thin HTTP wrapper. Handles provider differences so the agent doesn't care.
    Supports: claude, openai, ollama (openai-compatible).
    """

    def __init__(self):
        self.provider = get_setting("LLM_PROVIDER", "claude")
        self.api_key = get_setting("LLM_API_KEY", "")
        self.model = get_setting("LLM_MODEL", "claude-sonnet-4-20250514")
        self.max_tokens = get_setting("MAX_TOKENS", 4096)
        self.base_url = get_setting("LLM_BASE_URL") or self._default_base_url()

    def _default_base_url(self) -> str:
        return {
            "claude": "https://api.anthropic.com",
            "openai": "https://api.openai.com",
            "ollama": "http://localhost:11434",
        }.get(self.provider, "https://api.anthropic.com")

    # ── public ────────────────────────────────────────────────────────────────

    def chat(self, messages: list[dict], tools_enabled: bool = True) -> dict:
        """
        Send messages to the LLM.
        Returns a normalised dict: {role, content, tool_calls, stop_reason}
        """
        if self.provider == "claude":
            return self._call_claude(messages, tools_enabled)
        return self._call_openai_compatible(messages, tools_enabled)

    # ── providers ─────────────────────────────────────────────────────────────

    def _call_claude(self, messages: list[dict], tools_enabled: bool) -> dict:
        extra = get_setting("SYSTEM_PROMPT_EXTRA", "")
        system = SYSTEM_PROMPT.format(extra=extra)
        payload: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": messages,
        }
        if tools_enabled:
            payload["tools"] = llm_tool_schemas()

        resp = httpx.post(
            f"{self.base_url}/v1/messages",
            headers={
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        resp.raise_for_status()
        body = resp.json()
        return self._normalise_claude(body)

    def _call_openai_compatible(self, messages: list[dict], tools_enabled: bool) -> dict:
        """Works for OpenAI and Ollama (openai-compatible)."""
        extra = get_setting("SYSTEM_PROMPT_EXTRA", "")
        system_msg = {"role": "system", "content": SYSTEM_PROMPT.format(extra=extra)}
        payload: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": [system_msg] + messages,
        }
        if tools_enabled:
            payload["tools"] = [
                {"type": "function", "function": {**t, "parameters": t.pop("input_schema")}}
                for t in llm_tool_schemas()
            ]

        endpoint = (
            f"{self.base_url}/v1/chat/completions"
            if self.provider == "openai"
            else f"{self.base_url}/api/chat"
        )
        headers = {"content-type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        resp = httpx.post(endpoint, headers=headers, json=payload, timeout=60)
        resp.raise_for_status()
        return self._normalise_openai(resp.json())

    # ── normalisers ───────────────────────────────────────────────────────────

    @staticmethod
    def _normalise_claude(body: dict) -> dict:
        text_parts = [b["text"] for b in body.get("content", []) if b.get("type") == "text"]
        tool_calls = [
            {"id": b["id"], "name": b["name"], "input": b["input"]}
            for b in body.get("content", [])
            if b.get("type") == "tool_use"
        ]
        return {
            "role": "assistant",
            "content": "\n".join(text_parts),
            "tool_calls": tool_calls,
            "stop_reason": body.get("stop_reason"),
            "raw": body,
        }

    @staticmethod
    def _normalise_openai(body: dict) -> dict:
        choice = body["choices"][0]
        msg = choice["message"]
        tool_calls = []
        for tc in msg.get("tool_calls") or []:
            tool_calls.append({
                "id": tc["id"],
                "name": tc["function"]["name"],
                "input": json.loads(tc["function"]["arguments"]),
            })
        return {
            "role": "assistant",
            "content": msg.get("content") or "",
            "tool_calls": tool_calls,
            "stop_reason": choice.get("finish_reason"),
            "raw": body,
        }
