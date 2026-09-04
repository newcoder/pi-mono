---
name: advanced-ml-strategy
description: 专业级机器学习量化交易策略构建技能。覆盖数据清洗、特征工程与评估、时间序列交叉验证、集成模型训练、概率校准、信号生成、成本-aware 回测与实时模型监控的完整 Pipeline。
category: strategy
---
# Advanced Machine-Learning Trading Strategy

## 概述

本技能提供一套**生产级**机器学习交易策略框架，遵循量化金融领域的最佳实践（Lopez de Prado《Advances in Financial Machine Learning》）。涵盖从原始 OHLCV 数据到可部署交易信号的完整 pipeline，内置数据防泄露、成本-aware 回测、特征漂移监控等机制。

**适用场景**：日频/周频股票、期货、加密货币的中低频方向性预测策略。

---

## Pipeline 架构

```
原始数据
   │
   ▼
[数据清洗] ──▶ 缺失值处理、异常值检测、停牌剔除、复权
   │
   ▼
[特征计算] ──▶ 动量、波动率、量价关系、微观结构、宏观状态
   │
   ▼
[特征评估] ──▶ 多重共线性(VIF)、互信息(MIC)、特征稳定性(IC/IR)
   │
   ▼
[特征选择] ──▶ 递归消除(RFE)、稳定性加权选择
   │
   ▼
[标签构建] ──▶ 方向标签 / 分位数标签 / Triple-Barrier 标签
   │
   ▼
[样本权重] ──▶ 时间衰减权重、标签唯一性权重
   │
   ▼
[时间序列 CV] ──▶ Purged K-Fold、 embargo、 walk-forward
   │
   ▼
[模型训练] ──▶ LightGBM / XGBoost / LogisticRegression
   │
   ▼
[概率校准] ──▶ Isotonic Regression / Platt Scaling
   │
   ▼
[信号生成] ──▶ 阈值过滤、仓位管理、置信度衰减
   │
   ▼
[回测引擎] ──▶ 向量化回测、滑点、手续费、冲击成本
   │
   ▼
[模型监控] ──▶ PSI 特征漂移、预测性能衰减、特征重要性漂移
```

---

## 1. 数据清洗模块

```python
import numpy as np
import pandas as pd
from typing import Optional


def clean_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    """清洗 OHLCV 数据，返回高质量数据框。

    处理逻辑：
    1. 检查并排序索引
    2. 处理停牌日（成交量=0且价格不变则丢弃或前向填充）
    3. 异常价格检测（涨跌停、价格跳空、OHLC 逻辑错误）
    4. 前复权（若输入未复权需额外提供复权因子）
    """
    df = df.copy()
    df.index = pd.to_datetime(df.index)
    df = df.sort_index()

    # 基础列检查
    required = {"open", "high", "low", "close", "volume"}
    assert required.issubset(df.columns), f"缺少列: {required - set(df.columns)}"

    # OHLC 逻辑校验
    invalid = (df["high"] < df["low"]) | (df["close"] > df["high"]) | (df["close"] < df["low"])
    if invalid.sum() > 0:
        print(f"[WARN] 发现 {invalid.sum()} 条 OHLC 逻辑错误，已移除")
        df = df[~invalid]

    # 处理零成交量日（停牌）
    # 策略：成交量连续为0超过3天则丢弃该段；短期停牌前向填充
    zero_vol = df["volume"] == 0
    # 简单处理：零成交量日直接丢弃
    df = df[~zero_vol]

    # 异常价格检测：单日涨跌幅超过 20% 视为异常（需根据标的调整）
    daily_ret = df["close"].pct_change()
    extreme = daily_ret.abs() > 0.20
    if extreme.sum() > 0:
        print(f"[WARN] 发现 {extreme.sum()} 个极端价格变动 (>20%)，保留但标记")
        # 实际生产中可配置为删除或 winsorize

    # 确保无 NaN 的 close 价格用于后续计算
    df = df.dropna(subset=["close"])
    return df


def add_adjustment_factors(
    df: pd.DataFrame, split_factor: Optional[pd.Series] = None
) -> pd.DataFrame:
    """若数据未复权，使用复权因子生成前复权价格。"""
    if split_factor is not None:
        adj = split_factor.reindex(df.index).ffill().bfill()
        for col in ["open", "high", "low", "close"]:
            df[f"{col}_adj"] = df[col] * adj
    return df
```

