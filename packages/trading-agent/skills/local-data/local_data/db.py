"""Shared SQLite database utilities for the local-data skill.

All local-data scripts read/write the same market database at
``~/.trading-agent/data/market.db``. This module centralises the path,
connection helper, and any common schema constants so that individual
sync/compute scripts do not duplicate them.
"""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Generator


def get_db_path() -> str:
    """Return the canonical path to the local market SQLite database."""
    return os.path.expanduser("~/.trading-agent/data/market.db")


def ensure_data_dir() -> None:
    """Create the parent data directory if it does not exist."""
    Path(get_db_path()).parent.mkdir(parents=True, exist_ok=True)


def get_db() -> sqlite3.Connection:
    """Open and return a connection to the local market database.

    The connection is configured with row factories and a 30-second busy
    timeout so that concurrent sync jobs do not immediately fail.
    """
    ensure_data_dir()
    conn = sqlite3.connect(get_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


@contextmanager
def db_cursor() -> Generator[sqlite3.Cursor, None, None]:
    """Context manager yielding a cursor with automatic commit/rollback/close.

    Usage:
        with db_cursor() as cur:
            cur.execute("INSERT ...")
    """
    conn = get_db()
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@contextmanager
def db_connection() -> Generator[sqlite3.Connection, None, None]:
    """Context manager yielding a connection with automatic close.

    Usage:
        with db_connection() as conn:
            conn.execute("SELECT ...")
    """
    conn = get_db()
    try:
        yield conn
    finally:
        conn.close()


def db_exists() -> bool:
    """Return True if the local market database file exists."""
    return os.path.exists(get_db_path())
