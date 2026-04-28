# -*- coding: utf-8 -*-
"""
get data from jqdatasdk or other sources
@author: Ray Ni

"""

import copy
import os
import pickle
import datetime
import jqdatasdk as jq
import pandas as pd

from functools import wraps

#
SH_INDEX = '000001.XSHG'
SZ_INDEX = '399001.XSHE'
CY_INDEX = '399006.XSHE'
HS300_INDEX = '000300.XSHG'
ZZ500_INDEX = '000905.XSHG'
ZZ800_INDEX = '000906.XSHG'
ZZA500_INDEX = '000510.XSHG'
SZ50_INDEX = '000016.XSHG'
ZZ1000_INDEX = '000852.XSHG'


def assert_auth(func):
    @wraps(func)
    def _wrapper(*args, **kwargs):
        if not jq.is_auth():
            username = os.environ.get("JQ_USERNAME")
            password = os.environ.get("JQ_PASSWORD")
            if not username or not password:
                raise RuntimeError(
                    "JoinQuant credentials not found. "
                    "Set JQ_USERNAME and JQ_PASSWORD environment variables."
                )
            jq.auth(username, password)
        return func(*args, **kwargs)
    return _wrapper


def to_date(x):
    return x.date()

@assert_auth
def login():
    try:
        print(jq.get_query_count()) 
    except Exception as e:
        print(e)


# 股票代码加上市场后缀, 同花顺接口格式
def add_code_suffix(code):
    if code.find('.') > 0:
        return code
    if code.startswith('60') or code.startswith('68'):
        code = code + '.SH'
    elif code.startswith('90'):
        code = code + '.SH'
    elif code.startswith('SH'):
        code = code[2:len(code)] + '.SH'
    elif code.startswith('SZ'):
        code = code[2:len(code)] + '.SZ'
    else:
        code = code + '.SZ'
    return code


# 股票代码加上市场后缀
def add_norm_suffix(code):
    if code.find('.') > 0:
        code = code.split('.')[0]
    if code.startswith('60') or code.startswith('68'):
        code = code + '.XSHG'
    elif code.startswith('90'):
        code = code + '.XSHG'
    elif code.startswith('SH'):
        code = code[2:len(code)] + '.XSHG'
    elif code.startswith('SZ'):
        code = code[2:len(code)] + '.XSHE'
    else:
        code = code + '.XSHE'
    return code


# 将股票转化为聚宽股票codes形式
# @assert_auth
def normalize_code(codes):
    if type(codes) is str:
        return add_norm_suffix(codes)
    if codes is None or len(codes) == 0:
        return codes
    codes = [add_norm_suffix(c) for c in codes]
    return codes
    # return jq.normalize_code(codes)


@assert_auth
def get_all_stocks(date=None):
    df = jq.get_all_securities(types=['stock'], date=date)
    return df


# 沪深300成分股
@assert_auth
def get_hs300_stocks(date=None):
    index = HS300_INDEX
    stocks = jq.get_index_stocks(index, date)
    return stocks


# zz800成分股
@assert_auth
def get_zz800_stocks(date=None):
    index = ZZ800_INDEX
    stocks = jq.get_index_stocks(index, date)
    return stocks


@assert_auth
def get_a500_stocks(date=None):
    index = ZZA500_INDEX
    stocks = jq.get_index_stocks(index, date)
    return stocks


# zz1000成分股
@assert_auth
def get_zz1000_stocks(date=None):
    index = ZZ1000_INDEX
    stocks = jq.get_index_stocks(index, date)
    return stocks

# 中证500成分股
@assert_auth
def get_zz500_stocks(date=None):
    index = ZZ500_INDEX
    stocks = jq.get_index_stocks(index, date)
    return stocks


# 上证50成分股
@assert_auth
def get_sz50_stocks(date=None):
    index = SZ50_INDEX
    stocks = jq.get_index_stocks(index, date)
    return stocks

# 融资标的股
def get_margincash_stocks(date=None):
    stocks = jq.get_margincash_stocks(date=date)
    return stocks

# 融券标的股
def get_marginsec_stocks(date=None):
    stocks = jq.get_marginsec_stocks(date=date)
    return stocks


# 取概念股
def get_concept_stocks(concept_code, date=None):
    stocks = jq.get_concept_stocks(concept_code, date=date)
    return stocks


# 取msci概念股
@assert_auth
def get_mscilarge_stocks(date=None):
    return get_concept_stocks('GN240', date=date)