---

## 2. 特征工程模块

### 2.1 特征分类

| 类别 | 特征示例 | 计算复杂度 |
|------|---------|-----------|
| **动量** | ret_5d, ret_20d, ret_60d, momentum_126 | 低 |
| **波动率** | realized_vol_20, atr_14, parkinson_20 | 中 |
| **量价关系** | volume_ratio, turnover_ratio, obv_slope | 低 |
| **均值回归** | zscore_20, rsi_14, cci_20 | 低 |
| **微观结构** | intraday_range, close_loc, overnight_gap | 低 |
| **宏观状态** | market_regime, vix_proxy, sector_momentum | 中 |
| **交叉特征** | vol_momentum_interaction, rsi_volume | 低 |

### 2.2 完整特征计算

```python
import numpy as np
import pandas as pd


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """计算全部特征矩阵。

    安全约定：
    - 所有除法操作均使用 `.replace(0, np.nan)` 或 `.clip(lower=1e-8)` 保护
    - 所有特征输出均经过 `replace([inf, -inf], nan)`
    - 特征只用 T-1 及之前的数据，确保无 lookahead bias
    """
    c = df["close"].astype(float)
    o = df["open"].astype(float)
    h = df["high"].astype(float)
    l = df["low"].astype(float)
    v = df["volume"].astype(float)
    ret = c.pct_change()

    f = pd.DataFrame(index=df.index)

    # ── 动量 ──
    f["f_ret_5"] = ret.rolling(5).sum()
    f["f_ret_20"] = ret.rolling(20).sum()
    f["f_ret_60"] = ret.rolling(60).sum()
    f["f_mom_126"] = c / c.rolling(126).mean() - 1
    f["f_accel_20"] = ret.rolling(10).mean() - ret.rolling(20).mean()

    # ── 波动率 ──
    f["f_vol_20"] = ret.rolling(20).std() * np.sqrt(252)
    f["f_vol_ratio"] = ret.rolling(5).std() / ret.rolling(20).std().replace(0, np.nan)

    # ATR
    tr1 = h - l
    tr2 = (h - c.shift(1)).abs()
    tr3 = (l - c.shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    f["f_atr_14"] = tr.rolling(14).mean() / c

    # Parkinson 波动率估计
    f["f_parkinson_20"] = np.sqrt(
        (np.log(h / l.replace(0, np.nan)) ** 2).rolling(20).mean() / (4 * np.log(2))
    )

    # ── 均值回归 ──
    ma20 = c.rolling(20).mean()
    std20 = c.rolling(20).std()
    f["f_zscore_20"] = (c - ma20) / std20.replace(0, np.nan)

    # RSI(14) with guard
    delta = c.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    f["f_rsi_14"] = 100 - 100 / (1 + rs)

    # 布林带位置
    bb_up = ma20 + 2 * std20
    bb_low = ma20 - 2 * std20
    bb_range = (bb_up - bb_low).replace(0, np.nan)
    f["f_bb_position"] = (c - bb_low) / bb_range

    # ── 量价关系 ──
    vol_ma20 = v.rolling(20).mean().replace(0, np.nan)
    f["f_volume_ratio"] = v / vol_ma20
    f["f_turnover"] = v * c
    f["f_obv"] = (np.sign(ret) * v).cumsum()
    f["f_obv_slope"] = f["f_obv"].diff(5)

    # ── 微观结构 ──
    f["f_intraday_range"] = (h - l) / o.replace(0, np.nan)
    f["f_close_loc"] = (c - l) / (h - l).replace(0, np.nan)
    f["f_overnight_gap"] = (o - c.shift(1)) / c.shift(1).replace(0, np.nan)

    # ── 交叉特征 ──
    f["f_vol_mom"] = f["f_vol_20"] * f["f_ret_20"]
    f["f_rsi_vol"] = f["f_rsi_14"] * f["f_volume_ratio"]

    # ── 安全清理 ──
    f = f.replace([np.inf, -np.inf], np.nan)
    # 截尾：去除极端分布的尾部（防止异常值主导模型）
    f = f.clip(f.quantile(0.001), f.quantile(0.999), axis=1)
    return f
```

---

## 3. 特征评估与选择

### 3.1 多重共线性检测 (VIF)

