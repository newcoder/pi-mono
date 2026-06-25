#!/usr/bin/env python3
"""Sync concept_stocks from Tonghuashun (同花顺) concept blocks.

Data source: 同花顺概念板块 (http://q.10jqka.com.cn/gn/)
- Fetches the concept section list (platecode + name + cid) from the main page.
- For each concept, fetches constituent stocks via the blockrank JSONP API.
- Writes results to the local SQLite market.db concept_stocks table.

This avoids the blocked Eastmoney HTTP APIs and does not require JoinQuant.
"""
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from typing import Any

import requests

DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")
CONCEPT_PAGE_URL = "http://q.10jqka.com.cn/gn/"
BLOCKRANK_URL_TEMPLATE = "https://d.10jqka.com.cn/v2/blockrank/{platecode}/199112/d1000.js"

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "http://q.10jqka.com.cn",
    "Accept": "*/*",
}

_FETCH_TIMEOUT = 20
_SLEEP_BETWEEN_REQUESTS = 0.25


def _log(msg: str) -> None:
    """Log to stderr so stdout stays clean for JSON output."""
    print(msg, file=sys.stderr)


def fetch_concept_list(session: requests.Session) -> list[dict[str, Any]]:
    """Fetch all Tonghuashun concept blocks from the main concept page.

    Returns list of dicts with keys: platecode, platename, cid, ...
    """
    r = session.get(CONCEPT_PAGE_URL, headers=_HEADERS, timeout=_FETCH_TIMEOUT)
    r.encoding = "gbk"
    html = r.text

    m = re.search(r'id="gnSection" value=\'([^\']+)\'', html)
    if not m:
        raise RuntimeError("Could not find gnSection data on concept page")

    data = json.loads(m.group(1))
    concepts = []
    for section_id, items in data.items():
        if isinstance(items, list):
            concepts.extend(items)
        elif isinstance(items, dict):
            concepts.append(items)

    # Deduplicate by platecode
    seen = set()
    unique = []
    for c in concepts:
        pc = c.get("platecode")
        if pc and pc not in seen:
            seen.add(pc)
            unique.append(c)

    return unique


def fetch_concept_stocks(session: requests.Session, platecode: str) -> list[dict[str, str]]:
    """Fetch constituent stocks for a single concept block.

    Returns list of {"code": str, "name": str}.
    """
    url = BLOCKRANK_URL_TEMPLATE.format(platecode=platecode)
    r = session.get(url, headers=_HEADERS, timeout=_FETCH_TIMEOUT)
    r.encoding = "utf-8"
    text = r.text.strip()

    # Response is JSONP: quotebridge_v2_blockrank_xxx_199112_d1000({...})
    if not text or "(" not in text:
        return []

    json_str = text[text.find("(") + 1 : text.rfind(")")]
    data = json.loads(json_str)

    stocks = []
    for item in data.get("items", []):
        code = item.get("5")
        name = item.get("55")
        if code:
            stocks.append({"code": str(code).zfill(6), "name": name or ""})

    return stocks


def sync_all_concepts() -> dict[str, Any]:
    """Sync all Tonghuashun concepts into concept_stocks."""
    session = requests.Session()
    session.headers.update(_HEADERS)

    concepts = fetch_concept_list(session)
    _log(f"[sync_concept_stocks_ths] Fetched {len(concepts)} concepts from page")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    # Ensure table exists
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS concept_stocks (
            concept TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT,
            updated_at TEXT,
            PRIMARY KEY (concept, code)
        )
        """
    )

    # Clear old data for a full refresh
    cur.execute("DELETE FROM concept_stocks")
    conn.commit()

    now = datetime.now().isoformat()
    total_stocks = 0
    error_concepts = []

    for i, concept in enumerate(concepts, 1):
        platecode = concept.get("platecode", "")
        concept_name = concept.get("platename", "")
        if not platecode or not concept_name:
            continue

        if i % 50 == 0 or i == len(concepts):
            _log(
                f"[sync_concept_stocks_ths] Progress {i}/{len(concepts)}: "
                f"{total_stocks} stocks synced, {len(error_concepts)} errors"
            )

        try:
            stocks = fetch_concept_stocks(session, platecode)
            for stock in stocks:
                cur.execute(
                    "INSERT OR REPLACE INTO concept_stocks (concept, code, name, updated_at) VALUES (?, ?, ?, ?)",
                    (concept_name, stock["code"], stock["name"], now),
                )
            total_stocks += len(stocks)
        except Exception as e:
            err_msg = f"{concept_name} ({platecode}): {type(e).__name__}: {e}"
            error_concepts.append(err_msg)
            _log(f"[sync_concept_stocks_ths] ERROR {err_msg}")

        time.sleep(_SLEEP_BETWEEN_REQUESTS)

    conn.commit()

    # Summary stats
    row = cur.execute(
        "SELECT COUNT(DISTINCT concept) AS concept_count, COUNT(*) AS total FROM concept_stocks"
    ).fetchone()
    conn.close()

    result = {
        "source": "tonghuashun",
        "total_concepts": len(concepts),
        "concepts_with_stocks": row["concept_count"],
        "total_stocks": row["total"],
        "errors": len(error_concepts),
        "error_details": error_concepts[:10],
    }

    _log(
        f"[sync_concept_stocks_ths] Done. {result['concepts_with_stocks']} concepts, "
        f"{result['total_stocks']} mappings, {result['errors']} errors."
    )
    print(json.dumps(result, ensure_ascii=False))
    return result


def main() -> None:
    sync_all_concepts()


if __name__ == "__main__":
    main()