# 取msci概念股
@assert_auth
def get_mscimid_stocks(date=None):
    return get_concept_stocks('GN1189', date=date)


# 取龙虎榜股票
def get_billboard_stocks(days=20, end_date=None):
    if end_date is None:
        end_date = datetime.datetime.now().strftime('%Y-%m-%d')
    stocks = jq.get_billboard_list(end_date=end_date, count=days)
    if len(stocks) > 0:
        stock_codes = stocks['code'].unique()
        return stock_codes
    else:
        return []


# 取指定时间段内的交易日
@assert_auth
def get_trade_days(start_date=None, end_date=None, count=None):
    days = jq.get_trade_days(start_date=start_date, end_date=end_date, count=count)
    return days


# 取指定时间段内的交易日
def get_stocks_pools(start_date, end_date=None, msci=None, index='300'):
    #
    return {}

# 取指定时间段内的交易日
def fetch_date_serial_hs300(stocks, start_date, end_date=None):
    #
    return None


# 取指定时间段内的交易日
def fetch_feature(stock, start_date):
    #
    return None

# 取指定时间段内的交易日
def get_hs300_stocks_pool(date, margin='c', msci='l'):
    #
    stocks = get_hs300_stocks(date)
    # print('no margin/MSCI')
    margincash_stocks = get_margincash_stocks(date)
    marginsec_stocks = get_marginsec_stocks(date)
    msci_stocks = get_mscilarge_stocks(date)
    if len(marginsec_stocks) > 0:
        s1 = set(stocks)
        stocks = list(s1.intersection(set(marginsec_stocks)))
        # print('融券')
    if len(margincash_stocks) > 0:
        s1 = set(stocks)
        stocks = list(s1.intersection(set(margincash_stocks)))
        # print('融资')
    if len(msci_stocks) > 0:
        s1 = set(stocks)
        stocks = list(s1.intersection(set(msci_stocks)))
        # print('MSCI')
    return stocks


# 提取一组股票所属的行业
def hot_industries(stocks, top_n, industry_prefix='zjw'):
    """
    industry hits ranking in a list of stock
    :param stocks:
    :param industry_prefix: sw: 申万行业分类, zjw: 证监会行业分类，jq: 聚宽行业分类
    :return:
    """
    industry_hits = dict()
    stock_industries = jq.get_industry(security=list(stocks), date=datetime.datetime.now().strftime('%Y-%m-%d'))
    for k, v in stock_industries.items():
        for industry_key in v.keys():
            if industry_key.startswith(industry_prefix):
                industry_obj = v[industry_key]
                industry_code = industry_obj['industry_code']
                if industry_code in industry_hits:
                    hit_obj = industry_hits[industry_code]
                    hit_obj['hits'] = hit_obj['hits'] + 1
                else:
                    hit_obj = copy.deepcopy(industry_obj)
                    hit_obj['hits'] = 1
                    industry_hits[industry_code] = hit_obj
    df = pd.DataFrame(list(industry_hits.values()))
    df.sort_values(by=['hits'], ascending=False, inplace=True)
    hot_industry_codes = df['industry_code'].values
    return hot_industry_codes[:top_n]


# 通过行业过滤股票
def filter_stocks(stocks, industry_codes, industry_prefix='zjw'):
    """
    filter stocks by industries
    :param stocks:
    :param industry_codes:
    :param industry_prefix:
    :return:
    """
    stock_industries = jq.get_industry(security=list(stocks), date=datetime.datetime.now().strftime('%Y-%m-%d'))
    result_stocks = []
    for k, v in stock_industries.items():
        for industry_key in v.keys():
            if industry_key.startswith(industry_prefix):
                industry_obj = v[industry_key]
                industry_code = industry_obj['industry_code']
                if industry_code in industry_codes:
                    result_stocks.append(k)
                    break
    return result_stocks


@assert_auth
def fetch(security, start_date, end_date=None, frequency='daily', fq='pre'):
    """
    fetch future data from jqdatasdk
    :param security:
    :param start_date:
    :param end_date:
    :param frequency: 'daily' or 'minute'
    :return:
    """
    fields = ['open', 'close', 'low', 'high', 'volume', 'money', 'factor', 'high_limit', 'low_limit', 'avg', 'pre_close',
     'paused']
    if end_date is None:
        now = datetime.datetime.now()
        end_date = now.strftime('%Y-%m-%d')
    df = jq.get_price(security, start_date=start_date, end_date=end_date, frequency=frequency, fq=fq, fields=fields, panel=True,
                      skip_paused=False)
    df.dropna(inplace=True)
    return df


