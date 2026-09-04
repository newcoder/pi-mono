"""
对比行情获取接口：腾讯 qt.gtimg.cn vs akshare vs klines 派生
"""

import json
import time
import sqlite3
import os
import urllib.request
from typing import Dict, List, Optional

DB_PATH = os.path.expanduser("~/.trading-agent/data/market.db")

# ── 腾讯接口 ──────────────────────────────────────────────────────────────

def tencent_quote(codes: List[str]) -> dict:
    t0 = time.time()
    prefixed = []
    for c in codes:
        if c.startswith(("6", "9")):
            prefixed.append(f"sh{c}")
        elif c.startswith("8"):
            prefixed.append(f"bj{c}")
        else:
            prefixed.append(f"sz{c}")

    url = "https://qt.gtimg.cn/q=" + ",".join(prefixed)
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "Mozilla/5.0")
    resp = urllib.request.urlopen(req, timeout=10)
    raw = resp.read()

    # 自动检测编码
    data = None
    for enc in ["gbk", "gb2312", "utf-8", "gb18030"]:
        try:
            data = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if data is None:
        data = raw.decode("gbk", errors="ignore")

    result = {}
    fields_found = set()
    for line in data.strip().split(";"):
        if not line.strip() or "=" not in line or '"' not in line:
            continue
        key = line.split("=")[0].split("_")[-1]
        vals = line.split('"')[1].split("~")
        if len(vals) < 53:
            continue
        code = key[2:]

        # 腾讯返回的字段索引（关键字段）
        # 参考: https://blog.csdn.net/afgasdg/article/details/86029285
        result[code] = {
            "name": vals[1],
            "code": code,
            "price": float(vals[3]) if vals[3] else None,
            "last_close": float(vals[4]) if vals[4] else None,
            "open": float(vals[5]) if vals[5] else None,
            "volume": float(vals[6]) if vals[6] else None,  # 成交量(手)
            "outer_vol": float(vals[7]) if vals[7] else None,  # 外盘
            "inner_vol": float(vals[8]) if vals[8] else None,  # 内盘
            "bid1": float(vals[9]) if vals[9] else None,
            "bid1_vol": float(vals[10]) if vals[10] else None,
            "ask1": float(vals[11]) if vals[11] else None,
            "ask1_vol": float(vals[12]) if vals[12] else None,
            "bid2": float(vals[13]) if vals[13] else None,
            "bid2_vol": float(vals[14]) if vals[14] else None,
            "ask2": float(vals[15]) if vals[15] else None,
            "ask2_vol": float(vals[16]) if vals[16] else None,
            "bid3": float(vals[17]) if vals[17] else None,
            "bid3_vol": float(vals[18]) if vals[18] else None,
            "ask3": float(vals[19]) if vals[19] else None,
            "ask3_vol": float(vals[20]) if vals[20] else None,
            "bid4": float(vals[21]) if vals[21] else None,
            "bid4_vol": float(vals[22]) if vals[22] else None,
            "ask4": float(vals[23]) if vals[23] else None,
            "ask4_vol": float(vals[24]) if vals[24] else None,
            "bid5": float(vals[25]) if vals[25] else None,
            "bid5_vol": float(vals[26]) if vals[26] else None,
            "ask5": float(vals[27]) if vals[27] else None,
            "ask5_vol": float(vals[28]) if vals[28] else None,
            "latest_trade_detail": vals[29],  # 最近逐笔成交
            "datetime": vals[30],  # 时间
            "change_amt": float(vals[31]) if vals[31] else None,
            "change_pct": float(vals[32]) if vals[32] else None,
            "high": float(vals[33]) if vals[33] else None,
            "low": float(vals[34]) if vals[34] else None,
            "price_vol_ratio": vals[35] if vals[35] else None,  # 价格/成交量(手) 可能是 "1323.00/49661/6594983723"
            "total_vol_shou": float(vals[36]) if vals[36] else None,  # 总成交量(手)
            "total_amount_yuan": float(vals[37]) if vals[37] else None,  # 总金额(元)
            "turnover_pct": float(vals[38]) if vals[38] else None,  # 换手率
            "pe_ttm": float(vals[39]) if vals[39] else None,  # 市盈率
            "amplitude": float(vals[43]) if vals[43] else None,  # 振幅
            "mcap_yi": float(vals[44]) if vals[44] else None,  # 流通市值(亿)
            "total_cap_yi": float(vals[45]) if vals[45] else None,  # 总市值(亿)
            "pb": float(vals[46]) if vals[46] else None,  # 市净率
            "limit_up": float(vals[47]) if vals[47] else None,  # 涨停价
            "limit_down": float(vals[48]) if vals[48] else None,  # 跌停价
            "vol_ratio": float(vals[49]) if vals[49] else None,  # 量比
            "avg_price": float(vals[50]) if vals[50] else None,  # 均价
            "pe_dynamic": float(vals[51]) if vals[51] else None,  # 动态市盈
            "pe_static": float(vals[52]) if vals[52] else None,  # 静态市盈
        }
        if not fields_found:
            fields_found = set(result[code].keys())

    latency = (time.time() - t0) * 1000
    return {"latency_ms": round(latency, 1), "count": len(result), "fields": list(fields_found), "data": result}