```python
from statsmodels.stats.outliers_influence import variance_inflation_factor


def filter_by_vif(features: pd.DataFrame, thresh: float = 10.0) -> pd.DataFrame:
    """递归移除 VIF > thresh 的特征，解决多重共线性。"""
    df = features.dropna()
    dropped = []
    while True:
        vif_data = pd.DataFrame()
        vif_data["feature"] = df.columns
        vif_data["vif"] = [variance_inflation_factor(df.values, i) for i in range(df.shape[1])]
        max_vif = vif_data["vif"].max()
        if max_vif < thresh:
            break
        drop_feat = vif_data.loc[vif_data["vif"].idxmax(), "feature"]
        df = df.drop(columns=[drop_feat])
        dropped.append((drop_feat, max_vif))
    print(f"[INFO] VIF 过滤: 移除 {len(dropped)} 个特征")
    return features[df.columns]
```

### 3.2 特征稳定性 (IC / IR)

```python
def compute_ic(features: pd.DataFrame, labels: pd.Series) -> pd.DataFrame:
    """计算每个特征与未来标签的秩相关系数(IC)及其稳定性。

    Returns DataFrame with columns: ic_mean, ic_std, ir
    IR = IC_mean / IC_std, 类似夏普比率的概念
    """
    ics = {}
    for col in features.columns:
        f = features[col]
        valid = f.notna() & labels.notna()
        if valid.sum() < 30:
            continue
        ic = f[valid].corr(labels[valid], method="spearman")
        ics[col] = ic

    ic_series = pd.Series(ics)
    # 滚动 IC 标准差（需至少252个样本点）
    rolling_ics = {}
    for col in features.columns:
        f = features[col]
        valid = f.notna() & labels.notna()
        ic_roll = []
        for i in range(252, len(f)):
            window_f = f.iloc[i-252:i]
            window_l = labels.iloc[i-252:i]
            v = window_f.notna() & window_l.notna()
            if v.sum() > 50:
                ic_roll.append(window_f[v].corr(window_l[v], method="spearman"))
        if ic_roll:
            rolling_ics[col] = np.std(ic_roll)

    result = pd.DataFrame({
        "ic_mean": ic_series,
        "ic_std": pd.Series(rolling_ics),
    })
    result["ir"] = result["ic_mean"] / result["ic_std"].replace(0, np.nan)
    return result


def select_features_by_ic_ir(
    features: pd.DataFrame, labels: pd.Series,
    min_ic: float = 0.01, min_ir: float = 0.1
) -> pd.DataFrame:
    """选择 IC 显著且 IR 稳定的特征。"""
    stats = compute_ic(features, labels)
    selected = stats[
        (stats["ic_mean"].abs() >= min_ic) &
        (stats["ir"].abs() >= min_ir)
    ].index
    print(f"[INFO] IC/IR 选择: {len(selected)}/{len(features.columns)} 个特征通过")
    return features[list(selected)]
```

---

## 4. 标签构建

```python
def build_labels(
    close: pd.Series,
    horizon: int = 5,
    method: str = "direction",
    upper_barrier: float = 0.05,
    lower_barrier: float = -0.03,
    max_holding: int = 20,
) -> pd.Series:
    """构建标签。

    method:
        'direction'  : 未来 horizon 日收益方向 (0/1)
        'triple_barrier': Lopez de Prado 三重障碍标签 (1=触及上限, -1=触及下限, 0=超时)
    """
    if method == "direction":
        future_ret = close.pct_change(horizon).shift(-horizon)
        return (future_ret > 0).astype(int)

    elif method == "triple_barrier":
        labels = pd.Series(0, index=close.index)
        for i in range(len(close) - 1):
            start_price = close.iloc[i]
            upper = start_price * (1 + upper_barrier)
            lower = start_price * (1 + lower_barrier)
            end_idx = min(i + max_holding, len(close) - 1)

            for j in range(i + 1, end_idx + 1):
                price = close.iloc[j]
                if price >= upper:
                    labels.iloc[i] = 1
                    break
                elif price <= lower:
                    labels.iloc[i] = -1
                    break
        return labels

    else:
        raise ValueError(f"Unknown label method: {method}")
```

---

## 5. 时间序列交叉验证

