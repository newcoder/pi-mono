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
	close?: number;
	prob: number;
}

interface PredictionResult {
	model: string;
	version?: string;
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
	const modelLabel = data.model === "lgb" ? "LightGBM" : data.model;
	lines.push(`【ML股价预测】${modelLabel} | ${data.prediction_date}`);
	lines.push(`预测股票数: ${data.total_stocks}只`);
	if (data.version) {
		lines.push(`模型版本: ${data.version}`);
	}
	lines.push("");
	lines.push(`━━━━━━━ Top ${Math.min(topN, data.top_n.length)} 预测（按概率降序）━━━━━━━`);

	for (let i = 0; i < data.top_n.length; i++) {
		const r = data.top_n[i];
		const probPct = (r.prob * 100).toFixed(1);
		// 提取纯代码（去掉 SSE./SZSE. 前缀）
		const codeOnly = r.symbol.includes(".") ? r.symbol.split(".")[1] : r.symbol;
		const closeStr = r.close != null ? `  close=${r.close.toFixed(2)}` : "";
		lines.push(`${i + 1}. ${codeOnly}${closeStr}  prob=${probPct}%`);
	}

	lines.push("");
	lines.push("*免责声明: 机器学习预测结果仅供参考，不构成投资建议。*");
	return lines.join("\n");
}

// ── Tool definition ─────────────────────────────────────────────────────────

const predictStockRankingParams = Type.Object({
	model: Type.Union(
		[
			Type.Literal("de", { description: "DoubleEnsemble 模型（基于 Qlib），已支持" }),
			Type.Literal("lgb", { description: "LightGBM 生产模型（暂未支持）" }),
		],
		{ description: "预测模型选择（当前仅 de 可用）" },
	),
	pool_name: Type.Optional(
		Type.String({
			description:
				"trading-agent 股票池名称（通过 manage_stock_pool 创建）。不指定则使用模型默认股池（如中证800+中证1000）。",
		}),
	),
	top_n: Type.Optional(Type.Number({ description: "返回前N个预测结果", default: 50 })),
});

export const predictStockRankingTool: AgentTool<typeof predictStockRankingParams, PredictionResult> = {
	name: "predict_stock_ranking",
	label: "ML股价预测排序",
	description:
		"使用 DoubleEnsemble (DE) 机器学习模型对股票池的最新交易日进行股价预测，按预测概率排序返回 Top-N 股票。支持自定义股票池（通过 pool_name 引用 trading-agent 中的股票池），不指定则使用模型默认股池（中证800+中证1000）。LightGBM (LGB) 模型暂未支持。",
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
						text: "LightGBM (LGB) 模型暂未支持，当前仅支持 DoubleEnsemble (DE) 模型。请使用 --model de 重新调用。",
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
		const pyArgs: string[] = ["--model", model, "--top-n", String(topN)];
		if (symbolsArg) {
			pyArgs.push("--symbols", symbolsArg);
		}
		if (model === "de") {
			pyArgs.push("--model-name", "doubleensemble_csi", "--version", "latest");
		}

		console.log(
			`[predict_stock_ranking] 启动 ${model} 预测 (top_n=${topN}, pool=${params.pool_name || "default"})...`,
		);
		console.log(`[predict_stock_ranking] python=${PYTHON_EXE}, script=${scriptPath}, cwd=${TQ_TOOL_DIR}`);
		console.log(`[predict_stock_ranking] args=${pyArgs.join(" ")}`);
		const startTime = Date.now();

		try {
			// DE 模型跑 1800 只股票约 3~4 分钟，给足 10 分钟余量防止超时
			const timeoutMs = model === "de" ? 600_000 : 300_000;
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