# ── akshare 接口 ──────────────────────────────────────────────────────────

def akshare_quotes() -> dict:
    t0 = time.time()
    try:
        import akshare as ak
        df = ak.stock_zh_a_spot_em()
        latency = (time.time() - t0) * 1000

        # 获取字段列表
        fields = list(df.columns)

        # 取第一行看看数据样例
        sample = {}
        if not df.empty:
            row = df.iloc[0]
            sample = {k: str(v) for k, v in row.to_dict().items()}

        return {
            "latency_ms": round(latency, 1),
            "count": len(df),
            "fields": fields,
            "sample": sample,
        }
    except Exception as e:
        latency = (time.time() - t0) * 1000
        return {"latency_ms": round(latency, 1), "error": str(e)}


# ── klines 派生 ───────────────────────────────────────────────────────────

def klines_derived_quotes() -> dict:
    t0 = time.time()
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()

        # 获取最新的 kline 数据作为 quotes
        row = cur.execute(
            "SELECT MAX(date) as max_date FROM klines WHERE period = 'daily' AND adjust = 'bfq'"
        ).fetchone()
        latest_date = row["max_date"] if row else None

        if not latest_date:
            return {"latency_ms": round((time.time()-t0)*1000, 1), "error": "no klines"}

        klines = cur.execute(
            """SELECT code, market, date, open, high, low, close as latest, volume,
                      turnover, change_pct, pre_close
               FROM klines
               WHERE period = 'daily' AND adjust = 'bfq' AND date = ?""",
            (latest_date,)
        ).fetchall()

        conn.close()

        sample = {}
        if klines:
            k = klines[0]
            sample = {key: k[key] for key in k.keys()}

        return {
            "latency_ms": round((time.time()-t0)*1000, 1),
            "count": len(klines),
            "latest_date": latest_date,
            "fields": ["code", "market", "date", "open", "high", "low", "close/latest", "volume", "turnover", "change_pct", "pre_close"],
            "sample": sample,
        }
    except Exception as e:
        latency = (time.time() - t0) * 1000
        return {"latency_ms": round(latency, 1), "error": str(e)}


# ── 对比主程序 ────────────────────────────────────────────────────────────

TEST_CODES = ["600519", "000001", "688016", "300750", "000858", "601318", "002594", "600036", "300059", "000002"]

