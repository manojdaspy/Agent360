"""
project_agent/services/agent.py
The agentic loop:
  1. User sends message
  2. LLM replies (possibly with tool_use blocks)
  3. We execute each tool
  4. Feed results back → LLM continues
  5. Repeat until stop_reason == 'end_turn' or max iterations
"""
from __future__ import annotations
import time
import logging
from typing import Generator

from ..config import get_setting
from ..tools.registry import get_tool
from .llm_client import LLMClient

logger = logging.getLogger("vibescode.agent")

MAX_ITERATIONS = 20  # safety ceiling on agentic loops


class AgentLoop:
    """
    Stateless per-request loop. Pass the full conversation history each call.
    The caller (view) is responsible for persisting history to the DB.
    """

    def __init__(self, project_root: str):
        self.project_root = project_root
        self.client = LLMClient()

    # ── main entry point ──────────────────────────────────────────────────────

    def run(self, history: list[dict]) -> Generator[dict, None, None]:
        """
        Run the agentic loop, yielding events as they happen.
        Each event is a dict: {type, ...payload}

        Event types:
          llm_response   — text from the LLM
          tool_call      — a tool is about to be executed
          tool_result    — result of a tool execution
          error          — something went wrong
          done           — loop finished
        """
        messages = list(history)  # local copy we mutate

        for iteration in range(MAX_ITERATIONS):
            logger.debug(f"[agent] iteration {iteration}, messages={len(messages)}")

            # ── call the LLM ──────────────────────────────────────────────────
            try:
                response = self.client.chat(messages, tools_enabled=True)
            except Exception as exc:
                yield {"type": "error", "message": f"LLM error: {exc}"}
                return

            # ── emit text response ────────────────────────────────────────────
            if response["content"]:
                yield {"type": "llm_response", "content": response["content"]}

            # ── no tool calls → done ──────────────────────────────────────────
            if not response["tool_calls"]:
                yield {"type": "done", "iterations": iteration + 1}
                return

            # ── build the assistant message (with tool_use blocks for Claude) ─
            assistant_msg = self._build_assistant_message(response)
            messages.append(assistant_msg)

            # ── execute each tool call ────────────────────────────────────────
            tool_results = []
            for tc in response["tool_calls"]:
                tool_name = tc["name"]
                tool_input = tc["input"]
                tool_id = tc.get("id", tool_name)

                yield {"type": "tool_call", "name": tool_name, "input": tool_input}

                tool = get_tool(tool_name)
                if tool is None:
                    result = {"ok": False, "error": f"Unknown tool: {tool_name}"}
                else:
                    t0 = time.time()
                    result_obj = tool.run(tool_input, self.project_root)
                    elapsed_ms = int((time.time() - t0) * 1000)
                    result = result_obj.to_dict()
                    result["duration_ms"] = elapsed_ms

                yield {"type": "tool_result", "name": tool_name, "result": result}
                tool_results.append({"id": tool_id, "name": tool_name, "result": result})

            # ── feed results back to LLM ──────────────────────────────────────
            tool_result_msg = self._build_tool_result_message(tool_results, response["stop_reason"])
            messages.append(tool_result_msg)

        yield {"type": "error", "message": f"Reached max iterations ({MAX_ITERATIONS})."}

    # ── message builders ──────────────────────────────────────────────────────

    def _build_assistant_message(self, response: dict) -> dict:
        provider = get_setting("LLM_PROVIDER", "claude")
        if provider == "claude":
            content = []
            if response["content"]:
                content.append({"type": "text", "text": response["content"]})
            for tc in response["tool_calls"]:
                content.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["name"],
                    "input": tc["input"],
                })
            return {"role": "assistant", "content": content}
        # OpenAI format
        return {
            "role": "assistant",
            "content": response["content"],
            "tool_calls": [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": str(tc["input"])},
                }
                for tc in response["tool_calls"]
            ],
        }

    def _build_tool_result_message(self, tool_results: list[dict], stop_reason: str) -> dict:
        provider = get_setting("LLM_PROVIDER", "claude")
        import json

        if provider == "claude":
            return {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": tr["id"],
                        "content": json.dumps(tr["result"]),
                    }
                    for tr in tool_results
                ],
            }
        # OpenAI: one message per tool result
        return {
            "role": "tool",
            "content": json.dumps([tr["result"] for tr in tool_results]),
            "tool_call_id": tool_results[0]["id"] if tool_results else "",
        }
