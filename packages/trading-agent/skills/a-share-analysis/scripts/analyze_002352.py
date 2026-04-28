# -*- coding: utf-8 -*-
import json
import os
import tempfile
import pandas as pd

# Load merged data
basic = json.load(open(os.path.join(tempfile.gettempdir(), '002352_basic.json'), encoding='utf-8'))
price = json.load(open(os.path.join(tempfile.gettempdir(), '002352_price.json'), encoding='utf-8'))
financial = json.load(open(os.path.join(tempfile.gettempdir(), '002352_financial.json'), encoding='utf-8'))

info = basic['basic_info']
price_data = price['price']
indicators = financial.get('financial_indicators', [])

# Extract readable financial indicators
indicator_map = {}
for row in indicators:
    key = row.get('指标') or row.get('ָ��')
    if not key:
        continue
    # Latest value is from the most recent column (20251231, 20250930, etc.)
    latest_val = None
    for col in ['20251231', '20250930', '20250630', '20250331', '20241231', '20240930', '20240630', '20240331']:
        if col in row and row[col] is not None:
            latest_val = row[col]
            break
    indicator_map[key] = latest_val

# Technical analysis
klines = price_data['price_data']
df = pd.DataFrame(klines)
df['date'] = pd.to_datetime(df['date'])

# Moving averages
df['ma5'] = df['close'].rolling(window=5).mean()
df['ma10'] = df['close'].rolling(window=10).mean()
df['ma20'] = df['close'].rolling(window=20).mean()

# RSI(14)
delta = df['close'].diff()
gain = delta.where(delta > 0, 0).rolling(window=14).mean()
loss = (-delta.where(delta < 0, 0)).rolling(window=14).mean()
rs = gain / loss
df['rsi'] = 100 - (100 / (1 + rs))

# MACD
df['ema12'] = df['close'].ewm(span=12, adjust=False).mean()
df['ema26'] = df['close'].ewm(span=26, adjust=False).mean()
df['macd'] = df['ema12'] - df['ema26']
df['macd_signal'] = df['macd'].ewm(span=9, adjust=False).mean()
df['macd_hist'] = df['macd'] - df['macd_signal']

# Bollinger Bands
df['std20'] = df['close'].rolling(window=20).std()
df['bb_upper'] = df['ma20'] + 2 * df['std20']
df['bb_lower'] = df['ma20'] - 2 * df['std20']

latest = df.iloc[-1]
recent_high_20 = df['high'].iloc[-20:].max()
recent_low_20 = df['low'].iloc[-20:].min()

# Volume analysis
all_klines = price_data.get('price_data', [])
all_volumes = [k['volume'] for k in all_klines if k.get('volume') is not None]
vol_ma20 = sum(all_volumes[-20:]) / len(all_volumes[-20:]) if len(all_volumes) >= 20 else None

report = []
report.append("=== 顺丰控股 (002352) 综合分析报告 ===")
report.append(f"分析日期: {price_data['latest_date']}")
report.append("")

report.append("--- 基本信息 ---")
report.append(f"股票名称: {info.get('name', '顺丰控股')}")
report.append(f"所属行业: {info.get('industry', 'N/A')}")
report.append(f"最新收盘价: {price_data['latest_price']:.2f} 元")
report.append(f"今日涨跌幅: {price_data['price_change_pct']:.2f}%")
report.append(f"总市值: {info.get('market_cap', 0)/1e8:.1f} 亿元")
report.append(f"流通市值: {info.get('float_cap', 0)/1e8:.1f} 亿元")
report.append(f"市盈率 (PE TTM): {info.get('pe_ttm', 'N/A')}")
report.append(f"数据来源: {info.get('_source', 'unknown')}")
report.append("")

report.append("--- 财务指标（来自 akshare 财务摘要）---")
for k, v in indicator_map.items():
    if v is not None:
        if isinstance(v, float):
            report.append(f"{k}: {v:,.2f}")
        else:
            report.append(f"{k}: {v}")
report.append("")

report.append("--- 技术指标 ---")
report.append(f"MA5:  {latest['ma5']:.2f}")
report.append(f"MA10: {latest['ma10']:.2f}")
report.append(f"MA20: {latest['ma20']:.2f}")
report.append(f"RSI(14): {latest['rsi']:.2f}")
report.append(f"MACD: {latest['macd']:.4f} | Signal: {latest['macd_signal']:.4f} | Histogram: {latest['macd_hist']:.4f}")
report.append(f"布林上轨: {latest['bb_upper']:.2f}")
report.append(f"布林中轨: {latest['ma20']:.2f}")
report.append(f"布林下轨: {latest['bb_lower']:.2f}")
report.append(f"20日高点: {recent_high_20:.2f}")
report.append(f"20日低点: {recent_low_20:.2f}")
report.append(f"距20日高点: {(latest['close']/recent_high_20 - 1)*100:.1f}%")
report.append(f"距20日低点: {(latest['close']/recent_low_20 - 1)*100:.1f}%")
report.append(f"最新成交量: {price_data['volume']/1e4:.0f} 万手")
report.append(f"20日均量: {vol_ma20/1e4:.0f} 万手" if vol_ma20 else "20日均量: N/A")
report.append(f"量比: {price_data['volume']/vol_ma20:.2f}" if vol_ma20 else "量比: N/A")
report.append("")

current = latest['close']
if current > latest['ma5'] > latest['ma10']:
    trend = "短期多头排列"
elif current < latest['ma5'] < latest['ma10']:
    trend = "短期空头排列"
else:
    trend = "震荡整理"

report.append(f"趋势判断: {trend}")
report.append("")

report.append("--- 关键观察 ---")
obs = []
if latest['rsi'] > 70:
    obs.append(f"RSI 超买 ({latest['rsi']:.1f})")
elif latest['rsi'] < 30:
    obs.append(f"RSI 超卖 ({latest['rsi']:.1f})")
else:
    obs.append(f"RSI 中性 ({latest['rsi']:.1f})")

if latest['macd_hist'] > 0 and df['macd_hist'].iloc[-2] <= 0:
    obs.append("MACD 刚刚金叉")
elif latest['macd_hist'] < 0 and df['macd_hist'].iloc[-2] >= 0:
    obs.append("MACD 刚刚死叉")
elif latest['macd_hist'] > 0:
    obs.append("MACD 红柱延续")
else:
    obs.append("MACD 绿柱延续")

obs.append(f"K线数据源: {price_data.get('_source', 'unknown')}")
for o in obs:
    report.append(f"- {o}")

# Save report
out_path = os.path.join(tempfile.gettempdir(), '002352_report.txt')
with open(out_path, 'w', encoding='utf-8') as f:
    f.write("\n".join(report))

print(f"Report saved to: {out_path}")
