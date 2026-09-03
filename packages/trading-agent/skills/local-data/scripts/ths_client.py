"""Tonghuashun (THS) anti-bot cookie generation without akshare/py_mini_racer.

THS pages require a `v` cookie computed by ths.js. akshare runs it through
py_mini_racer; we run the same script through node (available on this system)
and talk to the THS endpoints directly with requests.
"""

import logging
import os
import subprocess
import sys
import time

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_THS_JS = os.path.join(_SCRIPT_DIR, "ths.js")

# Avoid unstable local HTTP proxies breaking requests to THS.
for _proxy_key in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(_proxy_key, None)
os.environ.setdefault("NO_PROXY", "*")

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "http://q.10jqka.com.cn/thshy/",
}

_session = requests.Session()

_cookie_cache: dict = {"v": None, "ts": 0.0}


def get_hexin_v() -> str:
    """Generate the hexin-v cookie by executing ths.js with node (cached 25 min)."""
    now = time.time()
    if _cookie_cache["v"] and now - _cookie_cache["ts"] < 25 * 60:
        return _cookie_cache["v"]
    if not os.path.exists(_THS_JS):
        raise RuntimeError(f"ths.js not found at {_THS_JS} (required for THS cookie generation)")
    script = (
        'const fs=require("fs");const vm=require("vm");'
        f'const code=fs.readFileSync({_THS_JS!r},"utf8");'
        'const sandbox={};vm.createContext(sandbox);'
        'vm.runInContext(code+";this.__v=v();",sandbox);console.log(sandbox.__v);'
    )
    proc = subprocess.run(["node", "-e", script], capture_output=True, text=True, timeout=15)
    if proc.returncode != 0:
        raise RuntimeError(f"node ths.js failed: {proc.stderr[:200]}")
    v = proc.stdout.strip()
    if not v:
        raise RuntimeError("ths.js produced an empty cookie")
    _cookie_cache["v"] = v
    _cookie_cache["ts"] = now
    return v


def get_ths_headers() -> dict:
    headers = dict(_HEADERS)
    headers["Cookie"] = f"v={get_hexin_v()}"
    return headers


def fetch_industry_list() -> list:
    """Fetch the 90 THS industry blocks (code, name) from the board index page."""
    url = "https://q.10jqka.com.cn/thshy/detail/code/881272/"
    r = _session.get(url, headers=get_ths_headers(), timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, features="lxml")
    links = soup.find("div", attrs={"class": "cate_inner"})
    if not links:
        return []
    result = []
    for a in links.find_all("a"):
        code = a["href"].split("/")[-2]
        name = a.text.strip()
        if code and name:
            result.append({"code": code, "name": name})
    return result


def fetch_board_index_klines(industry_code: str, start_date: str = "20200101", end_date: str = "20990101") -> list:
    """Fetch THS board index daily klines from d.10jqka.com.cn (one file per year).

    Returns rows: {date, open, high, low, close, volume, amount}. Row format from
    the upstream JS payload: date,open,high,low,close,volume,amount,... (11 fields).
    """
    import json

    from datetime import datetime

    rows = []
    begin_year = int(start_date[:4])
    current_year = min(datetime.now().year, int(end_date[:4]))
    headers = {
        "User-Agent": _HEADERS["User-Agent"],
        "Referer": "http://q.10jqka.com.cn",
        "Host": "d.10jqka.com.cn",
        "Cookie": f"v={get_hexin_v()}",
    }
    for year in range(begin_year, current_year + 1):
        url = f"https://d.10jqka.com.cn/v4/line/bk_{industry_code}/01/{year}.js"
        try:
            r = _session.get(url, headers=headers, timeout=15)
            text = r.text
            start = text.find("{")
            end = text.rfind("}")
            if start < 0 or end <= start:
                continue
            payload = json.loads(text[start : end + 1])
            data = payload.get("data", "")
            for line in str(data).split(";"):
                parts = line.split(",")
                if len(parts) < 7:
                    continue
                raw_date = parts[0]
                # start/end arrive as YYYYMMDD; compare in that space first
                if raw_date < start_date or raw_date > end_date:
                    continue
                # THS board index dates come as YYYYMMDD; normalize to YYYY-MM-DD
                # so they match the rest of the klines tables.
                date_str = raw_date
                if len(raw_date) == 8 and raw_date.isdigit():
                    date_str = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:8]}"
                rows.append({
                    "date": date_str,
                    "open": _num(parts[1]),
                    "high": _num(parts[2]),
                    "low": _num(parts[3]),
                    "close": _num(parts[4]),
                    "volume": _num(parts[5]),
                    "amount": _num(parts[6]),
                })
        except Exception as e:
            logger.warning(f"THS board index kline error for {industry_code} {year}: {e}")
            continue
    rows.sort(key=lambda r: r["date"])
    return rows


def _num(v) -> float | None:
    try:
        f = float(v)
        return f
    except (TypeError, ValueError):
        return None


def fetch_board_stocks(industry_code: str, max_pages: int = 100) -> list:
    """Paginate a THS board detail page for member stocks."""
    stocks = []
    for page in range(1, max_pages + 1):
        url = f"http://q.10jqka.com.cn/thshy/detail/code/{industry_code}/order/desc/page/{page}"
        try:
            r = _session.get(url, headers=get_ths_headers(), timeout=15)
            if r.status_code != 200:
                logger.warning(f"THS page {page} for {industry_code} status {r.status_code}")
                break
            text = r.content.decode("gb18030", errors="ignore")
            soup = BeautifulSoup(text, "lxml")
            table = soup.find("table", class_="m-table")
            if not table:
                break
            rows = table.find_all("tr")[1:]  # skip header
            if not rows:
                break
            for row in rows:
                cells = row.find_all("td")
                if len(cells) >= 3:
                    stock_code = cells[1].text.strip()
                    stock_name = cells[2].text.strip()
                    if stock_code and stock_code.isdigit():
                        stocks.append({"code": stock_code, "name": stock_name})
            if len(rows) < 20:  # last page
                break
            time.sleep(0.15)
        except Exception as e:
            logger.warning(f"THS board fetch error for {industry_code} page {page}: {e}")
            break
    return stocks
