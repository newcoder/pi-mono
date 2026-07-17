"""Canonical A-share market code utilities."""

from typing import Optional

MARKET_SZ = 0
MARKET_SH = 1
MARKET_BJ = 2


def market_from_code(code: str) -> Optional[int]:
    """Infer market from a 6-digit A-share code.

    Returns:
        0 = Shenzhen (SZ)
        1 = Shanghai (SH)
        2 = Beijing (BJ)
        None = invalid or unsupported code
    """
    if not code or len(code) != 6 or not code.isdigit():
        return None
    # Beijing Stock Exchange: 8xxxxx, 4xxxxx, 92xxxx
    if code.startswith(("8", "4", "92")):
        return MARKET_BJ
    # Shanghai: 600/601/602/603/605 (main), 688/689 (STAR), 900 (B-share legacy)
    if code.startswith(("600", "601", "602", "603", "605", "688", "689", "900")):
        return MARKET_SH
    # Shenzhen: 000/001/002/003 (main), 300/301 (ChiNext), 200 (B-share legacy)
    if code.startswith(("000", "001", "002", "003", "300", "301", "200")):
        return MARKET_SZ
    return None


def market_label(code: str) -> Optional[str]:
    """Return short market label: "SH", "SZ", or "BJ"."""
    market = market_from_code(code)
    if market is None:
        return None
    return {MARKET_SZ: "SZ", MARKET_SH: "SH", MARKET_BJ: "BJ"}[market]


def market_prefix(code: str, style: str = "lower") -> Optional[str]:
    """Return prefixed symbol for the given style.

    Styles:
        "lower"  -> sh600519 / sz000001 / bj430047
        "upper"  -> SH600519 / SZ000001 / BJ430047
        "dotted" -> 600519.SH / 000001.SZ / 430047.BJ
    """
    label = market_label(code)
    if label is None:
        return None
    if style == "lower":
        return label.lower() + code
    if style == "upper":
        return label + code
    if style == "dotted":
        return code + "." + label
    raise ValueError(f"Unknown style: {style}")
