"""
project_agent/openai_compat/views.py

OpenAI-Compatible Chat Completions Endpoint
─────────────────────────────────────────────
Mount at /openai/v1/ and point Cline, Continue.dev, Aider, or any
OpenAI-compatible client here. They will use it exactly as if it were
the real OpenAI API — but every tool call actually runs against your
sandboxed Django project.

How Cline uses this:
  1. User types a message in VSCode
  2. Cline POSTs to /openai/v1/chat/completions with:
       - messages: conversation history
       - tools: (ignored — we inject our own)
       - stream: true
  3. We forward to the real LLM (Claude/GPT/Ollama) with OUR tools injected
  4. LLM replies with tool_calls → we execute them locally → feed results back
  5. We stream the final response back to Cline in OpenAI SSE format

This means Cline handles zero tool logic. Our server IS the tool executor.
Cline just sees a normal OpenAI-compatible LLM that happens to know
how to read and write your project files.

Configuration in Cline (VSCode settings.json):
  "cline.apiProvider": "openai-compatible",
  "cline.openAiBaseUrl": "http://localhost:8000/openai/v1",
  "cline.openAiApiKey": "your-vibescode-token",
  "cline.openAiModelId": "vibescode-agent"

Configuration in Continue.dev (~/.continue/config.json):
  {
    "models": [{
      "title": "VibesCode",
      "provider": "openai",
      "model": "vibescode-agent",
      "apiBase": "http://localhost:8000/openai/v1",
      "apiKey": "your-vibescode-token"
    }]
  }

Configuration in Aider:
  aider --openai-api-base http://localhost:8000/openai/v1 \\
        --openai-api-key your-token \\
        --model vibescode-agent
"""
from __future__ import annotations
import json
import time
import logging

from django.http import StreamingHttpResponse, JsonResponse
from django.views import View
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator

from ..config import get_setting
from ..permissions import AgentTokenPermission
from ..services.llm_client import LLMClient
from ..tools.registry import get_tool, llm_tool_schemas
from ..adapters.openai_tools import (
    vibescode_tools_to_openai,
    openai_tool_call_to_internal,
    tool_result_to_openai_message,
    internal_result_to_openai_choice,
    openai_stream_chunk,
    OPENAI_STREAM_DONE,
)

logger = logging.getLogger("vibescode.openai_compat")

MAX_ITERATIONS = 20


def _get_project_root(request) -> str:
    """
    Project root resolution order:
    1. X-Project-Root header (Cline custom header)
    2. project_root query param
    3. VIBESCODE.PROJECT_ROOT setting
    """
    return (
        request.headers.get("X-Project-Root")
        or request.GET.get("project_root")
        or get_setting("PROJECT_ROOT", ".")
    )