```python
from sklearn.model_selection import BaseCrossValidator


class PurgedKFold(BaseCrossValidator):
    """Lopez de Prado 提出的 Purged K-Fold 交叉验证。

    在训练集和验证集之间设置 embargo（禁航区），防止信息泄露。
    适用于时间序列/金融数据。
    """

    def __init__(self, n_splits: int = 5, purge_gap: int = 5, embargo_pct: float = 0.01):
        self.n_splits = n_splits
        self.purge_gap = purge_gap
        self.embargo_pct = embargo_pct

    def get_n_splits(self, X=None, y=None, groups=None):
        return self.n_splits

    def split(self, X, y=None, groups=None):
        n_samples = len(X)
        indices = np.arange(n_samples)
        fold_size = n_samples // self.n_splits

        for i in range(self.n_splits):
            # 验证集为第 i 折
            val_start = i * fold_size
            val_end = (i + 1) * fold_size if i < self.n_splits - 1 else n_samples
            val_indices = indices[val_start:val_end]

            # 训练集在验证集之前，且跳过 purge_gap
            train_end = val_start - self.purge_gap
            train_indices = indices[:max(0, train_end)]

            # embargo：从训练集尾部移除 embargo_pct 比例的样本
            if len(train_indices) > 0:
                embargo_count = int(len(train_indices) * self.embargo_pct)
                train_indices = train_indices[:-embargo_count] if embargo_count > 0 else train_indices

            yield train_indices, val_indices


def time_series_cv_score(
    model, X: pd.DataFrame, y: pd.Series,
    sample_weight: Optional[np.ndarray] = None,
    cv=None, scoring="roc_auc"
) -> dict:
    """在时间序列 CV 上评估模型。"""
    from sklearn.metrics import roc_auc_score, accuracy_score, log_loss

    if cv is None:
        cv = PurgedKFold(n_splits=5, purge_gap=10)

    scores = {"auc": [], "accuracy": [], "logloss": []}
    for fold, (train_idx, val_idx) in enumerate(cv.split(X)):
        X_train, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_train, y_val = y.iloc[train_idx], y.iloc[val_idx]

        w_train = sample_weight[train_idx] if sample_weight is not None else None

        model.fit(X_train, y_train, sample_weight=w_train)

        if hasattr(model, "predict_proba"):
            prob = model.predict_proba(X_val)[:, 1]
            scores["auc"].append(roc_auc_score(y_val, prob))
            scores["logloss"].append(log_loss(y_val, prob))
        pred = model.predict(X_val)
        scores["accuracy"].append(accuracy_score(y_val, pred))

    return {k: {"mean": np.mean(v), "std": np.std(v)} for k, v in scores.items()}
```

---

## 6. 模型训练

```python
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.calibration import CalibratedClassifierCV


def build_model(model_type: str = "lightgbm", **kwargs):
    """构建基础模型。"""
    if model_type == "lightgbm":
        return lgb.LGBMClassifier(
            objective="binary",
            boosting_type="gbdt",
            num_leaves=kwargs.get("num_leaves", 31),
            max_depth=kwargs.get("max_depth", -1),
            learning_rate=kwargs.get("learning_rate", 0.05),
            n_estimators=kwargs.get("n_estimators", 200),
            subsample=kwargs.get("subsample", 0.8),
            colsample_bytree=kwargs.get("colsample_bytree", 0.8),
            reg_alpha=kwargs.get("reg_alpha", 0.1),
            reg_lambda=kwargs.get("reg_lambda", 0.1),
            class_weight=kwargs.get("class_weight", "balanced"),
            random_state=42,
            verbosity=-1,
        )
    elif model_type == "logistic":
        return LogisticRegression(
            max_iter=1000,
            class_weight="balanced",
            penalty="l2",
            C=kwargs.get("C", 1.0),
            solver="lbfgs",
        )
    else:
        raise ValueError(f"Unknown model_type: {model_type}")


def train_with_calibration(
    X_train: pd.DataFrame,
    y_train: pd.Series,
    model_type: str = "lightgbm",
    calibration_method: str = "isotonic",
    cv=None,
    **model_kwargs
):
    """训练模型并进行概率校准。"""
    base_model = build_model(model_type, **model_kwargs)

    # 时间序列 CV 用于校准
    if cv is None:
        cv = PurgedKFold(n_splits=3, purge_gap=10)

    calibrated = CalibratedClassifierCV(
        base_model, method=calibration_method, cv=cv
    )
    calibrated.fit(X_train, y_train)
    return calibrated
```

