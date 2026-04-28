#!/usr/bin/env python3
"""获取隔夜全球宏观市场数据"""
import argparse
import json
import requests
from datetime import datetime, timedelta

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://quote.eastmoney.com/",
}


def get_us_indices():
    """获取美股三大指数最新数据"""
    # 使用东方财富 API
    indices = {
        "SPX": {"code": "100.SPX", "name": "标普500"},
        "NDX": {"code": "100.NDX", "name": "纳斯达克100"},
        "DJI": {"code": "100.DJI", "name": "道琼斯"},
    }
    
    results = {}
    for key, info in indices.items():
        try:
            url = f"https://push2.eastmoney.com/api/qt/stock/get?secid={info['code']}&fields=f43,f170,f60"
            r = requests.get(url, headers=HEADERS, timeout=10)
            data = r.json()
            if data.get("data"):
                d = data["data"]
                latest = d.get("f43")
                change_pct = d.get("f170")
                prev_close = d.get("f60")
                results[key] = {
                    "name": info["name"],
                    "latest": latest,
                    "change_pct": change_pct,
                    "prev_close": prev_close,
                }
        except Exception as e:
            results[key] = {"error": str(e)}
    
    return results


def get_a50_futures():
    """获取富时A50期货数据"""
    try:
        # 尝试使用新浪期货 API
        url = "https://hq.sinajs.cn/list=CN0"
        r = requests.get(url, headers={"Referer": "https://finance.sina.com.cn"}, timeout=10)
        # 解析返回数据（GBK编码）
        r.encoding = "gbk"
        data = r.text
        # 格式: var hq_str_CN0="富时A50,xxx,..."
        if "hq_str_CN0=" in data:
            parts = data.split('"')[1].split(",")
            if len(parts) >= 9:
                return {
                    "name": "富时A50期货",
                    "latest": float(parts[2]),
                    "change": float(parts[3]),
                    "change_pct": float(parts[4]) if parts[4] else 0,
                }
    except Exception as e:
        return {"error": str(e)}
    return {"error": "无法获取A50数据"}


def get_fx_rate():
    """获取美元兑人民币汇率"""
    try:
        url = "https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43,f170"
        r = requests.get(url, headers=HEADERS, timeout=10)
        data = r.json()
        if data.get("data"):
            d = data["data"]
            return {
                "name": "美元兑离岸人民币",
                "latest": d.get("f43"),
                "change_pct": d.get("f170"),
            }
    except Exception as e:
        return {"error": str(e)}
    return {"error": "无法获取汇率数据"}


def main():
    parser = argparse.ArgumentParser(description="获取隔夜全球宏观市场数据")
    parser.add_argument("--output", default="-", help="输出文件，默认 stdout")
    args = parser.parse_args()
    
    result = {
        "timestamp": datetime.now().isoformat(),
        "us_markets": get_us_indices(),
        "a50_futures": get_a50_futures(),
        "fx": get_fx_rate(),
    }
    
    output = json.dumps(result, ensure_ascii=False, indent=2)
    
    if args.output == "-":
        print(output)
    else:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output)


if __name__ == "__main__":
    main()
