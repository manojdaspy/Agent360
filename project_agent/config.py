"""
project_agent/config.py
Read settings from Django's VIBESCODE dict with safe defaults.
"""
from django.conf import settings

DEFAULTS = {
    "PROJECT_ROOT": None,          # must be set
    "LLM_PROVIDER": "claude",      # claude | openai | ollama
    "LLM_API_KEY": "",
    "LLM_MODEL": "claude-sonnet-4-20250514",
    "LLM_BASE_URL": None,          # for Ollama or custom endpoints
    "ALLOWED_EXTENSIONS": [".py", ".html", ".js", ".css", ".txt", ".md", ".json", ".yaml", ".toml", ".env.example"],
    "MAX_FILE_SIZE_KB": 500,
    "ENABLE_SHELL": False,
    "SHELL_TIMEOUT_SECONDS": 10,
    "MAX_TOKENS": 4096,
    "SYSTEM_PROMPT_EXTRA": "",     # append custom instructions
}


def get_setting(key: str, default=None):
    cfg = getattr(settings, "VIBESCODE", {})
    return cfg.get(key, DEFAULTS.get(key, default))
