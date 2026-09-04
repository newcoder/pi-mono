"""Daily sync phases package."""

from .stocks import sync_stocks
from .quotes import sync_quotes
from .klines import sync_klines
from .fundamentals import sync_fundamentals
from .indicators import sync_indicators, sync_industry_momentum, sync_size_ic
from .industry import sync_industries, sync_industry_klines_ths_phase, sync_index_klines
from .concept import (
    sync_concepts,
    sync_concept_synthetic_klines,
)
from .news import (
    sync_hot_stocks,
    sync_stock_news,
    sync_market_news,
)
from .validation import run_validation, run_data_quality_sampling

ALL_PHASES = [
    ("stocks", sync_stocks),
    ("quotes", sync_quotes),
    ("klines", sync_klines),
    ("fundamentals", sync_fundamentals),
    ("indicators", sync_indicators),
    ("industry_momentum", sync_industry_momentum),
    ("size_ic", sync_size_ic),
    ("industries", sync_industries),
    ("industry_klines", sync_industry_klines_ths_phase),
    ("index_klines", sync_index_klines),
    ("concepts", sync_concepts),
    ("concept_synthetic_klines", sync_concept_synthetic_klines),
    ("hot_stocks", sync_hot_stocks),
    ("stock_news", sync_stock_news),
    ("market_news", sync_market_news),
    ("validation", run_validation),
    ("data_quality", run_data_quality_sampling),
]