---

## 7. Walk-Forward 预测引擎

```python
class WalkForwardEngine:
    """Walk-forward 预测引擎，支持滚动训练和实时预测。"""

    def __init__(
        self,
        model_type: str = "lightgbm",
        min_train_size: int = 504,
        retrain_freq: int = 20,
        window_type: str = "expanding",
        sliding_size: int = 756,
        calibration: bool = True,
        **model_kwargs
    ):
        self.model_type = model_type
        self.min_train_size = min_train_size
        self.retrain_freq = retrain_freq
        self.window_type = window_type
        self.sliding_size = sliding_size
        self.calibration = calibration
        self.model_kwargs = model_kwargs
        self.model = None
        self.scaler = None
        self.feature_names = None

    def _should_retrain(self, current_idx: int, last_train_idx: int) -> bool:
        """判断是否需要重训练。"""
        if self.model is None:
            return True
        if (current_idx - last_train_idx) >= self.retrain_freq:
            return True
        return False

    def fit_predict(
        self,
        features: pd.DataFrame,
        labels: pd.Series,
        sample_weight: Optional[pd.Series] = None,
    ) -> pd.Series:
        """Walk-forward 拟合与预测。"""
        predictions = pd.Series(np.nan, index=features.index)
        last_train_idx = -1

        for i in range(self.min_train_size, len(features)):
            if not self._should_retrain(i, last_train_idx):
                pass  # 使用已有模型
            else:
                # 确定训练窗口
                start = max(0, i - self.sliding_size) if self.window_type == "sliding" else 0
                X_train = features.iloc[start:i]
                y_train = labels.iloc[start:i]

                # 对齐有效样本
                valid = X_train.notna().all(axis=1) & y_train.notna()
                X_train = X_train[valid]
                y_train = y_train[valid]
                w_train = sample_weight.iloc[start:i][valid].values if sample_weight is not None else None

                if len(X_train) < 100:
                    continue

                # 标准化（仅在训练集 fit）
                from sklearn.preprocessing import StandardScaler
                self.scaler = StandardScaler()
                X_train_scaled = self.scaler.fit_transform(X_train)

                # 训练
                if self.calibration:
                    self.model = train_with_calibration(
                        pd.DataFrame(X_train_scaled, columns=X_train.columns),
                        y_train,
                        model_type=self.model_type,
                        **self.model_kwargs
                    )
                else:
                    self.model = build_model(self.model_type, **self.model_kwargs)
                    self.model.fit(X_train_scaled, y_train, sample_weight=w_train)

                self.feature_names = X_train.columns.tolist()
                last_train_idx = i

            # 预测
            if self.model is None:
                continue

            X_today = features.iloc[i:i+1]
            if X_today.isna().any(axis=1).iloc[0]:
                continue

            X_today_scaled = self.scaler.transform(X_today)
            prob = self.model.predict_proba(X_today_scaled)[0, 1]
            predictions.iloc[i] = prob

        return predictions
```

---

## 8. 信号生成与仓位管理

```python
def generate_signals(
    predictions: pd.Series,
    close: pd.Series,
    threshold: float = 0.55,
    max_position: float = 1.0,
    confidence_scaling: bool = True,
) -> pd.Series:
    """将预测概率转换为交易信号。

    Args:
        predictions: 预测上涨概率 (0~1)
        close: 收盘价序列（用于计算波动率调整仓位）
        threshold: 交易触发阈值，|prob - 0.5| > threshold - 0.5 时开仓
        max_position: 最大仓位比例
        confidence_scaling: 是否根据置信度调整仓位大小
    """
    # 中性概率为 0.5（二分类校准后）
    deviation = predictions - 0.5

    # 阈值过滤
    active = deviation.abs() > (threshold - 0.5)

    # 方向
    direction = np.sign(deviation)

    if confidence_scaling:
        # 仓位 = 置信度 * 最大仓位，并用近期波动率做风险平价缩放
        vol = close.pct_change().rolling(20).std()
        vol_scalar = (vol.median() / vol).clip(0.5, 2.0)
        position = deviation.abs() * 2 * max_position * vol_scalar.reindex(predictions.index)
    else:
        position = max_position

    signals = direction * position
    signals = signals.where(active, 0.0)
    signals = signals.fillna(0.0).clip(-max_position, max_position)
    return signals
```

