import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getDataStore } from "../data/index.js";
import { runPythonCustom } from "./_utils.js";

// ── Configuration ───────────────────────────────────────────────────────────

const TQ_TOOL_DIR = process.env.TQ_TOOL_DIR || "D:\\projects\\tq_tool";
// Use system Python by default; tq_tool venv may not have deps installed.
// Override via TQ_TOOL_PYTHON env var if needed.
const PYTHON_EXE = process.env.TQ_TOOL_PYTHON || "python";

// ── Types ───────────────────────────────────────────────────────────────────

interface PredictionRecord {
	date: string;
	symbol: string;
	name?: string;
	close?: number;
	prob?: number;
	prediction?: number;
}

interface PredictionResult {
	model: string;
	version?: string;
	target_type?: string;
	prediction_date: string;
	total_stocks: number;
	top_n: PredictionRecord[];
	error?: string;
}

function emptyResult(model: string, error: string): PredictionResult {
	return {
		model,
		prediction_date: "",
		total_stocks: 0,
		top_n: [],
		error,
	};
}

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatPredictions(data: PredictionResult, topN: number): string {
	const lines: string[] = [];
	const isRegression = data.target_type === "regression";
	const modelLabel = isRegression ? "DoubleEnsemble 回归" : data.model === "lgb" ? "LightGBM" : "DoubleEnsemble";
	lines.push(`【ML股价预测】${modelLabel} | ${data.prediction_date}`);
	lines.push(`预测股票数: ${data.total_stocks}只`);
	if (data.version) {
		lines.push(`模型版本: ${data.version}`);
	}
	if (data.target_type) {
		lines.push(`目标类型: ${isRegression ? "回归 (alpha)" : "分类 (概率)"}`);
	}
	lines.push("");
	const sortLabel = isRegression ? "按 alpha 降序" : "按概率降序";
	lines.push(`━━━━━━━ Top ${Math.min(topN, data.top_n.length)} 预测（${sortLabel}）━━━━━━━`);

	for (let i = 0; i < data.top_n.length; i++) {
		const r = data.top_n[i];
		// 提取纯代码（去掉 SSE./SZSE. 前缀）
		const codeOnly = r.symbol.includes(".") ? r.symbol.split(".")[1] : r.symbol;
		const nameStr = r.name ? ` ${r.name}` : "";
		const closeStr = r.close != null ? ` close=${r.close.toFixed(2)}` : "";
		if (isRegression && r.prediction != null) {
			const alpha = r.prediction >= 0 ? `+${r.prediction.toFixed(4)}` : r.prediction.toFixed(4);
			lines.push(`${i + 1}. ${codeOnly}${nameStr}${closeStr}  alpha=${alpha}`);
		} else if (r.prob != null) {
			const probPct = (r.prob * 100).toFixed(1);
			lines.push(`${i + 1}. ${codeOnly}${nameStr}${closeStr}  prob=${probPct}%`);
		} else if (r.prediction != null) {
			// API normalizes prob to prediction for binary models too
			const probPct = (r.prediction * 100).toFixed(1);
			lines.push(`${i + 1}. ${codeOnly}${nameStr}${closeStr}  prob=${probPct}%`);
		} else {
			lines.push(`${i + 1}. ${codeOnly}${nameStr}${closeStr}`);
		}
	}

	lines.push("");
	lines.push("*免责声明: 机器学习预测结果仅供参考，不构成投资建议。*");
	return lines.join("\n");
}

// ── Tool definition ─────────────────────────────────────────────────────────

const predictStockRankingParams = Type.Object({
	model: Type.Union(
		[
			Type.Literal("de", { description: "DoubleEnsemble 分类模型（基于 Qlib），预测上涨概率" }),
			Type.Literal("de_regression", { description: "DoubleEnsemble 回归模型，预测超额收益 alpha" }),
			Type.Literal("lgb", { description: "LightGBM 生产模型（暂未支持）" }),
		],
		{ description: "预测模型选择（de=分类, de_regression=回归 alpha）" },
	),
	pool_name: Type.Optional(
		Type.String({
			description:
				"trading-agent 股票池名称（通过 manage_stock_pool 创建）。不指定则使用模型默认股池（如中证800+中证1000）。",
		}),
	),
	top_n: Type.Optional(Type.Number({ description: "返回前N个预测结果", default: 50 })),
	horizon: Type.Optional(Type.Number({ description: "回归模型预测周期（天），仅 de_regression 有效", default: 5 })),
});

