"""Shared environment setup for local-data scripts.

Centralises:
- sys.path insertion so scripts can import local_data and sibling modules
- proxy environment cleanup for unstable local HTTP proxies
- stdout UTF-8 encoding for Windows consoles
"""

import io
import os
import sys


def setup_sys_path() -> None:
    """Insert script directory and skill root into sys.path."""
    script_dir = os.path.dirname(os.path.abspath(sys.argv[0]))
    skill_root = os.path.dirname(script_dir)
    for path in (script_dir, skill_root):
        if path not in sys.path:
            sys.path.insert(0, path)


def clear_proxy_env() -> None:
    """Remove unstable local HTTP proxy variables."""
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        os.environ.pop(key, None)
    os.environ.setdefault("NO_PROXY", "*")


def setup_stdout_encoding() -> None:
    """Force stdout to UTF-8 so Chinese output does not garble on Windows."""
    try:
        if getattr(sys.stdout, "encoding", "").lower() == "utf-8":
            return
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    except (ValueError, AttributeError):
        pass


def init_script_env() -> None:
    """One-call setup for local-data scripts."""
    setup_sys_path()
    clear_proxy_env()
    setup_stdout_encoding()
