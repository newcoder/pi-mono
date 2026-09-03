"""Unit tests for local_data.market — guards the shared market-code contract.

These functions are consumed across all sync scripts (fundamentals, klines,
quotes...). A semantics regression here silently breaks data ingestion
(e.g. market_prefix returning the full symbol instead of a bare prefix once
caused all fundamentals syncs to be skipped), so their contract is pinned here.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from local_data.market import (
    is_a_share,
    market_from_code,
    market_label,
    market_prefix,
)


def test_market_from_code():
    assert market_from_code("600519") == 1  # Shanghai main
    assert market_from_code("688001") == 1  # STAR
    assert market_from_code("000001") == 0  # Shenzhen main
    assert market_from_code("300750") == 0  # ChiNext
    assert market_from_code("430047") == 2  # Beijing
    assert market_from_code("830001") == 2  # Beijing
    assert market_from_code("920001") == 2  # Beijing (92 prefix)
    assert market_from_code("123456") is None  # unassigned range
    assert market_from_code("abc") is None
    assert market_from_code("") is None


def test_market_label():
    assert market_label("600519") == "SH"
    assert market_label("000001") == "SZ"
    assert market_label("430047") == "BJ"
    assert market_label("123456") is None


def test_market_prefix_contract():
    """market_prefix returns the FULL prefixed symbol, never a bare label."""
    assert market_prefix("600519", "lower") == "sh600519"
    assert market_prefix("600519", "upper") == "SH600519"
    assert market_prefix("600519", "dotted") == "600519.SH"
    assert market_prefix("000001", "lower") == "sz000001"
    assert market_prefix("430047", "lower") == "bj430047"
    assert market_prefix("123456") is None


def test_market_prefix_no_code_duplication():
    """Regression: callers must not re-append the code to market_prefix's result."""
    for code in ("600519", "000001", "430047"):
        sym = market_prefix(code, "lower")
        assert sym is not None and not sym.endswith(code + code)
        assert sym.count(code) == 1


def test_is_a_share():
    assert is_a_share("600519")
    assert is_a_share("000001")
    assert is_a_share("300750")
    assert is_a_share("688001")
    assert is_a_share("430047")
    assert not is_a_share("200001")  # SZ B-share
    assert not is_a_share("900901")  # SH B-share
    assert not is_a_share("880001")  # sector index
    assert not is_a_share("510300")  # ETF
    assert not is_a_share("123456")  # unassigned
    assert not is_a_share("abc123")
    assert not is_a_share("60051")  # too short