@method_decorator(csrf_exempt, name="dispatch")
class OpenAIChatCompletionsView(View):
    """
    POST /openai/v1/chat/completions
    Speaks OpenAI API. Cline, Continue.dev, Aider connect here directly.
    """

    def post(self, request):
        # ── Auth ──────────────────────────────────────────────────────────────
        auth = request.headers.get("Authorization", "")
        expected_token = get_setting("API_TOKEN", "")
        if expected_token and auth != f"Bearer {expected_token}":
            return JsonResponse({"error": {"message": "Unauthorized", "type": "auth_error"}}, status=401)

        # ── Parse body ────────────────────────────────────────────────────────
        try:
            body = json.loads(request.body)
        except json.JSONDecodeError:
            return JsonResponse({"error": {"message": "Invalid JSON"}}, status=400)

        messages = body.get("messages", [])
        stream = body.get("stream", False)
        model = body.get("model", "vibescode-agent")
        project_root = _get_project_root(request)

        logger.info(f"[openai_compat] model={model} stream={stream} project_root={project_root} msgs={len(messages)}")

        if stream:
            return self._handle_streaming(messages, model, project_root)
        else:
            return self._handle_sync(messages, model, project_root)

    # ── Sync (non-streaming) ──────────────────────────────────────────────────

    def _handle_sync(self, messages: list, model: str, project_root: str) -> JsonResponse:
        client = LLMClient()
        loop_messages = list(messages)

        for iteration in range(MAX_ITERATIONS):
            response = client.chat(loop_messages, tools_enabled=True)
            tool_calls_internal = response.get("tool_calls", [])

            if not tool_calls_internal:
                # Done — return final response in OpenAI format
                return JsonResponse(
                    internal_result_to_openai_choice(
                        content=response["content"],
                        finish_reason="stop",
                        model=model,
                    )
                )

            # Execute tool calls
            tool_results_msgs = []
            for tc in tool_calls_internal:
                result = self._execute_tool(tc, project_root)
                tool_results_msgs.append(
                    tool_result_to_openai_message(tc["id"], result)
                )

            # Append assistant message + tool results and loop
            loop_messages.append(self._build_assistant_msg(response))
            loop_messages.extend(tool_results_msgs)

        return JsonResponse(
            internal_result_to_openai_choice(
                content="[Max iterations reached]", finish_reason="stop", model=model
            )
        )

    # ── Streaming (what Cline uses by default) ────────────────────────────────

    def _handle_streaming(self, messages: list, model: str, project_root: str) -> StreamingHttpResponse:
        def event_stream():
            client = LLMClient()
            loop_messages = list(messages)

            for iteration in range(MAX_ITERATIONS):
                response = client.chat(loop_messages, tools_enabled=True)
                tool_calls_internal = response.get("tool_calls", [])

                if not tool_calls_internal:
                    # Stream final text response
                    text = response.get("content", "")
                    if text:
                        yield openai_stream_chunk(delta_content=text, model=model)
                    yield openai_stream_chunk(finish_reason="stop", model=model)
                    yield OPENAI_STREAM_DONE
                    return

                # Stream tool call notification so client sees activity
                for i, tc in enumerate(tool_calls_internal):
                    yield openai_stream_chunk(
                        tool_call_chunk={
                            "index": i,
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": tc["name"], "arguments": json.dumps(tc["input"])},
                        },
                        model=model,
                    )

                yield openai_stream_chunk(finish_reason="tool_calls", model=model)

                # Execute tools + stream "thinking" updates
                tool_results_msgs = []
                for tc in tool_calls_internal:
                    yield openai_stream_chunk(
                        delta_content=f"\n[Executing: {tc['name']}...]\n", model=model
                    )
                    result = self._execute_tool(tc, project_root)
                    ok_str = "✓" if result.get("ok") else "✗"
                    preview = str(result.get("data") or result.get("error", ""))[:120]
                    yield openai_stream_chunk(
                        delta_content=f"{ok_str} {tc['name']}: {preview}\n", model=model
                    )
                    tool_results_msgs.append(
                        tool_result_to_openai_message(tc["id"], result)
                    )

                loop_messages.append(self._build_assistant_msg(response))
                loop_messages.extend(tool_results_msgs)

            yield openai_stream_chunk(delta_content="[Max iterations reached]", model=model)
            yield openai_stream_chunk(finish_reason="stop", model=model)
            yield OPENAI_STREAM_DONE

        response = StreamingHttpResponse(event_stream(), content_type="text/event-stream")
        response["Cache-Control"] = "no-cache"
        response["X-Accel-Buffering"] = "no"
        response["Access-Control-Allow-Origin"] = "*"
        return response

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _execute_tool(self, tc: dict, project_root: str) -> dict:
        tool = get_tool(tc["name"])
        if tool is None:
            logger.warning(f"[openai_compat] unknown tool: {tc['name']}")
            return {"ok": False, "error": f"Unknown tool: {tc['name']}"}
        try:
            result = tool.run(tc["input"], project_root)
            return result.to_dict()
        except Exception as exc:
            logger.exception(f"[openai_compat] tool {tc['name']} crashed")
            return {"ok": False, "error": str(exc)}

    def _build_assistant_msg(self, response: dict) -> dict:
        """Build assistant message in a format the underlying LLM accepts."""
        provider = get_setting("LLM_PROVIDER", "claude")
        if provider == "claude":
            content = []
            if response.get("content"):
                content.append({"type": "text", "text": response["content"]})
            for tc in response.get("tool_calls", []):
                content.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["input"]})
            return {"role": "assistant", "content": content}
        return {
            "role": "assistant",
            "content": response.get("content", ""),
            "tool_calls": [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": json.dumps(tc["input"])},
                }
                for tc in response.get("tool_calls", [])
            ],
        }


@method_decorator(csrf_exempt, name="dispatch")
class OpenAIModelsView(View):
    """
    GET /openai/v1/models
    Cline and other clients call this on startup to list available models.
    """

    def get(self, request):
        return JsonResponse({
            "object": "list",
            "data": [
                {
                    "id": "vibescode-agent",
                    "object": "model",
                    "created": 1700000000,
                    "owned_by": "vibescode",
                    "description": "VibesCode — agentic Django project assistant",
                    "context_window": 200000,
                },
            ],
        })