@assert_auth
def fetch_latest(security, fq='post'):
    fields = ['open', 'close', 'low', 'high', 'volume', 'money', 'factor', 'high_limit', 'low_limit', 'avg', 'pre_close',
     'paused']
    now = datetime.datetime.now()
    end_date = now.strftime('%Y-%m-%d')
    df = jq.get_price(security, end_date=end_date, frequency='daily', fields=fields, skip_paused=False, panel=False,
                      fq=fq, count=1)
    return df


@assert_auth
def fetch_bars(security, bars, end_date=None, frequency='1w'):
    """
    fetch bars data from jqdatasdk
    :param security:
    :param bars:
    :param end_date:
    :param frequency: '1m', '5m', '15m', '30m', '60m', '120m', '1d', '1w', '1M'
    :return:
    """
    # fields supports: 'date', 'open', 'close', 'high', 'low', 'volume', 'money', 'open_interest'
    fields = ['date', 'open', 'close', 'low', 'high', 'volume', 'money']
    df = jq.get_bars(security, count=bars, end_dt=end_date, unit=frequency, fields=fields, include_now=True)
    df.dropna(inplace=True)
    return df


@assert_auth
def get_kline_factors(stock_code, start_date=None, end_date=None):
    """
    Fetch adjustment factors (前复权/后复权) from jqdatasdk for a single stock.
    Returns daily factors regardless of requested period, since dividends are daily events.

    :param stock_code: 6-digit code or normalized code
    :param start_date: 'YYYY-MM-DD' or 'YYYYMMDD'
    :param end_date: 'YYYY-MM-DD' or 'YYYYMMDD'
    :return: DataFrame with columns date, qfq_factor, hfq_factor
    """
    stock_code = normalize_code(stock_code)

    # Normalize dates
    if start_date and len(str(start_date)) == 8:
        sd = str(start_date)
        start_date = f"{sd[:4]}-{sd[4:6]}-{sd[6:]}"
    if end_date and len(str(end_date)) == 8:
        ed = str(end_date)
        end_date = f"{ed[:4]}-{ed[4:6]}-{ed[6:]}"
    if end_date is None:
        end_date = datetime.datetime.now().strftime('%Y-%m-%d')

    # Fetch pre-adjustment factors (qfq)
    df_pre = jq.get_price(stock_code, start_date=start_date, end_date=end_date,
                          frequency='daily', fq='pre', fields=['factor'], panel=False,
                          skip_paused=False)
    # Fetch post-adjustment factors (hfq)
    df_post = jq.get_price(stock_code, start_date=start_date, end_date=end_date,
                           frequency='daily', fq='post', fields=['factor'], panel=False,
                           skip_paused=False)

    # Rename and merge
    if df_pre is not None and len(df_pre) > 0:
        df_pre = df_pre[['factor']].copy()
        df_pre.rename(columns={'factor': 'qfq_factor'}, inplace=True)
    else:
        df_pre = pd.DataFrame(columns=['qfq_factor'])

    if df_post is not None and len(df_post) > 0:
        df_post = df_post[['factor']].copy()
        df_post.rename(columns={'factor': 'hfq_factor'}, inplace=True)
    else:
        df_post = pd.DataFrame(columns=['hfq_factor'])

    df = df_pre.join(df_post, how='outer')
    df.reset_index(inplace=True)
    # Ensure date column is standardized
    if 'index' in df.columns:
        df.rename(columns={'index': 'date'}, inplace=True)
    for col in df.columns:
        if col in ('date', 'time', 'datetime') and col != 'date':
            df.rename(columns={col: 'date'}, inplace=True)

    return df


