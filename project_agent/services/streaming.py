"""
project_agent/services/streaming.py
Server-Sent Events (SSE) streaming for the agent loop.
The client receives events in real time as the LLM thinks and calls tools.

Protocol:
  event: llm_response  → LLM text chunk
  event: tool_call     → tool about to execute
  event: tool_result   → tool output
  event: error         → something failed
  event: done          → loop finished, stream closes

Usage:
  GET /api/agent/chat/stream/?session_id=<uuid>&message=<text>
  Accept: text/event-stream

Client JS example:
  const es = new EventSource('/api/agent/chat/stream/?message=Fix+my+bug&session_id=xxx');
  es.addEventListener('llm_response', e => console.log(JSON.parse(e.data)));
  es.addEventListener('done', () => es.close());
"""
from __future__ import annotations
import json
import logging
from django.http import StreamingHttpResponse
from .agent import AgentLoop
from .session import SessionService
from ..models import AgentSession
from ..config import get_setting

logger = logging.getLogger("vibescode.streaming")


def _sse_event(event: str, data: dict) -> str:
    """Format a Server-Sent Event frame."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def agent_sse_stream(session: AgentSession, user_message: str):
    """
    Generator that runs the agentic loop and yields SSE frames.
    Designed to be passed directly to StreamingHttpResponse.
    """
    SessionService.save_user_message(session, user_message)
    history = SessionService.get_history(session)
    loop = AgentLoop(project_root=session.project_root)

    final_text_parts = []
    last_tool_call_event = None

    try:
        yield _sse_event("start", {"session_id": str(session.id)})

        for event in loop.run(history):
            event_type = event["type"]

            if event_type == "llm_response":
                final_text_parts.append(event["content"])
                yield _sse_event("llm_response", {"content": event["content"]})

            elif event_type == "tool_call":
                last_tool_call_event = event
                yield _sse_event("tool_call", {
                    "name": event["name"],
                    "input": event["input"],
                })

            elif event_type == "tool_result":
                # Persist to DB
                SessionService.save_tool_call(
                    session=session,
                    message=SessionService.save_user_message.__func__,  # placeholder
                    operation=event["name"],
                    params=last_tool_call_event.get("input", {}) if last_tool_call_event else {},
                    result=event["result"],
                    duration_ms=event["result"].get("duration_ms", 0),
                )
                yield _sse_event("tool_result", {
                    "name": event["name"],
                    "ok": event["result"].get("ok"),
                    "preview": str(event["result"].get("data", event["result"].get("error", "")))[:300],
                })

            elif event_type == "error":
                yield _sse_event("error", {"message": event["message"]})

            elif event_type == "done":
                # Save final assistant message
                SessionService.save_assistant_message(session, "\n".join(final_text_parts), [])
                yield _sse_event("done", {
                    "iterations": event.get("iterations", 0),
                    "session_id": str(session.id),
                })
                return

    except Exception as exc:
        logger.exception("SSE stream error")
        yield _sse_event("error", {"message": str(exc)})
    finally:
        yield _sse_event("stream_end", {})
