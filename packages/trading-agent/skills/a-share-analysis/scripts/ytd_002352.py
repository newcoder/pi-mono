# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'stock-data', 'scripts'))
from get_kline import get_stock_kline

data = get_stock_kline('002352', market=0, period='daily', adjust='qfq', start_date='20260101', end_date='20260416')
klines = data.get('klines', [])
if klines:
    start_price = klines[0]['close']
    end_price = klines[-1]['close']
    ytd = (end_price / start_price - 1) * 100
    print(f'YTD: {ytd:.2f}%')
    print(f'2026 first close: {start_price}')
    print(f'2026 latest close: {end_price}')
    print(f'Total trading days in 2026: {len(klines)}')
else:
    print('No data')