export const predictStockRankingTool: AgentTool<typeof predictStockRankingParams, PredictionResult> = {
	name: "predict_stock_ranking",
	label: "ML股价预测排序",
	description:
		"使用 DoubleEnsemble (DE) 机器学习模型对股票池进行股价预测排序，返回 Top-N 股票。" +
		"\n\n【模型选择】" +
		"\n- de: 分类模型，预测次日上涨概率（0~100%），适合选股和择时。" +
		"\n- de_regression: 回归模型，预测未来 N 日超额收益 alpha（可正可负），alpha 越高表示相对基准的超额收益预期越强，适合因子选股和组合构建。" +
		"\n- lgb: LightGBM 模型（暂未支持）。" +
		"\n\n【参数说明】" +
		"\n- pool_name: 指定 trading-agent 股票池名称（通过 manage_stock_pool 创建），不指定则用模型默认股池（中证800+中证1000成分股）。" +
		"\n- top_n: 返回前 N 个预测结果，默认 50。" +
		"\n- horizon: 仅 de_regression 有效，预测周期（天），默认 5。对应模型名 doubleensemble_csi_reg_h{horizon}。" +
		"\n\n【输出解读】" +
		"\n- 分类模型(de): prob=上涨概率百分比，按概率降序排列。" +
		"\n- 回归模型(de_regression): alpha=超额收益预测值，按 alpha 降序排列。alpha > 0 表示预期跑赢基准，alpha < 0 表示预期跑输。" +
		"\n\n*注意: 预测基于历史数据训练，不构成投资建议。*",
	parameters: predictStockRankingParams,
	execute: async (_id, params) => {
		const model = params.model;
		const topN = params.top_n ?? 50;

		// LGB 模型暂未支持
		if (model === "lgb") {
			return {
				content: [
					{
						type: "text",
						text: "LightGBM (LGB) 模型暂未支持。当前支持: DoubleEnsemble 分类 (de) 和 回归 (de_regression)。",
					},
				],
				details: emptyResult(model, "LGB model not yet supported"),
			};
		}

		let symbolsArg: string | undefined;

		// ── Resolve stock pool ───────────────────────────────────────────
		if (params.pool_name) {
			const store = getDataStore();
			if (!store) {
				return {
					content: [{ type: "text", text: "数据库未初始化，无法读取股票池。" }],
					details: emptyResult(model, "DataStore not initialized"),
				};
			}
			const pool = await store.getStockPoolByName(params.pool_name);
			if (!pool) {
				return {
					content: [{ type: "text", text: `股票池 "${params.pool_name}" 不存在。` }],
					details: emptyResult(model, "pool not found"),
				};
			}
			const items = await store.getStockPoolItems(pool.id);
			if (items.length === 0) {
				return {
					content: [{ type: "text", text: `股票池 "${params.pool_name}" 为空。` }],
					details: emptyResult(model, "pool empty"),
				};
			}
			// 转换为 tq_tool 的 symbol 格式: SSE.600519 / SZSE.000001
			const symbols = items.map((item: any) => {
				const prefix = item.market === 1 ? "SSE" : "SZSE";
				return `${prefix}.${item.code}`;
			});
			symbolsArg = symbols.join(",");
		}

		// ── Run prediction ───────────────────────────────────────────────
		// predict_api.py moved into stock_ml/scripts/ in the updated tq_tool layout
		const scriptPath = `${TQ_TOOL_DIR}\\stock_ml\\scripts\\predict_api.py`;
		const pyArgs: string[] = ["--model", "de", "--top-n", String(topN)];
		if (symbolsArg) {
			pyArgs.push("--symbols", symbolsArg);
		}
		if (model === "de") {
			pyArgs.push("--model-name", "doubleensemble_csi", "--version", "latest");
		} else if (model === "de_regression") {
			const horizon = params.horizon ?? 5;
			pyArgs.push("--model-name", `doubleensemble_csi_reg_h${horizon}`, "--version", "latest");
		}

		console.log(
			`[predict_stock_ranking] 启动 ${model} 预测 (top_n=${topN}, pool=${params.pool_name || "default"})...`,
		);
		console.log(`[predict_stock_ranking] python=${PYTHON_EXE}, script=${scriptPath}, cwd=${TQ_TOOL_DIR}`);
		console.log(`[predict_stock_ranking] args=${pyArgs.join(" ")}`);
		const startTime = Date.now();

		try {
			// DE 模型跑 1800 只股票约 3~4 分钟，给足 10 分钟余量防止超时
			const timeoutMs = model.startsWith("de") ? 600_000 : 300_000;
			const stdout = await runPythonCustom(PYTHON_EXE, scriptPath, pyArgs, TQ_TOOL_DIR, timeoutMs);

			const data: PredictionResult = JSON.parse(stdout);

			const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
			console.log(`[predict_stock_ranking] 预测完成，耗时 ${elapsed}s`);

			const text = formatPredictions(data, topN);

			return {
				content: [{ type: "text", text }],
				details: data,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[predict_stock_ranking] 预测失败: ${message}`);
			return {
				content: [{ type: "text", text: `预测失败: ${message}` }],
				details: emptyResult(model, message),
			};
		}
	},
};
