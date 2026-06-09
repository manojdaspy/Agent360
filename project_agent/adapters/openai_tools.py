"""
project_agent/adapters/openai_tools.py

OpenAI Function-Calling / Tools Protocol Adapter
─────────────────────────────────────────────────
Cline, Continue.dev, Cursor, Aider, and most VSCode AI extensions
send tool calls in OpenAI format, NOT in MCP JSON-RPC format.

OpenAI tools protocol flow:
  1. Client sends POST with messages + tools[] (function schemas)
  2. LLM replies with finish_reason="tool_calls" + tool_calls[]
  3. Client executes each function locally OR forwards to a server
  4. Client sends tool results back as role="tool" messages
  5. Repeat until finish_reason="stop"

This adapter makes our Django server speak that protocol natively.
Cline points to /openai/chat/completions/ and we handle everything.

Supported clients:
  ✓ Cline (VSCode extension)           — openai compatible endpoint
  ✓ Continue.dev                        — openai compatible endpoint
  ✓ Cursor (custom API mode)            — openai compatible endpoint
  ✓ Aider                               — --openai-api-base flag
  ✓ Anything using LiteLLM             — proxy mode
  ✓ Direct API calls                    — curl, httpx, requests
"""
from __future__ import annotations
import json
import time
import logging
from typing import Any

logger = logging.getLogger("vibescode.openai_adapter")


# ── Schema converters ─────────────────────────────────────────────────────────

def vibescode_tools_to_openai(tool_schemas: list[dict]) -> list[dict]:
    """
    Convert our internal tool schemas → OpenAI tools[] format.

    Our format:                          OpenAI format:
    {                                    {
      name: "cat",                         type: "function",
      description: "...",                  function: {
      input_schema: { ... }                  name: "cat",
    }                                        description: "...",
                                             parameters: { ... }
                                           }
                                         }
    """
    return [
        {
            "type": "function",
            "function": {
                "name": schema["name"],
                "description": schema["description"],
                "parameters": schema["input_schema"],
            },
        }
        for schema in tool_schemas
    ]


def openai_tool_call_to_internal(tool_call: dict) -> dict:
    """
    Convert OpenAI tool_call → our internal format.

    OpenAI:                              Internal:
    {                                    {
      id: "call_abc123",                   id: "call_abc123",
      type: "function",                    name: "cat",
      function: {                          input: {"path": "views.py"}
        name: "cat",                     }
        arguments: '{"path":"views.py"}'
      }
    }
    """
    fn = tool_call.get("function", {})
    raw_args = fn.get("arguments", "{}")
    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
    except json.JSONDecodeError:
        args = {}
    return {
        "id": tool_call.get("id", f"call_{time.time_ns()}"),
        "name": fn.get("name", ""),
        "input": args,
    }


def tool_result_to_openai_message(tool_call_id: str, result: dict) -> dict:
    """
    Package a tool result as an OpenAI role=tool message.
    """
    content = json.dumps(result.get("data") or result.get("error", ""))
    return {
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": content,
    }


def internal_result_to_openai_choice(
    content: str,
    tool_calls: list[dict] | None = None,
    finish_reason: str = "stop",
    model: str = "vibescode-1",
    usage: dict | None = None,
) -> dict:
    """
    Build a full OpenAI /v1/chat/completions response body.
    This is what Cline, Continue.dev, etc. expect back.
    """
    message: dict = {"role": "assistant", "content": content}

    if tool_calls:
        finish_reason = "tool_calls"
        message["tool_calls"] = [
            {
                "id": tc.get("id", f"call_{i}"),
                "type": "function",
                "function": {
                    "name": tc["name"],
                    "arguments": json.dumps(tc["input"]),
                },
            }
            for i, tc in enumerate(tool_calls)
        ]

    return {
        "id": f"chatcmpl-vibescode-{int(time.time())}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
                "logprobs": None,
            }
        ],
        "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def openai_stream_chunk(
    delta_content: str = "",
    tool_call_chunk: dict | None = None,
    finish_reason: str | None = None,
    model: str = "vibescode-1",
) -> str:
    """
    Format a single SSE chunk in OpenAI streaming format.
    Cline and Continue.dev use streaming=True by default.
    """
    delta: dict = {}
    if delta_content:
        delta["content"] = delta_content
    if tool_call_chunk:
        delta["tool_calls"] = [tool_call_chunk]

    chunk = {
        "id": f"chatcmpl-{int(time.time_ns())}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
                "logprobs": None,
            }
        ],
    }
    return f"data: {json.dumps(chunk)}\n\n"


OPENAI_STREAM_DONE = "data: [DONE]\n\n"
