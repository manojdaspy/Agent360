"""
=============================================================
  VibesCode Agent — Integration Guide
=============================================================

1. INSTALL
----------
pip install django djangorestframework httpx

Copy the `project_agent/` folder into your Django project root.


2. settings.py
--------------
"""

INSTALLED_APPS = [
    # ... your existing apps ...
    "rest_framework",
    "project_agent",
]

# ── VibesCode Configuration ──────────────────────────────────────────────────
VIBESCODE = {
    # Absolute path to the student project root (what gets sandboxed)
    "PROJECT_ROOT": "/home/student/myproject",

    # LLM provider: "claude" | "openai" | "ollama"
    "LLM_PROVIDER": "claude",
    "LLM_API_KEY": "sk-ant-...",          # your Anthropic key
    "LLM_MODEL": "claude-sonnet-4-20250514",
    "LLM_BASE_URL": None,                  # None = auto; set for Ollama: "http://localhost:11434"

    # File safety
    "ALLOWED_EXTENSIONS": [".py", ".html", ".js", ".css", ".txt", ".md", ".json"],
    "MAX_FILE_SIZE_KB": 500,

    # Shell access (set True to allow `python manage.py check`, pytest, etc.)
    "ENABLE_SHELL": True,
    "SHELL_TIMEOUT_SECONDS": 15,

    # API security token (set this in production!)
    "API_TOKEN": "your-secret-token-here",

    # Append extra instructions to the LLM system prompt
    "SYSTEM_PROMPT_EXTRA": "This is a Django student assignment. Be encouraging.",

    "MAX_TOKENS": 4096,
}

"""
3. urls.py
----------
from django.urls import path, include

urlpatterns = [
    ...
    path("api/agent/", include("project_agent.urls")),
]


4. MIGRATIONS
-------------
python manage.py makemigrations project_agent
python manage.py migrate


5. API USAGE
------------

### Start a chat session (high-level — LLM does everything)
POST /api/agent/chat/
Authorization: Bearer your-secret-token-here
{
    "message": "Fix the NameError in mainapp/views.py",
    "project_root": "/home/student/myproject"
}

Response:
{
    "session_id": "uuid",
    "response": "I found the issue on line 42...",
    "events": [
        {"type": "tool_call", "name": "cat", "input": {"path": "mainapp/views.py"}},
        {"type": "tool_result", "name": "cat", "result": {"ok": true, "data": "..."}},
        {"type": "tool_call", "name": "patch", ...},
        {"type": "tool_result", ...},
        {"type": "llm_response", "content": "Fixed! The variable `name` was..."},
        {"type": "done", "iterations": 3}
    ]
}

### Continue conversation
POST /api/agent/chat/
{"message": "Now check if there are any other errors", "session_id": "uuid"}

### Direct tool access (the LLM uses these internally, but you can too)
GET  /api/agent/cmd/?op=dir&path=mainapp/
GET  /api/agent/cmd/?op=cat&path=mainapp/views.py
GET  /api/agent/cmd/?op=search&path=.&pattern=NameError&extensions=.py
GET  /api/agent/cmd/?op=tree&path=.
POST /api/agent/cmd/    {"op": "shell", "cmd": "python manage.py check"}
POST /api/agent/cmd/    {"op": "patch", "path": "mainapp/views.py", "old_str": "...", "new_str": "..."}

### Session history (all tool calls, file changes, messages)
GET /api/agent/sessions/<uuid>/
DEL /api/agent/sessions/<uuid>/


6. LLM SYSTEM PROMPT (pre-built into llm_client.py)
-----------------------------------------------------
The LLM knows:
- It must read files before suggesting fixes
- Use `search` to find undefined variables
- Use `patch` for surgical edits (safer than full rewrite)
- Run `python manage.py check` to verify fixes
- Explain everything in student-friendly language


7. ADDING NEW TOOLS
-------------------
1. Create a class in project_agent/tools/your_tool.py inheriting BaseTool
2. Set name, description, input_schema
3. Implement run(params, project_root) -> ToolResult
4. Import it in project_agent/tools/registry.py and add to _ALL_TOOL_CLASSES

That's it. The LLM will automatically see the new tool in its system prompt.


8. MULTI-STUDENT / MULTI-PROJECT
---------------------------------
Pass a different project_root per chat session:
POST /api/agent/chat/
{
    "message": "Fix my project",
    "project_root": "/home/students/student_42/assignment3",
    "meta": {"student_id": 42, "course": "CS101"}
}

Each session is fully isolated. meta is stored for your records.
"""