@assert_auth
def get_kline_data(stock_code, start_date=None, end_date=None, frequency='daily', fq='pre'):
    """
    Fetch K-line OHLCV data from jqdatasdk for a single stock.

    :param stock_code: 6-digit code or normalized code like '000001.XSHE'
    :param start_date: 'YYYY-MM-DD' or 'YYYYMMDD'
    :param end_date: 'YYYY-MM-DD' or 'YYYYMMDD'
    :param frequency: '1m','5m','15m','30m','60m','120m','daily','week','month','quarter','year'
    :param fq: 'pre' (前复权), 'post' (后复权), None (不复权)
    :return: DataFrame with columns date, open, close, low, high, volume, money, pre_close, avg
    """
    stock_code = normalize_code(stock_code)

    # Normalize dates from YYYYMMDD to YYYY-MM-DD
    if start_date and len(str(start_date)) == 8:
        sd = str(start_date)
        start_date = f"{sd[:4]}-{sd[4:6]}-{sd[6:]}"
    if end_date and len(str(end_date)) == 8:
        ed = str(end_date)
        end_date = f"{ed[:4]}-{ed[4:6]}-{ed[6:]}"
    if end_date is None:
        end_date = datetime.datetime.now().strftime('%Y-%m-%d')

    minute_freqs = {'1m', '5m', '15m', '30m', '60m', '120m'}

    if frequency in minute_freqs:
        # Minute data across multiple days does not allow pre_close/avg fields
        fields = ['open', 'close', 'low', 'high', 'volume', 'money']
        jq_freq = frequency
    else:
        # Daily-based data; fetch daily then resample for week/month/quarter/year
        fields = ['open', 'close', 'low', 'high', 'volume', 'money', 'pre_close', 'avg']
        jq_freq = 'daily'

    df = jq.get_price(stock_code, start_date=start_date, end_date=end_date,
                      frequency=jq_freq, fq=fq, fields=fields, panel=False,
                      skip_paused=False)
    df.dropna(inplace=True)

    # Resample for week/month/quarter/year
    if frequency == 'week':
        df = df.resample('W-FRI').agg({
            'open': 'first', 'high': 'max', 'low': 'min',
            'close': 'last', 'volume': 'sum', 'money': 'sum',
            'pre_close': 'first', 'avg': 'mean'
        })
    elif frequency == 'month':
        df = df.resample('ME').agg({
            'open': 'first', 'high': 'max', 'low': 'min',
            'close': 'last', 'volume': 'sum', 'money': 'sum',
            'pre_close': 'first', 'avg': 'mean'
        })
    elif frequency == 'quarter':
        df = df.resample('QE').agg({
            'open': 'first', 'high': 'max', 'low': 'min',
            'close': 'last', 'volume': 'sum', 'money': 'sum',
            'pre_close': 'first', 'avg': 'mean'
        })
    elif frequency == 'year':
        df = df.resample('YE').agg({
            'open': 'first', 'high': 'max', 'low': 'min',
            'close': 'last', 'volume': 'sum', 'money': 'sum',
            'pre_close': 'first', 'avg': 'mean'
        })

    df.reset_index(inplace=True)
    if 'index' in df.columns:
        df.rename(columns={'index': 'date'}, inplace=True)

    # Ensure date column uses standard name
    for col in df.columns:
        if col in ('date', 'time', 'datetime'):
            if col != 'date':
                df.rename(columns={col: 'date'}, inplace=True)
            break

    return df


def get_industries_local(local_path):
    df = pd.read_csv(local_path, index_col=0)
    df.index = df.index.map(str)
    return df


@assert_auth
def get_industry_stocks(industry_code):
    df = jq.get_industry_stocks(industry_code)
    return df


@assert_auth
def get_stock_industries(stocks, industry_type):
    result_dict = dict()
    stock_industries = jq.get_industry(security=list(stocks), date=datetime.datetime.now().strftime('%Y-%m-%d'))
    for k, v in stock_industries.items():
        if industry_type in v:
            code = v[industry_type]['industry_code']
            result_dict[k] = code
    return result_dict


@assert_auth
def get_stocks_industries():
    _df = jq.get_all_securities(types=['stock'], date=None)
    print(len(_df))
    print(_df.head(10))
    stocks = list(_df.index)
    industries_df = jq.get_industry(security=list(stocks), date=datetime.datetime.now().strftime('%Y-%m-%d'), df=True)
    return industries_df


# 获取聚宽行业信息
@assert_auth
def get_industries_from_mysql(ms, name='sw_l1', date=None):
    sql = "select industry_id, name, start_date " \
          "from tb_jq_industries " \
          "where date = '%s' and type = '%s' " % (date, name)
    df = ms.exeQuery(sql, ['industry_id', 'name', 'start_date'])
    if df is None:
        indu_code = jq.get_industries(name=name, date=date)
        sql = 'replace into tb_jq_industries(date, type, industry_id, name, start_date) values'
        for index, row in indu_code.iterrows():
            sql += " ('%s','%s','%s','%s','%s')," % (date, name, index, row['name'], str(row['start_date'])[:10])
        sql = sql[0:-1] + ";"
        ms.exeNonQuery(sql)
        return indu_code
    else:
        df.set_index("industry_id", inplace=True)
        return df


