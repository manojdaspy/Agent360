"""
project_agent/config.py
Read settings from Django's VIBESCODE dict with safe defaults.
"""
from django.conf import settings

DEFAULTS = {
    "PROJECT_ROOT": None,
    "LLM_PROVIDER": "claude",
    "LLM_API_KEY": "",
    "LLM_MODEL": "claude-sonnet-4-20250514",
    "LLM_BASE_URL": None,
    "ALLOWED_EXTENSIONS": [".py", ".html", ".js", ".css", ".txt", ".md", ".json", ".yaml", ".toml", ".env.example"],
    "MAX_FILE_SIZE_KB": 500,
    "ENABLE_SHELL": False,
    "SHELL_TIMEOUT_SECONDS": 10,
    "MAX_TOKENS": 4096,
    "SYSTEM_PROMPT_EXTRA": "",

    # ── Ignored dirs — LLM only sees human-written code ──────────────────────
    "IGNORE_DIRS": [
        # Python artifacts
        "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
        "*.egg-info", "dist", "build", "eggs", "sdist",
        # Virtual environments
        "venv", ".venv", "env", "virtualenv", ".virtualenv", "Env", "ENV",
        # Node / frontend
        "node_modules", ".next", ".nuxt", ".output", "bower_components",
        ".parcel-cache", ".cache",
        # Version control
        ".git", ".hg", ".svn",
        # IDE / editor
        ".idea", ".vscode", ".eclipse",
        # Django collected files (not source)
        "staticfiles", "collected_static", "media",
        # OS / misc
        ".DS_Store", "__MACOSX", "logs", "tmp", "temp",
    ],

    # ── Ignored files — skip binary, lock, secret files ──────────────────────
    "IGNORE_FILES": [
        "*.pyc", "*.pyo", "*.pyd", "*.so", "*.dll", "*.exe",
        "package-lock.json", "yarn.lock", "poetry.lock", "Pipfile.lock",
        ".env", ".env.local", ".env.production",
        ".DS_Store", "Thumbs.db",
        ".coverage", "coverage.xml",
    ],
}


def get_setting(key: str, default=None):
    cfg = getattr(settings, "VIBESCODE", {})
    return cfg.get(key, DEFAULTS.get(key, default))