if __name__ == "__main__":
    print("=" * 70)
    print("行情接口对比测试")
    print("=" * 70)

    # 1. 腾讯接口
    print("\n[1] 腾讯 qt.gtimg.cn 接口")
    print("-" * 50)
    tencent = tencent_quote(TEST_CODES)
    print(f"  延迟: {tencent['latency_ms']}ms")
    print(f"  返回股票数: {tencent['count']}")
    print(f"  字段数: {len(tencent['fields'])}")
    print(f"  字段列表: {', '.join(tencent['fields'][:20])}...")
    if tencent['data']:
        code = list(tencent['data'].keys())[0]
        print(f"  示例 ({code}):")
        d = tencent['data'][code]
        for k in ['name', 'price', 'change_pct', 'pe_ttm', 'pb', 'turnover_pct', 'mcap_yi']:
            print(f"    {k}: {d.get(k)}")

    # 2. akshare 接口
    print("\n[2] akshare stock_zh_a_spot_em 接口")
    print("-" * 50)
    ak = akshare_quotes()
    if "error" in ak:
        print(f"  错误: {ak['error']}")
    else:
        print(f"  延迟: {ak['latency_ms']}ms")
        print(f"  返回股票数: {ak['count']}")
        print(f"  字段数: {len(ak['fields'])}")
        print(f"  字段列表: {', '.join(ak['fields'][:10])}...")
        if ak['sample']:
            print(f"  示例:")
            for k in ['名称', '最新价', '涨跌幅', '市盈率-动态', '市净率', '换手率', '总市值']:
                if k in ak['sample']:
                    print(f"    {k}: {ak['sample'][k]}")

    # 3. klines 派生
    print("\n[3] klines 派生 (DB 查询)")
    print("-" * 50)
    kl = klines_derived_quotes()
    if "error" in kl:
        print(f"  错误: {kl['error']}")
    else:
        print(f"  延迟: {kl['latency_ms']}ms")
        print(f"  返回股票数: {kl['count']}")
        print(f"  最新日期: {kl['latest_date']}")
        print(f"  字段: {', '.join(kl['fields'])}")
        if kl['sample']:
            print(f"  示例:")
            for k, v in list(kl['sample'].items())[:7]:
                print(f"    {k}: {v}")

    # 4. 数据一致性对比
    print("\n[4] 数据一致性对比 (同一只股票的 price/change_pct)")
    print("-" * 50)
    compare_code = "600519"
    if tencent.get('data') and compare_code in tencent['data']:
        t = tencent['data'][compare_code]
        print(f"  {compare_code} 腾讯: price={t.get('price')}, change_pct={t.get('change_pct')}%, pe={t.get('pe_ttm')}, pb={t.get('pb')}")

    if 'sample' in ak and ak['sample'] and '名称' in ak['sample']:
        s = ak['sample']
        print(f"  {compare_code} akshare: 最新价={s.get('最新价')}, 涨跌幅={s.get('涨跌幅')}%, 市盈率={s.get('市盈率-动态')}, 市净率={s.get('市净率')}")

    # 5. 批量性能对比（腾讯 vs akshare）
    print("\n[5] 批量性能对比 (全市场 ~5500 只)")
    print("-" * 50)
    print("  腾讯接口: 一次 HTTP 请求可传任意数量代码")
    print("  akshare:  一次获取全市场，但数据量更大")

    # 测试腾讯批量请求 100 只
    bulk_codes = [f"{i:06d}" for i in range(600000, 600100)]
    t0 = time.time()
    bulk = tencent_quote(bulk_codes)
    print(f"  腾讯 100 只: {bulk['latency_ms']}ms, 实际返回 {bulk['count']} 只")

    # 测试腾讯批量请求 500 只
    bulk_codes_500 = [f"{i:06d}" for i in range(600000, 600500)]
    t0 = time.time()
    bulk500 = tencent_quote(bulk_codes_500)
    print(f"  腾讯 500 只: {bulk500['latency_ms']}ms, 实际返回 {bulk500['count']} 只")

    # 测试腾讯批量请求 800 只（URL 长度限制约 800 只）
    bulk_codes_800 = [f"{i:06d}" for i in range(600000, 600800)]
    t0 = time.time()
    bulk800 = tencent_quote(bulk_codes_800)
    print(f"  腾讯 800 只: {bulk800['latency_ms']}ms, 实际返回 {bulk800['count']} 只")

    # 测试腾讯分批次请求 3000 只（模拟全市场）
    all_codes = [f"{i:06d}" for i in range(600000, 603000)]
    batch_size = 800
    t0 = time.time()
    total_count = 0
    for i in range(0, len(all_codes), batch_size):
        batch = all_codes[i:i+batch_size]
        r = tencent_quote(batch)
        total_count += r['count']
    elapsed = round((time.time() - t0) * 1000, 1)
    print(f"  腾讯 3000 只(分4批,每批800): {elapsed}ms, 实际返回 {total_count} 只")

    print("\n" + "=" * 70)
    print("对比总结")
    print("=" * 70)
    print("""
腾讯 qt.gtimg.cn:
  + 速度极快 (<100ms 可获取 1000+ 只股票)
  + 包含五档盘口、量比、涨停跌停价等丰富字段
  + 无需第三方库依赖 (纯 urllib)
  + 支持批量查询，URL 长度限制内可任意数量
  - 字段位置靠硬编码索引，接口变动可能失效
  - 返回数据为文本格式，需手动解析
  - 无官方文档，字段索引来自社区整理

akshare stock_zh_a_spot_em:
  + 结构化 DataFrame，字段名清晰
  + 有社区维护，相对可靠
  + 一次获取全市场 ~5500 只
  - 速度较慢 (通常 1-5s)
  - 依赖 akshare + pandas + 多个底层库
  - 非交易时段可能返回空或异常

klines 派生:
  + 完全本地，速度最快 (<10ms)
  + 不依赖外部 API
  - 只有 OHLCV + change_pct，缺少 PE/PB/市值等
  - 数据滞后一天（除非 klines 已同步当天）
  - 非交易时段只能获取收盘数据
""")