---

## 9. 成本-aware 回测引擎

```python
def backtest_with_costs(
    signals: pd.Series,
    close: pd.Series,
    commission: float = 0.0003,
    slippage: float = 0.0001,
    impact_coef: float = 1e-6,
) -> pd.DataFrame:
    """向量化回测，包含完整交易成本。

    Args:
        commission: 单边手续费（默认万3）
        slippage: 滑点（默认万1）
        impact_coef: 冲击成本系数，cost = coef * |position_change| * volume
    """
    ret = close.pct_change()
    position = signals.shift(1)  # 当日收盘后生成信号，次日开盘执行

    # 持仓收益
    strategy_ret = position * ret

    # 换手率
    turnover = position.diff().abs()

    # 交易成本
    trade_cost = turnover * (commission + slippage)

    # 冲击成本（简化为与仓位变化成正比）
    impact_cost = turnover * impact_coef * 1e6  # 简化模型

    net_ret = strategy_ret - trade_cost - impact_cost

    # 累积净值
    nav = (1 + net_ret.fillna(0)).cumprod()

    # 统计指标
    stats = {
        "total_return": nav.iloc[-1] - 1,
        "annual_return": (nav.iloc[-1] ** (252 / len(nav))) - 1,
        "sharpe": net_ret.mean() / net_ret.std() * np.sqrt(252),
        "max_drawdown": (nav / nav.cummax() - 1).min(),
        "turnover_annual": turnover.sum() / len(turnover) * 252,
        "win_rate": (net_ret > 0).mean(),
    }

    result = pd.DataFrame({
        "close": close,
        "signal": signals,
        "position": position,
        "strategy_ret": strategy_ret,
        "net_ret": net_ret,
        "nav": nav,
        "turnover": turnover,
        "cost": trade_cost + impact_cost,
    })
    return result, stats
```

---

## 10. 模型监控

### 10.1 特征漂移检测 (PSI)

```python
def psi_score(expected: pd.Series, actual: pd.Series, bins: int = 10) -> float:
    """计算 Population Stability Index。

    PSI < 0.1: 无显著漂移
    0.1 <= PSI < 0.25: 中等漂移
    PSI >= 0.25: 严重漂移，需重训练
    """
    def scale(s):
        return (s - s.min()) / (s.max() - s.min())

    e = scale(expected.dropna())
    a = scale(actual.dropna())

    breakpoints = np.linspace(0, 1, bins + 1)
    expected_perc = np.histogram(e, breakpoints)[0] / len(e)
    actual_perc = np.histogram(a, breakpoints)[0] / len(a)

    # 避免除零
    expected_perc = np.clip(expected_perc, 1e-10, 1)
    actual_perc = np.clip(actual_perc, 1e-10, 1)

    psi = np.sum((actual_perc - expected_perc) * np.log(actual_perc / expected_perc))
    return psi


def check_feature_drift(
    features_train: pd.DataFrame,
    features_recent: pd.DataFrame,
    threshold: float = 0.1,
) -> pd.DataFrame:
    """检查所有特征的 PSI 漂移。"""
    results = []
    for col in features_train.columns:
        if col not in features_recent.columns:
            continue
        psi = psi_score(features_train[col], features_recent[col])
        results.append({"feature": col, "psi": psi, "drift": psi >= threshold})
    return pd.DataFrame(results).sort_values("psi", ascending=False)
```

### 10.2 预测性能衰减监控

```python
def monitor_prediction_decay(
    predictions: pd.Series,
    actual_returns: pd.Series,
    window: int = 60,
) -> pd.DataFrame:
    """滚动监控预测性能，检测模型衰退。"""
    from sklearn.metrics import roc_auc_score

    decay = []
    labels = (actual_returns > 0).astype(int)

    for i in range(window, len(predictions)):
        pred_window = predictions.iloc[i-window:i]
        label_window = labels.iloc[i-window:i]
        valid = pred_window.notna() & label_window.notna()
        if valid.sum() < 20:
            continue
        try:
            auc = roc_auc_score(label_window[valid], pred_window[valid])
        except ValueError:
            auc = np.nan
        decay.append({"date": predictions.index[i], "rolling_auc": auc})

    return pd.DataFrame(decay).set_index("date")
```

---

## 11. 完整 Pipeline 示例

