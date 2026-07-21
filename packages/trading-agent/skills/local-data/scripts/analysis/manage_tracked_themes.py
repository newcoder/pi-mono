#!/usr/bin/env python3
"""
Layer 2 manual curation CLI for concept themes.
Usage:
  python manage_tracked_themes.py list-survivors [--min-rank 60]
  python manage_tracked_themes.py list-themes
  python manage_tracked_themes.py tag "存储芯片" "半导体" --primary
  python manage_tracked_themes.py exclude "PPP概念" --reason "infra tag, no theme value"
  python manage_tracked_themes.py export
"""
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_ROOT = os.path.dirname(_SCRIPT_DIR)
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)
if _SKILL_ROOT not in sys.path:
    sys.path.insert(0, _SKILL_ROOT)

import argparse
import sqlite3
import json
from local_data.db import get_db
from datetime import datetime
from typing import Dict, List, Optional


def ensure_tables(conn: sqlite3.Connection):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tracked_themes (
            concept TEXT NOT NULL,
            master_theme TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'tracked',
            notes TEXT,
            updated_at TEXT,
            PRIMARY KEY (concept)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tracked_themes_master ON tracked_themes(master_theme)")
    conn.commit()


def list_survivors(conn: sqlite3.Connection, min_rank: int = 0):
    sql = """
        SELECT rank, concept, constituent_count, dispersion, max_benchmark_correlation, rank_score
        FROM concept_filter_results
        WHERE size_pass = 1 AND dispersion_pass = 1 AND independence_pass = 1
    """
    params = []
    if min_rank > 0:
        sql += " AND rank <= ?"
        params.append(min_rank)
    sql += " ORDER BY rank"
    rows = conn.execute(sql, params).fetchall()
    tagged = set(r[0] for r in conn.execute("SELECT concept FROM tracked_themes").fetchall())

    print(f"{'Rank':<5} {'Concept':<20} {'Size':<6} {'Disp':<8} {'Corr':<8} {'Score':<8} {'Status'}")
    print("-" * 80)
    for r in rows:
        rank, concept, size, disp, corr, score = r
        status = "tagged" if concept in tagged else ""
        print(f"{rank:<5} {concept:<20} {size or '-':<6} {disp or 0:.4f}  {corr or 0:.3f}  {score or 0:<8.3f} {status}")


def tag_concept(conn: sqlite3.Connection, concept: str, master_theme: str, primary: bool = False, notes: str = ""):
    now = datetime.now().isoformat()
    existing = conn.execute("SELECT status FROM tracked_themes WHERE master_theme = ? AND status = 'tracked'",
                            (master_theme,)).fetchone()
    status = "tracked" if primary or not existing else "merged"

    conn.execute(
        """INSERT OR REPLACE INTO tracked_themes (concept, master_theme, status, notes, updated_at)
           VALUES (?, ?, ?, ?, ?)""",
        (concept, master_theme, status, notes, now),
    )
    # If this is primary, demote other primary in same theme
    if primary and existing:
        conn.execute(
            "UPDATE tracked_themes SET status = 'merged', updated_at = ? WHERE master_theme = ? AND concept != ?",
            (now, master_theme, concept),
        )
    conn.commit()
    print(f"Tagged '{concept}' -> '{master_theme}' (status={status})")


def exclude_concept(conn: sqlite3.Connection, concept: str, reason: str = ""):
    now = datetime.now().isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO tracked_themes (concept, master_theme, status, notes, updated_at) VALUES (?, ?, ?, ?, ?)",
        (concept, "excluded", "excluded", reason, now),
    )
    conn.commit()
    print(f"Excluded '{concept}': {reason}")


def set_primary(conn: sqlite3.Connection, concept: str):
    now = datetime.now().isoformat()
    row = conn.execute("SELECT master_theme FROM tracked_themes WHERE concept = ?", (concept,)).fetchone()
    if not row:
        print(f"'{concept}' not found in tracked_themes")
        return
    theme = row[0]
    conn.execute("UPDATE tracked_themes SET status = 'merged', updated_at = ? WHERE master_theme = ?", (now, theme))
    conn.execute("UPDATE tracked_themes SET status = 'tracked', updated_at = ? WHERE concept = ?", (now, concept))
    conn.commit()
    print(f"'{concept}' set as primary for theme '{theme}'")


def list_themes(conn: sqlite3.Connection):
    rows = conn.execute(
        "SELECT master_theme, concept, status, notes FROM tracked_themes ORDER BY master_theme, status, concept"
    ).fetchall()

    current_theme = None
    for theme, concept, status, notes in rows:
        if theme != current_theme:
            if current_theme is not None:
                print()
            print(f"[{theme}]")
            current_theme = theme
        marker = {"tracked": "*", "merged": " ", "excluded": "x"}.get(status, "?")
        note_str = f" -- {notes}" if notes else ""
        print(f"  {marker} {concept} ({status}){note_str}")


def export_tracked(conn: sqlite3.Connection):
    rows = conn.execute(
        "SELECT concept, master_theme FROM tracked_themes WHERE status = 'tracked' ORDER BY master_theme, concept"
    ).fetchall()
    result = [{"concept": r[0], "master_theme": r[1]} for r in rows]
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description="Concept theme curation CLI")
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("list-survivors", help="List concepts passing Layer 1 filter").add_argument(
        "--min-rank", type=int, default=0
    )
    sub.add_parser("list-themes", help="List all tagged themes")

    p_tag = sub.add_parser("tag", help="Tag a concept to a master theme")
    p_tag.add_argument("concept")
    p_tag.add_argument("master_theme")
    p_tag.add_argument("--primary", action="store_true")
    p_tag.add_argument("--notes", default="")

    p_excl = sub.add_parser("exclude", help="Exclude a concept")
    p_excl.add_argument("concept")
    p_excl.add_argument("--reason", default="")

    p_set = sub.add_parser("set-primary", help="Set a concept as primary for its theme")
    p_set.add_argument("concept")

    sub.add_parser("export", help="Export tracked concepts as JSON")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    conn = get_db()
    try:
        ensure_tables(conn)
        if args.command == "list-survivors":
            list_survivors(conn, getattr(args, "min_rank", 0))
        elif args.command == "list-themes":
            list_themes(conn)
        elif args.command == "tag":
            tag_concept(conn, args.concept, args.master_theme, args.primary, args.notes)
        elif args.command == "exclude":
            exclude_concept(conn, args.concept, args.reason)
        elif args.command == "set-primary":
            set_primary(conn, args.concept)
        elif args.command == "export":
            export_tracked(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