# 获取聚宽行业下的成分股票
@assert_auth
def get_industry_stocks_from_mysql(ms, industry_id, date):
    sql = "select constituent_stocks " \
          "from tb_jq_industry_constituent_stocks " \
          "where date = '%s' and industry_id = '%s' " % (date, industry_id)
    df = ms.exeQuery(sql, ['constituent_stocks'])
    if df is None:
        stocks = jq.get_industry_stocks(industry_id, date)
        sql = "replace into tb_jq_industry_constituent_stocks(date, industry_id, constituent_stocks) " \
              "values ('%s', '%s', \"%s\");" % (date, industry_id, stocks)
        ms.exeNonQuery(sql)
        return stocks
    else:
        return eval(df.iloc[0]['constituent_stocks'])


#
# # import sqlalchemy.orm.query
from jqdatasdk import finance
# from jqdatasdk import jy
# # from jqdatasdk import s
#
#
# def get_sw_quote(code,end_date=None,count=None,start_date=None):
#     '''获取申万指数行情,返回panel结构'''
#     if isinstance(code,str):
#         code=[code]
#     days = get_trade_days(start_date,end_date,count)
#     code_df = jy.run_query(jq.query(
#          jy.SecuMain.InnerCode,jy.SecuMain.SecuCode,jy.SecuMain.ChiName
#         ).filter(
#         jy.SecuMain.SecuCode.in_(code)))
#
#     df = jy.run_query(jq.query(
#          jy.QT_SYWGIndexQuote).filter(
#         jy.QT_SYWGIndexQuote.InnerCode.in_(code_df.InnerCode),
#         jy.QT_SYWGIndexQuote.TradingDay.in_(days),
#         ))
#     df2  = pd.merge(code_df, df, on='InnerCode').set_index(['TradingDay','SecuCode'])
#     df2.drop(['InnerCode','ID','UpdateTime','JSID'],axis=1,inplace=True)
#     return df2.to_panel()

def pull_index_members():
    """
    保存指数成分到本地文件
    :return:
    """
    all_indices = jq.get_all_securities(['index'])
    # 过滤出行业指数（根据名称或代码特征）
    industry_indices = all_indices[all_indices['display_name'].str.contains('指数')]
    print(industry_indices)
    members = dict()
    for code in industry_indices.index.values:
        stocks = jq.get_index_stocks(code)
        print(f"指数 {code} 的成分股：")
        print(stocks)
        members[code] = stocks

    file = 'index_members.pkl'
    with open(file, 'wb') as f:
        pickle.dump(members, f)

    # print out
    with open(file, 'rb') as f:
        loaded_data = pickle.load(f)
    print(loaded_data)


def get_stock_index(stock_code):
    file = 'index_members.pkl'
    index_codes = []
    with open(file, 'rb') as f:
        loaded_data = pickle.load(f)
    for k, v in loaded_data.items():
        if stock_code in v:
            index_codes.append(k)
    return index_codes


def get_float_shares():
    # 示例：获取单只股票在某日的流通股本
    q = jq.query(jq.valuation.circulating_cap).filter(jq.valuation.code == '000001.XSHE')
    df = jq.get_fundamentals(q, date='2024-11-15')
    print(df)

    # 示例：获取多只股票最新的流通股本和流通市值
    stock_list = ['000001.XSHE', '600519.XSHG']
    q = jq.query(
        jq.valuation.code,
        jq.valuation.circulating_cap,  # 流通股本，单位是万股[citation:6]
        jq.valuation.circulating_market_cap  # 流通市值，单位是亿元[citation:6]
    ).filter(jq.valuation.code.in_(stock_list))
    df = jq.get_fundamentals(q)
    print(df)


