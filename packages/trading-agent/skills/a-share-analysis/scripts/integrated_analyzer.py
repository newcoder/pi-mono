#!/usr/bin/env python3
"""
A股综合分析模块
整合技术分析、基本面分析、估值分析，提供多维度综合评估
支持因果推理、异常归因、趋势延续性判断

依赖: pip install pandas numpy
"""

import argparse
import json
import os
import sys
from typing import Dict, List, Optional
from datetime import datetime

try:
    import pandas as pd
    import numpy as np
except ImportError:
    print("错误: 请先安装依赖库")
    print("pip install pandas numpy")
    sys.exit(1)

# Import sibling modules
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if _SCRIPT_DIR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR)

from data_fetcher import fetch_stock_data, safe_float
from financial_analyzer import FinancialAnalyzer
from valuation_calculator import ValuationCalculator
from technical_analyzer import TechnicalAnalyzer


class IntegratedAnalyzer:
    """综合分析器：整合技术面+基本面+估值"""

    def __init__(self, code: str, name: str = ""):
        self.code = code
        self.name = name
        self.stock_data = {}
        self.financial_analyzer = None
        self.valuation_calculator = None
        self.technical_analyzer = None

    def load_data(self, data_type: str = "all", years: int = 3, use_cache: bool = True) -> bool:
        """加载股票数据（复用data_fetcher的混合数据源）."""
        try:
            self.stock_data = fetch_stock_data(
                self.code,
                data_type=data_type,
                years=years,
                use_cache=use_cache,
            )
            if "error" in self.stock_data and not self.stock_data.get("basic_info"):
                return False

            self.financial_analyzer = FinancialAnalyzer(self.stock_data)
            self.valuation_calculator = ValuationCalculator(self.stock_data)
            self.technical_analyzer = TechnicalAnalyzer(self.code, self.name)
            return True
        except Exception as e:
            print(f"数据加载失败: {e}")
            return False

    def analyze(self, level: str = "standard") -> Dict:
        """
        执行综合分析.

        level:
            - summary: 简要结论
            - standard: 标准分析（技术+基本面+估值）
            - deep: 深度分析（增加归因、因果推理、趋势判断）
        """
        result = {
            "code": self.code,
            "name": self.name or self.stock_data.get("basic_info", {}).get("name", ""),
            "analysis_date": datetime.now().isoformat(),
            "level": level,
        }

        # 1. 技术分析
        tech_result = self._run_technical_analysis()
        result["technical_analysis"] = tech_result

        # 2. 基本面分析
        fund_result = self.financial_analyzer.generate_summary(level=level)
        result["fundamental_analysis"] = fund_result

        # 3. 估值分析
        val_result = self.valuation_calculator.comprehensive_valuation()
        result["valuation"] = val_result

        # 4. 综合评分与判断
        result["integrated_assessment"] = self._integrated_assessment(
            tech_result, fund_result, val_result
        )

        # 5. 深度分析特有：因果推理与趋势判断
        if level == "deep":
            result["causal_analysis"] = self._causal_analysis(tech_result, fund_result)
            result["trend_continuation"] = self._trend_continuation_analysis(tech_result, fund_result)
            result["risk_scenarios"] = self._risk_scenario_analysis(fund_result, val_result)

        return result

    def _run_technical_analysis(self) -> Dict:
        """执行技术分析."""
        if not self.technical_analyzer:
            return {"error": "technical analyzer not initialized"}

        if not self.technical_analyzer.load_data(days=120):
            return {"error": "无法获取K线数据"}

        return self.technical_analyzer.full_analysis()

    def _integrated_assessment(self, tech: Dict, fund: Dict, val: Dict) -> Dict:
        """
        综合评估：将技术、基本面、估值整合为统一结论.
        """
        assessment = {
            "overall_direction": "neutral",
            "confidence": "low",
            "key_factors": [],
            "contradictions": [],
            "recommendation": "",
        }

        # --- 技术面信号 ---
        tech_signals = []
        tech_bullish = 0
        tech_bearish = 0

        trend = tech.get("trend_analysis", {})
        overall = trend.get("overall_trend", "neutral")
        if overall in ("bullish", "short_bullish"):
            tech_signals.append("技术面偏多")
            tech_bullish += 1
        elif overall in ("bearish", "short_bearish"):
            tech_signals.append("技术面偏空")
            tech_bearish += 1

        rsi_state = trend.get("rsi", {}).get("state", "")
        if rsi_state == "oversold":
            tech_signals.append("RSI超卖，存在反弹机会")
            tech_bullish += 1
        elif rsi_state == "overbought":
            tech_signals.append("RSI超买，短期回调风险")
            tech_bearish += 1

        macd = trend.get("macd", {})
        if macd.get("signal") == "golden_cross":
            tech_signals.append("MACD金叉")
            tech_bullish += 1
        elif macd.get("signal") == "death_cross":
            tech_signals.append("MACD死叉")
            tech_bearish += 1

        bias = trend.get("bias", {})
        if bias.get("state") == "severely_oversold":
            tech_signals.append("乖离率严重超跌")
            tech_bullish += 1
        elif bias.get("state") == "severely_overbought":
            tech_signals.append("乖离率严重超买")
            tech_bearish += 1

        # --- 基本面信号 ---
        fund_signals = []
        fund_score = fund.get("score", 50)
        if fund_score >= 70:
            fund_signals.append(f"基本面优秀(评分{fund_score})")
        elif fund_score >= 50:
            fund_signals.append(f"基本面良好(评分{fund_score})")
        else:
            fund_signals.append(f"基本面较弱(评分{fund_score})")

        # 成长性
        growth = fund.get("growth", {})
        if isinstance(growth, dict):
            avg_growth = growth.get("metrics", {}).get("平均净利润增长率")
            if avg_growth is not None:
                if avg_growth > 20:
                    fund_signals.append(f"高成长(净利润增速{avg_growth:.1f}%)")
                elif avg_growth < 0:
                    fund_signals.append(f"业绩下滑(净利润增速{avg_growth:.1f}%)")

        # 异常风险
        anomalies = fund.get("anomalies", {})
        if isinstance(anomalies, dict) and anomalies.get("risk_level") == "高":
            fund_signals.append("财务风险高")

        # 利润归因
        profit_attr = fund.get("profit_attribution", {})
        if isinstance(profit_attr, dict):
            change_pct = profit_attr.get("profit_change", {}).get("change_pct")
            if change_pct is not None and change_pct < -20:
                fund_signals.append(f"利润大幅下滑({change_pct}%)")
            elif change_pct is not None and change_pct > 30:
                fund_signals.append(f"利润大幅增长({change_pct}%)")

        # --- 估值信号 ---
        val_signals = []
        summary = val.get("summary", {})
        margin = summary.get("安全边际分析", {})
        conclusion = margin.get("conclusion", "")
        if "低估" in conclusion:
            val_signals.append("估值低估")
        elif "高估" in conclusion:
            val_signals.append("估值偏高")
        else:
            val_signals.append("估值合理")

        # 相对估值分位
        relative = val.get("methods", {}).get("相对估值", {})
        pe_pct = relative.get("comparison", {}).get("PE历史分位数")
        if pe_pct is not None:
            if pe_pct < 30:
                val_signals.append(f"PE处于历史低位({pe_pct}%分位)")
            elif pe_pct > 70:
                val_signals.append(f"PE处于历史高位({pe_pct}%分位)")

        # --- 综合判断 ---
        assessment["key_factors"] = tech_signals + fund_signals + val_signals

        # 方向判断
        bullish_count = tech_bullish + (1 if fund_score >= 60 else 0) + (1 if "低估" in str(val_signals) else 0)
        bearish_count = tech_bearish + (1 if fund_score < 50 else 0) + (1 if "高估" in str(val_signals) else 0)

        if bullish_count >= 3 and bearish_count <= 1:
            assessment["overall_direction"] = "bullish"
            assessment["confidence"] = "high" if bullish_count >= 4 else "medium"
        elif bearish_count >= 3 and bullish_count <= 1:
            assessment["overall_direction"] = "bearish"
            assessment["confidence"] = "high" if bearish_count >= 4 else "medium"
        elif bullish_count > bearish_count:
            assessment["overall_direction"] = "slightly_bullish"
            assessment["confidence"] = "medium"
        elif bearish_count > bullish_count:
            assessment["overall_direction"] = "slightly_bearish"
            assessment["confidence"] = "medium"

        # 矛盾检测
        contradictions = []
        if tech_bullish > 0 and fund_score < 50:
            contradictions.append("技术面偏多但基本面较弱，存在基本面风险")
        if tech_bearish > 0 and fund_score >= 70:
            contradictions.append("技术面偏空但基本面优秀，可能是短期回调")
        if "低估" in str(val_signals) and fund_score < 50:
            contradictions.append("估值低但基本面弱，警惕价值陷阱")
        if "高估" in str(val_signals) and fund_score >= 70:
            contradictions.append("估值高但基本面好，关注估值回归风险")
        assessment["contradictions"] = contradictions

        # 建议
        direction_map = {
            "bullish": "看多",
            "slightly_bullish": "偏多",
            "neutral": "中性观望",
            "slightly_bearish": "偏空",
            "bearish": "看空",
        }
        assessment["recommendation"] = direction_map.get(assessment["overall_direction"], "观望")

        return assessment

    def _causal_analysis(self, tech: Dict, fund: Dict) -> Dict:
        """
        因果推理分析：探究现象背后的原因.
        例如：股价下跌是因为业绩下滑，还是估值回归？
        """
        result = {
            "price_fundamental_alignment": "",
            "primary_cause": "",
            "supporting_evidence": [],
            "counter_evidence": [],
        }

        # 股价与基本面匹配度
        momentum = tech.get("momentum_analysis", {})
        gain_20d = momentum.get("gain_20d")

        profit_attr = fund.get("profit_attribution", {})
        change_pct = profit_attr.get("profit_change", {}).get("change_pct")

        if gain_20d is not None and change_pct is not None:
            if gain_20d < -10 and change_pct < -20:
                result["price_fundamental_alignment"] = "同步下行 - 股价下跌反映业绩恶化"
                result["primary_cause"] = "基本面驱动 - 业绩大幅下滑导致股价下跌"
                result["supporting_evidence"].append(f"20日跌幅{gain_20d}% vs 利润下滑{change_pct}%")
            elif gain_20d < -10 and change_pct > 0:
                result["price_fundamental_alignment"] = "背离 - 股价下跌但业绩改善"
                result["primary_cause"] = "情绪/估值驱动 - 市场过度悲观或估值压缩"
                result["supporting_evidence"].append(f"20日跌幅{gain_20d}% 但利润增长{change_pct}%")
            elif gain_20d > 10 and change_pct < -20:
                result["price_fundamental_alignment"] = "背离 - 股价上涨但业绩恶化"
                result["primary_cause"] = "情绪/题材驱动 - 脱离基本面的概念炒作"
                result["supporting_evidence"].append(f"20日涨幅{gain_20d}% 但利润下滑{change_pct}%")
            elif gain_20d > 10 and change_pct > 20:
                result["price_fundamental_alignment"] = "同步上行 - 股价上涨反映业绩改善"
                result["primary_cause"] = "基本面驱动 - 业绩高增长支撑股价"
                result["supporting_evidence"].append(f"20日涨幅{gain_20d}% vs 利润增长{change_pct}%")
            else:
                result["price_fundamental_alignment"] = "弱相关 - 股价与基本面变动都不显著"

        # 检查利润质量
        profit_quality = fund.get("profit_quality", {})
        if isinstance(profit_quality, dict):
            warnings = profit_quality.get("warnings", [])
            if warnings:
                result["supporting_evidence"].extend(warnings)
            ocf_ratio = profit_quality.get("metrics", {}).get("经营现金流/净利润")
            if ocf_ratio is not None and ocf_ratio < 0.5:
                result["counter_evidence"].append(f"经营现金流/净利润={ocf_ratio}，利润含金量不足")

        # 杜邦分析驱动因素
        dupont = fund.get("dupont", {})
        if isinstance(dupont, dict):
            driver = dupont.get("driver", "")
            if driver:
                result["supporting_evidence"].append(driver)

        return result

    def _trend_continuation_analysis(self, tech: Dict, fund: Dict) -> Dict:
        """
        趋势延续性分析：判断当前趋势能否持续.
        """
        result = {
            "trend_sustainability": "uncertain",
            "supporting_factors": [],
            "risk_factors": [],
            "time_horizon": "",
        }

        trend = tech.get("trend_analysis", {})
        overall = trend.get("overall_trend", "neutral")

        # 技术面趋势延续性
        macd = trend.get("macd", {})
        if macd.get("signal") in ("bullish_expanding", "bearish_expanding"):
            result["supporting_factors"].append("MACD动量增强，趋势可能延续")
        elif macd.get("signal") in ("bullish_contracting", "bearish_contracting"):
            result["risk_factors"].append("MACD动量减弱，趋势可能反转")

        rsi = trend.get("rsi", {})
        rsi_state = rsi.get("state", "")
        if rsi_state == "overbought":
            result["risk_factors"].append("RSI超买，短期回调概率大")
        elif rsi_state == "oversold":
            result["supporting_factors"].append("RSI超卖，反弹概率大")

        # 基本面支撑
        growth = fund.get("growth", {})
        if isinstance(growth, dict):
            avg_growth = growth.get("metrics", {}).get("平均净利润增长率")
            if avg_growth is not None:
                if avg_growth > 20:
                    result["supporting_factors"].append(f"业绩高成长({avg_growth:.1f}%)，支撑中长期趋势")
                    result["time_horizon"] = "中长期看好"
                elif avg_growth < 0:
                    result["risk_factors"].append(f"业绩下滑({avg_growth:.1f}%)，趋势难以持续")
                    result["time_horizon"] = "短期反弹，中期谨慎"

        # 利润质量
        profit_quality = fund.get("profit_quality", {})
        if isinstance(profit_quality, dict):
            if profit_quality.get("warnings"):
                result["risk_factors"].append("利润质量存在隐患，趋势可靠性存疑")

        # 综合判断
        support = len(result["supporting_factors"])
        risk = len(result["risk_factors"])

        if support >= 2 and risk == 0:
            result["trend_sustainability"] = "high"
        elif support > risk:
            result["trend_sustainability"] = "medium"
        elif risk > support:
            result["trend_sustainability"] = "low"
        else:
            result["trend_sustainability"] = "uncertain"

        if not result["time_horizon"]:
            if overall in ("bullish", "short_bullish"):
                result["time_horizon"] = "短期偏多"
            elif overall in ("bearish", "short_bearish"):
                result["time_horizon"] = "短期偏空"
            else:
                result["time_horizon"] = "震荡整理"

        return result

    def _risk_scenario_analysis(self, fund: Dict, val: Dict) -> Dict:
        """
        风险情景分析：在什么情况下投资逻辑会被破坏.
        """
        result = {
            "bull_case": {"scenario": "", "conditions": [], "probability": "low"},
            "base_case": {"scenario": "", "conditions": [], "probability": "medium"},
            "bear_case": {"scenario": "", "conditions": [], "probability": "low"},
        }

        # 基本情况
        fund_score = fund.get("score", 50)
        val_summary = val.get("summary", {})
        margin = val_summary.get("安全边际分析", {})
        conclusion = margin.get("conclusion", "")

        result["base_case"]["scenario"] = "维持现状"
        result["base_case"]["conditions"].append(f"基本面评分维持{fund_score}分")
        result["base_case"]["probability"] = "medium"

        # 乐观情况
        result["bull_case"]["scenario"] = "业绩超预期+估值修复"
        growth = fund.get("growth", {})
        if isinstance(growth, dict):
            avg_growth = growth.get("metrics", {}).get("平均净利润增长率")
            if avg_growth is not None:
                result["bull_case"]["conditions"].append(f"净利润增速从{avg_growth:.1f}%提升至{avg_growth*1.5:.1f}%")
        result["bull_case"]["conditions"].append("市场情绪改善，估值中枢上移")
        result["bull_case"]["probability"] = "low"

        # 悲观情况
        result["bear_case"]["scenario"] = "业绩恶化+估值下杀"
        anomalies = fund.get("anomalies", {})
        if isinstance(anomalies, dict) and anomalies.get("signals"):
            for sig in anomalies["signals"][:2]:
                result["bear_case"]["conditions"].append(sig.get("description", ""))
        profit_attr = fund.get("profit_attribution", {})
        if isinstance(profit_attr, dict):
            change_pct = profit_attr.get("profit_change", {}).get("change_pct")
            if change_pct is not None and change_pct < 0:
                result["bear_case"]["conditions"].append(f"利润继续下滑({change_pct}%基础上再降)")
        result["bear_case"]["conditions"].append("市场系统性风险导致估值压缩")
        result["bear_case"]["probability"] = "low"

        # 根据基本面调整概率
        if fund_score >= 70 and "低估" in conclusion:
            result["bull_case"]["probability"] = "medium"
            result["bear_case"]["probability"] = "low"
        elif fund_score < 50:
            result["bull_case"]["probability"] = "low"
            result["bear_case"]["probability"] = "medium"

        return result


def main():
    parser = argparse.ArgumentParser(description="A股综合分析器")
    parser.add_argument("--code", type=str, required=True, help="股票代码")
    parser.add_argument("--name", type=str, default="", help="股票名称")
    parser.add_argument("--level", type=str, default="standard",
                       choices=["summary", "standard", "deep"],
                       help="分析深度级别")
    parser.add_argument("--years", type=int, default=3, help="财报数据年数")
    parser.add_argument("--no-cache", action="store_true", help="不使用缓存")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    analyzer = IntegratedAnalyzer(args.code, args.name)
    print(f"正在加载 {args.code} 的数据...")

    if not analyzer.load_data(data_type="all", years=args.years, use_cache=not args.no_cache):
        print("数据加载失败")
        sys.exit(1)

    print(f"正在执行 {args.level} 级别分析...")
    result = analyzer.analyze(level=args.level)

    output_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(output_json)
        print(f"综合分析结果已保存到: {args.output}")
    else:
        print(output_json)


if __name__ == "__main__":
    main()
