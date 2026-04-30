#!/usr/bin/env python3
"""
A股财务分析模块
提供财务健康度分析、杜邦分析、异常检测等功能

依赖: pip install akshare pandas numpy
"""

import argparse
import json
import sys
from datetime import datetime
from typing import Optional, List, Dict

try:
    import pandas as pd
    import numpy as np
except ImportError:
    print("错误: 请先安装依赖库")
    print("pip install pandas numpy")
    sys.exit(1)


class FinancialAnalyzer:
    """财务分析器"""

    def __init__(self, stock_data: Dict = None):
        self.stock_data = stock_data or {}
        self.analysis_result = {}

    def load_data(self, file_path: str):
        """从JSON文件加载股票数据"""
        with open(file_path, 'r', encoding='utf-8') as f:
            self.stock_data = json.load(f)

    def _assess_roe(self, roe: float) -> str:
        """根据ROE评估盈利能力"""
        if roe > 20:
            return "优秀 - ROE超过20%，盈利能力很强"
        elif roe > 15:
            return "良好 - ROE在15-20%之间，盈利能力较强"
        elif roe > 10:
            return "一般 - ROE在10-15%之间，盈利能力中等"
        return "较弱 - ROE低于10%，盈利能力需要改善"

    def analyze_profitability(self) -> Dict:
        """盈利能力分析"""
        result = {
            "category": "盈利能力",
            "metrics": {},
            "trend": [],
            "assessment": ""
        }

        indicators = self.stock_data.get('financial_indicators', [])
        if not indicators:
            return result

        metrics = {}
        for indicator in indicators[:8]:
            period = indicator.get('日期', '')
            if period:
                metrics[period] = {
                    "ROE": self._safe_float(indicator.get('净资产收益率', indicator.get('加权净资产收益率'))),
                    "ROA": self._safe_float(indicator.get('总资产报酬率')),
                    "毛利率": self._safe_float(indicator.get('销售毛利率')),
                    "净利率": self._safe_float(indicator.get('销售净利率'))
                }

        if not metrics:
            return result

        latest = list(metrics.values())[0]
        result["metrics"] = {
            "当前ROE": latest.get("ROE"),
            "当前ROA": latest.get("ROA"),
            "当前毛利率": latest.get("毛利率"),
            "当前净利率": latest.get("净利率")
        }

        roe_values = [v.get("ROE") for v in metrics.values() if v.get("ROE") is not None]
        if len(roe_values) >= 2:
            trend = "上升" if roe_values[0] > roe_values[-1] else "下降"
            result["trend"].append(f"ROE呈{trend}趋势")

        roe = latest.get("ROE")
        if roe:
            result["assessment"] = self._assess_roe(roe)

        return result

    def analyze_solvency(self) -> Dict:
        """偿债能力分析"""
        result = {
            "category": "偿债能力",
            "metrics": {},
            "risks": [],
            "assessment": ""
        }

        indicators = self.stock_data.get('financial_indicators', [])
        if not indicators:
            return result

        latest = indicators[0]

        debt_ratio = self._safe_float(latest.get('资产负债率'))
        current_ratio = self._safe_float(latest.get('流动比率'))
        quick_ratio = self._safe_float(latest.get('速动比率'))

        result["metrics"] = {
            "资产负债率": debt_ratio,
            "流动比率": current_ratio,
            "速动比率": quick_ratio
        }

        # 风险评估
        risk_checks = []
        if debt_ratio:
            risk_checks.append((debt_ratio > 70, f"资产负债率偏高 ({debt_ratio:.1f})，需关注偿债压力"))
        if current_ratio:
            risk_checks.append((current_ratio < 1, f"流动比率偏低 ({current_ratio:.2f})，短期偿债能力较弱"))
        if quick_ratio:
            risk_checks.append((quick_ratio < 0.8, f"速动比率偏低 ({quick_ratio:.2f})，短期流动性风险"))
    
        result["risks"] = [msg for condition, msg in risk_checks if condition]

        # 综合评估
        risk_count = len(result["risks"])
        if risk_count == 0:
            result["assessment"] = "良好 - 偿债能力指标正常，财务结构稳健"
        elif risk_count == 1:
            result["assessment"] = "一般 - 存在一项风险指标，需持续关注"
        else:
            result["assessment"] = "较弱 - 存在多项风险指标，偿债压力较大"

        return result

    def analyze_operation(self) -> Dict:
        """运营效率分析"""
        result = {
            "category": "运营效率",
            "metrics": {},
            "observations": [],
            "assessment": ""
        }

        indicators = self.stock_data.get('financial_indicators', [])
        if not indicators:
            return result

        latest = indicators[0]

        ar_days = self._safe_float(latest.get('应收账款周转天数'))
        inventory_days = self._safe_float(latest.get('存货周转天数'))
        asset_turnover = self._safe_float(latest.get('总资产周转率'))

        result["metrics"] = {
            "应收账款周转率": self._safe_float(latest.get('应收账款周转率')),
            "应收账款周转天数": ar_days,
            "存货周转率": self._safe_float(latest.get('存货周转率')),
            "存货周转天数": inventory_days,
            "总资产周转率": asset_turnover
        }

        # 观察分析
        observation_checks = []
        if ar_days:
            observation_checks.append((ar_days > 90, f"应收账款周转天数较长 ({ar_days:.0f}天)，回款较慢"))
        if inventory_days:
            observation_checks.append((inventory_days > 180, f"存货周转天数较长 ({inventory_days:.0f}天)，库存管理需关注"))
        if asset_turnover:
            observation_checks.append((asset_turnover < 0.5, f"总资产周转率较低 ({asset_turnover:.2f})，资产利用效率有待提高"))
        
        result["observations"] = [msg for condition, msg in observation_checks if condition]

        if not result["observations"]:
            result["assessment"] = "良好 - 运营效率指标正常"
        else:
            result["assessment"] = "需关注 - " + "；".join(result["observations"])

        return result

    def _assess_growth_rate(self, avg_growth: float) -> str:
        """评估增长率"""
        if avg_growth > 20:
            return "高成长 - 平均增长率超过20%"
        elif avg_growth > 10:
            return "稳定成长 - 平均增长率10-20%"
        elif avg_growth > 0:
            return "低速成长 - 平均增长率0-10%"
        return "负增长 - 需要深入分析原因"

    def _analyze_growth_trend(self, values: List[float], name: str) -> Optional[str]:
        """分析增长趋势"""
        if not values:
            return None
        if all(g > 0 for g in values[:4]):
            return f"{name}持续正增长"
        elif values[0] < 0:
            return f"{name}负增长，需关注"
        return None

    def analyze_growth(self) -> Dict:
        """成长性分析"""
        result = {
            "category": "成长性",
            "metrics": {},
            "trend": [],
            "assessment": ""
        }

        indicators = self.stock_data.get('financial_indicators', [])
        if not indicators:
            return result

        revenue_growth = []
        profit_growth = []

        for indicator in indicators[:8]:
            rev = self._safe_float(indicator.get('主营业务收入增长率', indicator.get('营业收入增长率')))
            net = self._safe_float(indicator.get('净利润增长率'))
            if rev is not None:
                revenue_growth.append(rev)
            if net is not None:
                profit_growth.append(net)

        if revenue_growth:
            result["metrics"]["最近营收增长率"] = revenue_growth[0]
            result["metrics"]["平均营收增长率"] = sum(revenue_growth) / len(revenue_growth)

        if profit_growth:
            result["metrics"]["最近净利润增长率"] = profit_growth[0]
            result["metrics"]["平均净利润增长率"] = sum(profit_growth) / len(profit_growth)

        # 趋势判断
        for values, name in [(revenue_growth, "营收"), (profit_growth, "净利润")]:
            trend = self._analyze_growth_trend(values, name)
            if trend:
                result["trend"].append(trend)

        avg_growth = result["metrics"].get("平均净利润增长率", 0) or 0
        result["assessment"] = self._assess_growth_rate(avg_growth)

        return result

    def analyze_dupont(self) -> Dict:
        """杜邦分析"""
        result = {
            "category": "杜邦分析",
            "decomposition": {},
            "driver": "",
            "assessment": ""
        }

        indicators = self.stock_data.get('financial_indicators', [])
        if not indicators:
            return result

        latest = indicators[0] if indicators else {}

        # 杜邦分解: ROE = 净利率 × 资产周转率 × 权益乘数
        net_margin = self._safe_float(latest.get('销售净利率'))
        asset_turnover = self._safe_float(latest.get('总资产周转率'))
        equity_multiplier = self._safe_float(latest.get('权益乘数'))
        roe = self._safe_float(latest.get('净资产收益率', latest.get('加权净资产收益率')))

        result["decomposition"] = {
            "ROE": roe,
            "净利率": net_margin,
            "资产周转率": asset_turnover,
            "权益乘数": equity_multiplier
        }

        # 判断ROE驱动因素
        if net_margin and asset_turnover and equity_multiplier:
            drivers = []
            if net_margin > 15:
                drivers.append("高净利率")
            if asset_turnover > 1:
                drivers.append("高周转")
            if equity_multiplier > 2.5:
                drivers.append("高杠杆")

            if drivers:
                result["driver"] = "ROE主要由" + "、".join(drivers) + "驱动"
            else:
                result["driver"] = "ROE驱动因素较为均衡"

        return result

    def detect_anomalies(self) -> Dict:
        """财务异常检测"""
        result = {
            "category": "财务异常检测",
            "signals": [],
            "risk_level": "低",
            "details": []
        }

        indicators = self.stock_data.get('financial_indicators', [])
        if len(indicators) < 2:
            return result

        current = indicators[0]
        previous = indicators[1] if len(indicators) > 1 else {}

        # 1. 应收账款异常
        ar_growth = self._safe_float(current.get('应收账款增长率'))
        revenue_growth = self._safe_float(current.get('营业收入增长率', current.get('主营业务收入增长率')))
        if ar_growth and revenue_growth and ar_growth > revenue_growth * 1.5:
            result["signals"].append({
                "type": "应收账款增速异常",
                "description": f"应收账款增速({ar_growth:.1f}%)显著高于营收增速({revenue_growth:.1f}%)",
                "severity": "中"
            })

        # 2. 存货异常
        inventory_growth = self._safe_float(current.get('存货增长率'))
        if inventory_growth and revenue_growth and inventory_growth > revenue_growth * 2:
            result["signals"].append({
                "type": "存货增速异常",
                "description": f"存货增速({inventory_growth:.1f}%)远高于营收增速({revenue_growth:.1f}%)",
                "severity": "中"
            })

        # 3. 毛利率异常波动
        current_gm = self._safe_float(current.get('销售毛利率'))
        previous_gm = self._safe_float(previous.get('销售毛利率'))
        if current_gm and previous_gm:
            gm_change = abs(current_gm - previous_gm)
            if gm_change > 10:
                result["signals"].append({
                    "type": "毛利率大幅波动",
                    "description": f"毛利率变动{gm_change:.1f}个百分点，需关注原因",
                    "severity": "中"
                })

        # 4. 经营现金流与净利润背离 (需要现金流数据)
        cash_flow = self.stock_data.get('financial_data', {}).get('cash_flow', [])
        income = self.stock_data.get('financial_data', {}).get('income_statement', [])
        if cash_flow and income:
            try:
                ocf = self._safe_float(cash_flow[0].get('经营活动产生的现金流量净额'))
                net_profit = self._safe_float(income[0].get('净利润'))
                if ocf and net_profit and net_profit > 0:
                    ocf_ratio = ocf / net_profit
                    if ocf_ratio < 0.5:
                        result["signals"].append({
                            "type": "现金流与利润背离",
                            "description": f"经营现金流/净利润 = {ocf_ratio:.1%}，盈利质量存疑",
                            "severity": "高"
                        })
            except (IndexError, KeyError):
                pass

        # 确定风险等级
        high_severity = sum(1 for s in result["signals"] if s.get("severity") == "高")
        medium_severity = sum(1 for s in result["signals"] if s.get("severity") == "中")

        if high_severity > 0:
            result["risk_level"] = "高"
        elif medium_severity >= 2:
            result["risk_level"] = "中"
        else:
            result["risk_level"] = "低"

        return result

    def analyze_profit_attribution(self) -> Dict:
        """
        利润归因分析：拆解净利润变动的驱动因素.
        优先对比同季度财报(YoY)，量化收入、成本、费用、减值对利润的影响.
        """
        result = {
            "category": "利润归因分析",
            "periods": [],
            "comparison_type": "",
            "profit_change": {},
            "attribution": {},
            "primary_drivers": [],
            "assessment": "",
        }

        income = self.stock_data.get("financial_data", {}).get("income_statement", [])
        if len(income) < 2:
            return result

        def _parse_period(row: dict) -> str:
            d = row.get("REPORT_DATE", row.get("report_date", ""))
            return str(d)[:10]

        def _same_quarter(d1: str, d2: str) -> bool:
            """Check if two dates are same quarter (MM-DD match)."""
            return len(d1) >= 10 and len(d2) >= 10 and d1[5:10] == d2[5:10]

        # Try to find YoY same-quarter comparison
        curr = income[0]
        curr_date = _parse_period(curr)
        prev = None
        comparison_type = "sequential"  # default

        for row in income[1:]:
            if _same_quarter(curr_date, _parse_period(row)):
                prev = row
                comparison_type = "yoy_same_quarter"
                break

        # Fallback to sequential if no same-quarter match
        if prev is None:
            prev = income[1]
            prev_date = _parse_period(prev)
            if not _same_quarter(curr_date, prev_date):
                comparison_type = "sequential (caution: different periods)"

        result["comparison_type"] = comparison_type

        # 提取关键字段 (支持中英文键)
        def _get(row: dict, keys: list) -> Optional[float]:
            for k in keys:
                v = row.get(k)
                if v is not None:
                    return self._safe_float(v)
            return None

        revenue_c = _get(curr, ["营业总收入", "TOTAL_OPERATE_INCOME", "营业收入", "OPERATE_INCOME"])
        revenue_p = _get(prev, ["营业总收入", "TOTAL_OPERATE_INCOME", "营业收入", "OPERATE_INCOME"])
        cost_c = _get(curr, ["营业总成本", "TOTAL_OPERATE_COST"])
        cost_p = _get(prev, ["营业总成本", "TOTAL_OPERATE_COST"])
        operate_cost_c = _get(curr, ["营业成本", "OPERATE_COST"])
        operate_cost_p = _get(prev, ["营业成本", "OPERATE_COST"])
        op_profit_c = _get(curr, ["营业利润", "OPERATE_PROFIT"])
        op_profit_p = _get(prev, ["营业利润", "OPERATE_PROFIT"])
        net_profit_c = _get(curr, ["净利润", "NETPROFIT"])
        net_profit_p = _get(prev, ["净利润", "NETPROFIT"])
        parent_profit_c = _get(curr, ["归母净利润", "PARENT_NETPROFIT"])
        parent_profit_p = _get(prev, ["归母净利润", "PARENT_NETPROFIT"])

        # 期间费用
        sale_exp_c = _get(curr, ["销售费用", "sale_expense", "SALE_EXPENSE"])
        sale_exp_p = _get(prev, ["销售费用", "sale_expense", "SALE_EXPENSE"])
        manage_exp_c = _get(curr, ["管理费用", "manage_expense", "MANAGE_EXPENSE"])
        manage_exp_p = _get(prev, ["管理费用", "manage_expense", "MANAGE_EXPENSE"])
        research_exp_c = _get(curr, ["研发费用", "research_expense", "RESEARCH_EXPENSE"])
        research_exp_p = _get(prev, ["研发费用", "research_expense", "RESEARCH_EXPENSE"])
        finance_exp_c = _get(curr, ["财务费用", "finance_expense", "FINANCE_EXPENSE"])
        finance_exp_p = _get(prev, ["财务费用", "finance_expense", "FINANCE_EXPENSE"])

        # 减值损失 (合并各类减值)
        impairment_c = _get(curr, ["资产减值损失", "信用减值损失", "资产减值损失(合计)"])
        impairment_p = _get(prev, ["资产减值损失", "信用减值损失", "资产减值损失(合计)"])
        if impairment_c is None:
            impairment_c = _get(curr, ["impairment_loss", "IMP_AIRMENT_LOSS"])
        if impairment_p is None:
            impairment_p = _get(prev, ["impairment_loss", "IMP_AIRMENT_LOSS"])

        result["periods"] = [
            curr_date,
            _parse_period(prev),
        ]

        # 利润变动
        profit_change = None
        profit_change_pct = None
        if parent_profit_c is not None and parent_profit_p is not None and parent_profit_p != 0:
            profit_change = parent_profit_c - parent_profit_p
            profit_change_pct = round(profit_change / abs(parent_profit_p) * 100, 2)
        elif net_profit_c is not None and net_profit_p is not None and net_profit_p != 0:
            profit_change = net_profit_c - net_profit_p
            profit_change_pct = round(profit_change / abs(net_profit_p) * 100, 2)

        result["profit_change"] = {
            "absolute_change": round(profit_change, 2) if profit_change is not None else None,
            "change_pct": profit_change_pct,
            "current_profit": parent_profit_c or net_profit_c,
            "previous_profit": parent_profit_p or net_profit_p,
        }

        if profit_change is None:
            return result

        # 归因计算 (以营业利润为中间变量)
        attribution = {}

        # 1. 收入变动贡献
        if revenue_c is not None and revenue_p is not None:
            revenue_change = revenue_c - revenue_p
            # 简化：收入变动的利润贡献 = 收入增量 × 上期毛利率
            prev_gross_margin = 0.2  # default 20%
            if operate_cost_p is not None and revenue_p and revenue_p != 0:
                prev_gross_margin = (revenue_p - operate_cost_p) / revenue_p
            elif cost_p is not None and revenue_p and revenue_p != 0:
                prev_gross_margin = (revenue_p - cost_p) / revenue_p
            revenue_contrib = revenue_change * prev_gross_margin
            attribution["收入变动"] = round(revenue_contrib, 2)

        # 2. 毛利率变动影响
        if operate_cost_c is not None and operate_cost_p is not None and revenue_c and revenue_p:
            gm_c = (revenue_c - operate_cost_c) / revenue_c if revenue_c != 0 else 0
            gm_p = (revenue_p - operate_cost_p) / revenue_p if revenue_p != 0 else 0
            gm_impact = revenue_c * (gm_c - gm_p)
            attribution["毛利率变动"] = round(gm_impact, 2)

        # 3. 期间费用变动 (费用增加为负贡献)
        period_exp_contrib = 0
        for label, c, p in [
            ("销售费用", sale_exp_c, sale_exp_p),
            ("管理费用", manage_exp_c, manage_exp_p),
            ("研发费用", research_exp_c, research_exp_p),
            ("财务费用", finance_exp_c, finance_exp_p),
        ]:
            if c is not None and p is not None:
                delta = p - c  # 费用增加 → 负贡献
                period_exp_contrib += delta
                attribution[label] = round(delta, 2)
        if period_exp_contrib != 0 and not any(k in attribution for k in ["销售费用", "管理费用", "研发费用", "财务费用"]):
            attribution["期间费用合计"] = round(period_exp_contrib, 2)

        # 4. 减值损失影响
        if impairment_c is not None and impairment_p is not None:
            # 减值增加为负贡献
            impairment_impact = impairment_p - impairment_c
            attribution["减值损失"] = round(impairment_impact, 2)

        # 5. 营业外收支 (用净利润 - 营业利润近似)
        if net_profit_c is not None and net_profit_p is not None and op_profit_c is not None and op_profit_p is not None:
            non_op_c = net_profit_c - op_profit_c
            non_op_p = net_profit_p - op_profit_p
            attribution["营业外收支"] = round(non_op_c - non_op_p, 2)

        result["attribution"] = attribution

        # 找出主要驱动因素 (按影响绝对值排序)
        sorted_drivers = sorted(
            [(k, v) for k, v in attribution.items() if v is not None],
            key=lambda x: abs(x[1]),
            reverse=True,
        )
        result["primary_drivers"] = [
            {"factor": k, "impact": v, "direction": "正向" if v > 0 else "负向"}
            for k, v in sorted_drivers[:5]
        ]

        # 评估
        if profit_change_pct is not None:
            comp_note = f"[{comparison_type}] "
            if profit_change_pct < -30:
                assessment = f"{comp_note}净利润大幅下滑 ({profit_change_pct}%)，"
            elif profit_change_pct < -10:
                assessment = f"{comp_note}净利润明显下滑 ({profit_change_pct}%)，"
            elif profit_change_pct < 0:
                assessment = f"{comp_note}净利润小幅下滑 ({profit_change_pct}%)，"
            elif profit_change_pct < 10:
                assessment = f"{comp_note}净利润小幅增长 ({profit_change_pct}%)，"
            elif profit_change_pct < 30:
                assessment = f"{comp_note}净利润明显增长 ({profit_change_pct}%)，"
            else:
                assessment = f"{comp_note}净利润大幅增长 ({profit_change_pct}%)，"

            # 补充主要原因
            if sorted_drivers:
                top_factor, top_impact = sorted_drivers[0]
                direction = "正向" if top_impact > 0 else "负向"
                assessment += f"主要受'{top_factor}'{direction}驱动(影响{top_impact:,.0f}万元)"
            result["assessment"] = assessment

        return result

    def analyze_profit_quality(self) -> Dict:
        """
        利润质量分析：评估利润的现金含量、可持续性、一次性因素.
        """
        result = {
            "category": "利润质量分析",
            "metrics": {},
            "warnings": [],
            "assessment": "",
        }

        cash_flow = self.stock_data.get("financial_data", {}).get("cash_flow", [])
        income = self.stock_data.get("financial_data", {}).get("income_statement", [])

        if not cash_flow or not income:
            return result

        def _get(row: dict, keys: list) -> Optional[float]:
            for k in keys:
                v = row.get(k)
                if v is not None:
                    return self._safe_float(v)
            return None

        curr_cf = cash_flow[0]
        curr_inc = income[0]

        ocf = _get(curr_cf, ["经营活动产生的现金流量净额", "NETCASH_OPERATE", "operate_cash_flow"])
        net_profit = _get(curr_inc, ["净利润", "NETPROFIT"])
        parent_profit = _get(curr_inc, ["归母净利润", "PARENT_NETPROFIT"])
        depre = _get(curr_cf, ["固定资产折旧、油气资产折耗、生产性生物资产折旧", "折旧"])
        amort = _get(curr_cf, ["无形资产摊销", "摊销"])

        profit = parent_profit or net_profit

        # 经营现金流/净利润
        if ocf is not None and profit and profit != 0:
            ocf_ratio = round(ocf / profit, 2)
            result["metrics"]["经营现金流/净利润"] = ocf_ratio
            if ocf_ratio < 0.5:
                result["warnings"].append(f"经营现金流覆盖净利润比例低 ({ocf_ratio})，盈利质量存疑")
            elif ocf_ratio > 1.2:
                result["metrics"]["现金含量"] = "高 - 现金流充裕"
            else:
                result["metrics"]["现金含量"] = "正常"

        # 非现金支出占比 (折旧+摊销)
        if depre is not None and profit and profit != 0:
            non_cash = depre + (amort or 0)
            non_cash_ratio = round(non_cash / profit, 2)
            result["metrics"]["非现金支出/净利润"] = non_cash_ratio
            if non_cash_ratio > 0.5:
                result["warnings"].append("非现金支出占比较高，利润受折旧政策影响大")

        # 利润可持续性评估
        if len(income) >= 4:
            profits = []
            for inc in income[:4]:
                p = _get(inc, ["归母净利润", "PARENT_NETPROFIT", "净利润", "NETPROFIT"])
                if p is not None:
                    profits.append(p)
            if len(profits) >= 4:
                # 检查是否出现大幅波动
                max_p = max(profits)
                min_p = min(profits)
                if max_p != 0:
                    volatility = (max_p - min_p) / abs(max_p)
                    result["metrics"]["利润波动率"] = round(volatility, 2)
                    if volatility > 1.0:
                        result["warnings"].append("利润波动剧烈，可持续性较差")
                    elif volatility > 0.5:
                        result["warnings"].append("利润波动较大")

                # 趋势判断
                if profits[0] > profits[-1]:
                    result["metrics"]["利润趋势"] = "上升"
                elif profits[0] < profits[-1]:
                    result["metrics"]["利润趋势"] = "下降"
                else:
                    result["metrics"]["利润趋势"] = "平稳"

        if result["warnings"]:
            result["assessment"] = "需关注 - " + "；".join(result["warnings"])
        else:
            result["assessment"] = "良好 - 利润质量正常，现金含量充足"

        return result

    def generate_summary(self, level: str = "standard") -> Dict:
        """生成分析摘要"""
        summary = {
            "code": self.stock_data.get('code', ''),
            "name": self.stock_data.get('basic_info', {}).get('name', ''),
            "analysis_date": datetime.now().isoformat(),
            "level": level
        }

        profitability = self.analyze_profitability()
        solvency = self.analyze_solvency()
        operation = self.analyze_operation()
        growth = self.analyze_growth()
        anomalies = self.detect_anomalies()

        if level == "summary":
            summary["profitability"] = profitability["assessment"]
            summary["solvency"] = solvency["assessment"]
            summary["growth"] = growth["assessment"]
            summary["risk_level"] = anomalies["risk_level"]
        else:
            # standard 和 deep 级别共享基础分析结果
            summary["profitability"] = profitability
            summary["solvency"] = solvency
            summary["operation"] = operation
            summary["growth"] = growth
            summary["dupont"] = self.analyze_dupont()
            summary["anomalies"] = anomalies
            summary["profit_attribution"] = self.analyze_profit_attribution()
            summary["profit_quality"] = self.analyze_profit_quality()

            if level == "deep":
                summary["historical_indicators"] = self.stock_data.get('financial_indicators', [])

        summary["score"] = self._calculate_score(profitability, solvency, growth, anomalies)

        return summary

    def _calculate_score(self, profitability, solvency, growth, anomalies) -> int:
        """计算综合评分 (0-100)"""
        score = 50

        # 盈利能力评分
        roe = profitability.get("metrics", {}).get("当前ROE")
        if roe:
            if roe > 20:
                score += 15
            elif roe > 15:
                score += 10
            elif roe > 10:
                score += 5
            elif roe < 5:
                score -= 5

        # 偿债能力评分
        risks = solvency.get("risks", [])
        score += 10 if not risks else -len(risks) * 3

        # 成长性评分
        avg_growth = growth.get("metrics", {}).get("平均净利润增长率", 0) or 0
        if avg_growth > 20:
            score += 15
        elif avg_growth > 10:
            score += 10
        elif avg_growth > 0:
            score += 5
        else:
            score -= 5

        # 风险扣分
        risk_penalties = {"高": 15, "中": 8}
        score -= risk_penalties.get(anomalies.get("risk_level", "低"), 0)

        return max(0, min(100, score))

    def compare_stocks(self, stocks_data: List[Dict]) -> Dict:
        """对比多只股票"""
        comparison = {
            "comparison_date": datetime.now().isoformat(),
            "stocks": [],
            "ranking": {}
        }

        stock_scores = []
        for stock in stocks_data:
            self.stock_data = stock
            summary = self.generate_summary(level="summary")
            comparison["stocks"].append({
                "code": stock.get('code', ''),
                "name": stock.get('basic_info', {}).get('name', ''),
                "score": summary.get("score", 50),
                "profitability": summary.get("profitability"),
                "solvency": summary.get("solvency"),
                "growth": summary.get("growth"),
                "risk_level": summary.get("risk_level")
            })
            stock_scores.append((stock.get('code', ''), summary.get("score", 50)))

        # 排名
        stock_scores.sort(key=lambda x: x[1], reverse=True)
        comparison["ranking"] = {code: rank + 1 for rank, (code, _) in enumerate(stock_scores)}

        return comparison

    @staticmethod
    def _safe_float(value) -> Optional[float]:
        """安全转换为浮点数"""
        if value is None or value == '' or value == '--':
            return None
        try:
            if isinstance(value, str):
                value = value.replace('%', '').replace(',', '')
            return float(value)
        except (ValueError, TypeError):
            return None


def main():
    parser = argparse.ArgumentParser(description="A股财务分析器")
    parser.add_argument("--input", type=str, required=True, help="输入数据文件 (JSON)")
    parser.add_argument("--level", type=str, default="standard",
                       choices=["summary", "standard", "deep"],
                       help="分析深度级别")
    parser.add_argument("--mode", type=str, default="single",
                       choices=["single", "comparison"],
                       help="分析模式: single(单只)/comparison(对比)")
    parser.add_argument("--output", type=str, help="输出文件路径 (JSON)")

    args = parser.parse_args()

    # 加载数据
    with open(args.input, 'r', encoding='utf-8') as f:
        data = json.load(f)

    analyzer = FinancialAnalyzer()

    if args.mode == "single":
        analyzer.stock_data = data
        result = analyzer.generate_summary(level=args.level)
    else:
        # 对比模式
        stocks = data.get('stocks', [data])
        result = analyzer.compare_stocks(stocks)

    # 输出
    output_json = json.dumps(result, ensure_ascii=False, indent=2, default=str)

    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(output_json)
        print(f"分析结果已保存到: {args.output}")
    else:
        print(output_json)


if __name__ == "__main__":
    main()