if __name__ == '__main__':
    # start = '2016-01-01'
    # fetch_and_save_all(start_date=start)

    # all_securities = get_all_stocks()
    # print(all_securities)
    # hs300_stocks = get_hs300_stocks()
    # print(hs300_stocks)
    login()
    # df = get_stocks_industries()
    # exit(0)
    # get_float_shares()
    # exit(0)
    # stocks = get_all_stocks()
    # pull_index_members()
    # print(get_stock_index('601318.XSHG'))
    # exit(0)

    # codes = get_a500_stocks()
    # print(codes)
    # all_indices = jq.get_all_securities(['index'])

    # 过滤出行业指数（根据名称或代码特征）
    # industry_indices = all_indices[all_indices['display_name'].str.contains('指数')]
    # print(industry_indices)
    #
    # code = '399987.XSHE'
    # stocks = jq.get_index_stocks(code)
    # print(f"指数 {code} 的成分股：")
    # print(stocks)
    # print(len(stocks))

    # exit(0)

    df = fetch('601318.XSHG', start_date='2026-02-01', frequency='1d')
    df.reset_index(inplace=True)
    print(len(df))
    print(df.columns)
    print(df.head())
    print(df.tail())
    exit(0)
    # df = ak.index_zh_a_hist_min_em(symbol="000001", period="1", start_date="2024-01-01 09:30:00",
    #                                                       end_date="2024-12-06 19:00:00")
    # print(df)
    # print(len(df))
    # print(df.columns)
    # print(df.head())
    # print(df.tail())
    # df.columns = ['index', 'open', 'close', 'high', 'low', 'volume', 'amount', 'last_price']
    # df.to_csv('sh_index.csv')

    # exit(0)

    # code = '070002.0F'
    # q = jq.query(jq.finance.FUND_PORTFOLIO_STOCK).filter(
    #     jq.finance.FUND_PORTFOLIO_STOCK.code == code.split('.')[0]).order_by(
    #     jq.finance.FUND_PORTFOLIO_STOCK.pub_date.desc()).order_by(jq.finance.FUND_PORTFOLIO_STOCK.rank.asc()).limit(2000)
    # df = jq.finance.run_query(q)
    # print(df)
    # df.to_csv('嘉实增长.csv')
    #
    # exit(0)

    df = jq.get_all_securities(types=['stock'], date=None)
    print(df.head(10))
    stock_codes = list(df.index)
    # exit(0)

    _stocks = ['603999.XSHG', '603738.XSHG', '603619.XSHG', '603530.XSHG', '603121.XSHG',
     '601717.XSHG', '600896.XSHG', '600638.XSHG', '600630.XSHG', '513100.XSHG', '603007.XSHG']

    # latest_df = fetch_latest(stock_codes)
    # print(latest_df.close)
    d = get_stock_industries(_stocks, industry_type='zjw')
    print(d)

    # sw_index = '801769'  # 食品饮料行业
    # minute_data = jq.get_price(
    #     sw_index,
    #     start_date='2023-01-01',
    #     end_date='2023-01-05',
    #     frequency='1m',  # 可选：'1m', '5m', '15m', '30m', '60m'
    #     fields=['open', 'high', 'low', 'close', 'volume', 'money'],
    #     skip_paused=False,
    #     fq='pre'  # 复权方式：'pre'前复权，'post'后复权，None不复权
    # )
    # print(minute_data.head())

    for code in _stocks:
        si = jq.get_security_info(code)
        print(si)
    #
    # df = finance.run_query(
    #     jq.query(finance.SW1_DAILY_VALUATION).filter(finance.SW1_DAILY_VALUATION.code == '801010').limit(10))
    # print(df)
    # exit(0)

    # stocks_list = list(_stocks)
    # d = hot_industries(stocks_list)
    # hot_industry_codes = d['industry_code'].values
    # top_industries = hot_industry_codes[:20]
    # print(top_industries)
    # stocks_in_hot_industry = filter_stocks(stocks_list, top_industries)
    # print(stocks_in_hot_industry)

    industries = jq.get_industries(name='zjw')
    print(industries)
    # print(industries.index[0])
    # stocks = get_industry_stocks(industries.index[1])
    # print(stocks)

    # 查询'000001.XSHE'的所有市值数据, 时间是2015-10-15
    # q = query(
    #     valuation
    # ).filter(
    #     valuation.code == '000001.XSHE'
    # )
    # df = get_fundamentals(q, '2015-10-15')
    # # 打印出总市值
    # print(df['market_cap'][0])


    # 注意申万指数在2014年有一次大改,聚源使用的是为改变之前的代码,官网包含更改前和更改后的代码,如果遇到找不到的标的可以根据需求自行查找
    # 如801124 >>801121食品加工II

    # code = get_industries(name='sw_l2').index[:5]
    # df = get_sw_quote('801021')
    # df.to_frame(False).tail()


