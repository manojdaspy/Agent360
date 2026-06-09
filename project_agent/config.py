"""
project_agent/config.py
Read settings from Django's VIBESCODE dict with safe defaults.
"""
from __future__ import annotations
from pathlib import Path
from django.conf import settings


# ── Project root auto-detection ───────────────────────────────────────────────

def _default_project_root() -> str:
    """
    Walk up from this file (project_agent/config.py) until we find manage.py.
    That directory is the Django project root.
    Falls back to cwd if manage.py isn't found (e.g. during unit tests).
    """
    here = Path(__file__).resolve().parent
    for directory in [here, *here.parents]:
        if (directory / "manage.py").exists():
            return str(directory)
    import os
    return os.getcwd()


# ── Defaults ──────────────────────────────────────────────────────────────────

DEFAULTS: dict = {
    "PROJECT_ROOT": None,           # resolved lazily in get_setting()
    "LLM_PROVIDER": "claude",
    "LLM_API_KEY": "",
    "LLM_MODEL": "claude-sonnet-4-20250514",
    "LLM_BASE_URL": None,
    "ALLOWED_EXTENSIONS": [
        ".py", ".html", ".js", ".css", ".txt", ".md",
        ".json", ".yaml", ".toml", ".env.example",
    ],
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


# ── Accessor ──────────────────────────────────────────────────────────────────

def get_setting(key: str, default=None):
    """
    Look up a VibesCode setting.

    Priority:  settings.VIBESCODE[key]  >  DEFAULTS[key]  >  default arg

    Special case: PROJECT_ROOT
      If not explicitly set, auto-detected by walking up to manage.py.
      An empty string is treated the same as None (not set).
    """
    cfg = getattr(settings, "VIBESCODE", {})
    value = cfg.get(key, DEFAULTS.get(key, default))

    if key == "PROJECT_ROOT":
        if not value:                       # None or ""
            value = _default_project_root()
        # Resolve to absolute, normalise separators (handles Windows paths too)
        value = str(Path(value).resolve())

    return value