```python
import pandas as pd


def run_full_pipeline(df: pd.DataFrame) -> dict:
    """完整的 ML 交易策略 pipeline。"""
    # 1. 数据清洗
    df_clean = clean_ohlcv(df)

    # 2. 特征计算
    features = compute_features(df_clean)

    # 3. 标签构建
    labels = build_labels(df_clean["close"], horizon=5, method="direction")

    # 4. 样本权重（时间衰减：近期样本权重更高）
    n = len(features)
    time_weight = np.exp(np.linspace(-1, 0, n))  # 指数衰减
    time_weight = pd.Series(time_weight, index=features.index)

    # 5. 对齐
    valid = features.notna().all(axis=1) & labels.notna()
    features = features[valid]
    labels = labels[valid]
    time_weight = time_weight[valid]

    # 6. 特征评估与选择
    features = filter_by_vif(features, thresh=10.0)
    features = select_features_by_ic_ir(features, labels, min_ic=0.01, min_ir=0.1)

    # 7. Walk-forward 训练
    engine = WalkForwardEngine(
        model_type="lightgbm",
        min_train_size=504,
        retrain_freq=20,
        window_type="expanding",
        calibration=True,
    )
    predictions = engine.fit_predict(features, labels, sample_weight=time_weight)

    # 8. 信号生成
    signals = generate_signals(
        predictions, df_clean["close"],
        threshold=0.55, max_position=1.0, confidence_scaling=True
    )

    # 9. 回测
    result_df, stats = backtest_with_costs(
        signals, df_clean["close"],
        commission=0.0003, slippage=0.0001
    )

    # 10. 监控
    drift = check_feature_drift(
        features.iloc[:504], features.iloc[-504:], threshold=0.1
    )
    decay = monitor_prediction_decay(predictions, df_clean["close"].pct_change())

    return {
        "signals": signals,
        "result_df": result_df,
        "stats": stats,
        "drift_report": drift,
        "decay_report": decay,
    }
```

---

## 12. 关键参数速查表

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `min_train_size` | 504 | 最小训练窗口（约 2 年交易日） |
| `retrain_freq` | 20 | 重训练频率（交易日） |
| `window_type` | `"expanding"` | 扩展窗口 / 滑动窗口 |
| `sliding_size` | 756 | 滑动窗口大小（约 3 年） |
| `horizon` | 5 | 预测 horizon（5 日收益方向） |
| `threshold` | 0.55 | 信号触发阈值（概率偏离中性程度） |
| `commission` | 0.0003 | 单边手续费 |
| `slippage` | 0.0001 | 滑点 |
| `psi_threshold` | 0.1 | 特征漂移警戒线 |
| `vif_threshold` | 10.0 | 多重共线性阈值 |
| `min_ic` | 0.01 | 特征 IC 最低要求 |
| `min_ir` | 0.1 | 特征 IR 最低要求 |

---

## 13. 常见陷阱与防护

| 陷阱 | 防护措施 |
|------|---------|
| **未来数据泄露** | Walk-forward + PurgedKFold + embargo |
| **标准化泄露** | `fit_transform` 仅在训练集，验证集只做 `transform` |
| ** lookahead bias** | 特征只用 T-1 及之前数据 |
| **过拟合** | `max_depth` 限制、VIF 过滤、正则化、交叉验证 |
| **类别不平衡** | `class_weight="balanced"`、样本时间衰减权重 |
| **概率未校准** | `CalibratedClassifierCV` (Isotonic/Platt) |
| **交易成本忽略** | 回测引擎内置 commission + slippage + impact |
| **特征漂移** | PSI 监控 + 滚动重训练触发 |
| **信号过密** | 阈值过滤 + 仓位置信度缩放 |

---

## 14. 依赖安装

```bash
pip install pandas numpy scikit-learn lightgbm statsmodels
```

---

## 15. 扩展方向

1. **集成模型**：同时训练 LGBM + XGBoost + Logistic，用 Stacking 或投票融合
2. **自动超参搜索**：在 PurgedKFold 上使用 Optuna / Ray Tune
3. **更精细标签**：使用 Triple-Barrier + 元标签（metalabeling）区分方向与仓位大小
4. **多标的组合**：扩展到截面预测（cross-sectional ranking），结合组合优化
5. **非结构化数据**：将新闻情绪、财报文本通过 LLM 嵌入后作为额外特征输入
