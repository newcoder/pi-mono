import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolTrade } from "../backtest/types.js";

export interface PoolReportBenchmark {
	label: string;
	equityCurve: Array<{ date: string; equity: number }>;
	totalReturn: number;
	maxDrawdown: number;
}

export interface PoolReportMetrics {
	totalReturn: number;
	annualizedReturn: number;
	sharpeRatio: number;
	maxDrawdown: number;
	maxDrawdownDuration?: number;
	winRate?: number;
	profitFactor?: number;
	avgWin?: number;
	avgLoss?: number;
	avgHoldingDays?: number;
	totalTrades?: number;
}

export interface PoolReportData {
	title: string;
	poolName: string;
	strategy: string;
	startDate: string;
	endDate: string;
	initialCapital: number;
	strategyCurve: Array<{ date: string; equity: number }>;
	strategyMetrics: PoolReportMetrics;
	benchmarks: PoolReportBenchmark[];
	trades: PoolTrade[];
	config?: Record<string, unknown>;
}

export interface GeneratePoolReportResult {
	filePath: string;
	url: string;
}

export async function generatePoolBacktestReport(
	data: PoolReportData,
	outputDir: string,
	baseUrl: string,
): Promise<GeneratePoolReportResult> {
	mkdirSync(outputDir, { recursive: true });

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const safeTitle = data.title.replace(/[^\w一-龥-]/g, "_").slice(0, 40);
	const fileName = `${timestamp}_${safeTitle}.html`;
	const filePath = join(outputDir, fileName);

	const html = buildTemplate(data);
	await writeFile(filePath, html, "utf-8");

	return { filePath, url: `${baseUrl}/reports/${fileName}` };
}

function buildTemplate(data: PoolReportData): string {
	const {
		title,
		poolName,
		strategy,
		startDate,
		endDate,
		initialCapital,
		strategyCurve,
		strategyMetrics,
		benchmarks,
		trades,
		config,
	} = data;

	function buildConfigRows(cfg: Record<string, unknown> | undefined): string {
		if (!cfg) return "";
		return Object.entries(cfg)
			.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
			.join("");
	}

	const fmtNum = (n: number | undefined, digits = 2) =>
		n == null ? "-" : n.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
	const fmtPct = (n: number | undefined) => (n == null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`);

	const metricCards = buildMetricCards(strategyMetrics, benchmarks, fmtPct, fmtNum);
	const equityChartScript = buildEquityChartScript(strategyCurve, benchmarks);
	const drawdownChartScript = buildDrawdownChartScript(strategyCurve, benchmarks);
	const heatmapHtml = buildMonthlyHeatmap(strategyCurve);
	const tradeRowsHtml = buildTradeRows(trades, fmtNum, fmtPct);

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root { --bg:#0f1419; --bg-card:#161b22; --bg-hover:#1c2128; --border:#30363d; --text:#c9d1d9; --text-secondary:#8b949e; --text-muted:#484f58; --accent:#58a6ff; --accent-dim:#388bfd; --green:#3fb950; --red:#f85149; --orange:#f0883e; --yellow:#d29922; --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans SC",sans-serif; --font-mono:"SF Mono","Cascadia Code","Fira Code",Consolas,monospace; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:var(--font); background:var(--bg); color:var(--text); line-height:1.6; min-height:100vh; }
.container { max-width:1200px; margin:0 auto; padding:24px; }
header { border-bottom:1px solid var(--border); padding-bottom:20px; margin-bottom:24px; }
header h1 { font-size:1.6rem; font-weight:600; color:#fff; margin-bottom:8px; }
header .subtitle { font-size:0.9rem; color:var(--text-secondary); display:flex; flex-wrap:wrap; gap:16px; }
.metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
.metric-card { background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:16px; text-align:center; transition:border-color .2s; }
.metric-card:hover { border-color:var(--accent-dim); }
.metric-card .label { font-size:0.75rem; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px; }
.metric-card .value { font-size:1.4rem; font-weight:700; font-family:var(--font-mono); }
.metric-card .value.pos { color:var(--red); }
.metric-card .value.neg { color:var(--green); }
.metric-card .value.neu { color:var(--text); }
.chart-section { background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:20px; margin-bottom:24px; }
.chart-section h2 { font-size:1rem; font-weight:600; color:#fff; margin-bottom:16px; display:flex; align-items:center; gap:8px; }
.chart-wrapper { position:relative; height:360px; }
.table-section { background:var(--bg-card); border:1px solid var(--border); border-radius:10px; padding:20px; margin-bottom:24px; }
.table-section h2 { font-size:1rem; font-weight:600; color:#fff; margin-bottom:16px; }
.table-wrapper { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:0.85rem; }
th,td { padding:10px 12px; text-align:left; }
th { background:var(--bg-hover); color:var(--text-secondary); font-weight:500; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.3px; border-bottom:1px solid var(--border); white-space:nowrap; }
td { border-bottom:1px solid var(--border); color:var(--text); }
tr:hover td { background:var(--bg-hover); }
td.num { font-family:var(--font-mono); text-align:right; }
td.pos { color:var(--red); }
td.neg { color:var(--green); }
td.buy { color:var(--red); font-weight:500; }
td.sell { color:var(--green); font-weight:500; }
.heatmap-grid { display:grid; grid-template-columns:60px repeat(12,1fr); gap:3px; font-size:0.75rem; }
.heatmap-cell { padding:6px 4px; text-align:center; border-radius:4px; font-family:var(--font-mono); min-height:32px; display:flex; align-items:center; justify-content:center; }
.heatmap-header { color:var(--text-secondary); font-weight:500; }
.heatmap-year { color:var(--text-secondary); font-weight:500; text-align:right; padding-right:8px; }
footer { text-align:center; color:var(--text-muted); font-size:0.8rem; padding:24px; border-top:1px solid var(--border); }
@media(max-width:768px){ .container{padding:12px;} .metrics{grid-template-columns:repeat(2,1fr);} .chart-wrapper{height:260px;} th,td{padding:8px;font-size:0.8rem;} }
</style>
</head>
<body>
<div class="container">
<header>
  <h1>${escapeHtml(title)}</h1>
  <div class="subtitle">
    <span>股池：${escapeHtml(poolName)}</span>
    <span>策略：${escapeHtml(strategy)}</span>
    <span>区间：${startDate} ~ ${endDate}</span>
    <span>初始资金：${initialCapital.toLocaleString("zh-CN")}</span>
    <span>生成于 ${new Date().toLocaleString("zh-CN")}</span>
  </div>
</header>

${
	config
		? `
<section class="table-section">
  <h2>回测参数</h2>
  <table><thead><tr><th>参数</th><th>值</th></tr></thead>
  <tbody>${buildConfigRows(config)}</tbody></table>
</section>`
		: ""
}

<section class="metrics">
${metricCards}
</section>

<section class="chart-section">
  <h2>策略 vs 指数 资金曲线</h2>
  <div class="chart-wrapper"><canvas id="equityChart"></canvas></div>
</section>

<section class="chart-section">
  <h2>回撤曲线</h2>
  <div class="chart-wrapper"><canvas id="drawdownChart"></canvas></div>
</section>

<section class="table-section">
  <h2>月度收益 (%)</h2>
  <div id="monthlyHeatmap">${heatmapHtml}</div>
</section>

<section class="table-section">
  <h2>调仓明细 (${trades.length} 笔)</h2>
  <div class="table-wrapper">
    <table>
      <thead>
        <tr><th>序号</th><th>日期</th><th>方向</th><th>代码</th><th>数量</th><th>价格</th><th>金额</th><th>持仓天数</th><th>盈亏</th><th>盈亏率</th><th>备注</th></tr>
      </thead>
      <tbody>${tradeRowsHtml}</tbody>
    </table>
  </div>
</section>

<footer>由 Trading Agent 自动生成 · pi-mono</footer>
</div>

<script>
${equityChartScript}
${drawdownChartScript}
</script>
</body>
</html>`;
}

function buildMetricCards(
	strategyMetrics: PoolReportMetrics,
	benchmarks: PoolReportBenchmark[],
	fmtPct: (n: number | undefined) => string,
	fmtNum: (n: number | undefined, digits?: number) => string,
): string {
	const cards: Array<{ label: string; value: string; cls: string }> = [
		{
			label: "策略总收益",
			value: fmtPct(strategyMetrics.totalReturn),
			cls: strategyMetrics.totalReturn >= 0 ? "pos" : "neg",
		},
		{
			label: "策略年化",
			value: fmtPct(strategyMetrics.annualizedReturn),
			cls: strategyMetrics.annualizedReturn >= 0 ? "pos" : "neg",
		},
		{ label: "策略最大回撤", value: fmtPct(-strategyMetrics.maxDrawdown), cls: "neg" },
		{ label: "策略夏普", value: fmtNum(strategyMetrics.sharpeRatio), cls: "neu" },
		{
			label: "胜率",
			value: `${strategyMetrics.winRate?.toFixed(1) ?? "-"}%`,
			cls: (strategyMetrics.winRate ?? 0) >= 50 ? "pos" : "neu",
		},
		{ label: "盈亏比", value: fmtNum(strategyMetrics.profitFactor), cls: "neu" },
		{ label: "交易次数", value: String(strategyMetrics.totalTrades ?? 0), cls: "neu" },
		{ label: "平均持仓天数", value: fmtNum(strategyMetrics.avgHoldingDays, 1), cls: "neu" },
	];

	for (const b of benchmarks) {
		cards.push({ label: `${b.label}总收益`, value: fmtPct(b.totalReturn), cls: b.totalReturn >= 0 ? "pos" : "neg" });
		cards.push({ label: `${b.label}最大回撤`, value: fmtPct(-b.maxDrawdown), cls: "neg" });
	}

	return cards
		.map(
			(c) =>
				`  <div class="metric-card"><div class="label">${escapeHtml(c.label)}</div><div class="value ${c.cls}">${c.value}</div></div>`,
		)
		.join("\n");
}

function buildEquityChartScript(
	strategyCurve: Array<{ date: string; equity: number }>,
	benchmarks: PoolReportBenchmark[],
): string {
	const labels = JSON.stringify(strategyCurve.map((p) => p.date));
	const datasets = [
		{
			label: "策略",
			data: strategyCurve.map((p) => p.equity),
			borderColor: "#58a6ff",
			backgroundColor: "rgba(88,166,255,0.08)",
			fill: true,
			tension: 0.1,
			pointRadius: 0,
			pointHoverRadius: 4,
			borderWidth: 1.5,
		},
		...benchmarks.map((b, i) => ({
			label: b.label,
			data: b.equityCurve.map((p) => p.equity),
			borderColor: i === 0 ? "#f0883e" : "#3fb950",
			backgroundColor: "transparent",
			fill: false,
			tension: 0.1,
			pointRadius: 0,
			pointHoverRadius: 4,
			borderWidth: 1.2,
			borderDash: i === 0 ? [4, 4] : [2, 2],
		})),
	];

	return `
const fmtNum = (n) => n.toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
new Chart(document.getElementById('equityChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: ${labels},
    datasets: ${JSON.stringify(datasets)}
  },
  options: {
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#c9d1d9' } }, tooltip: { backgroundColor: '#161b22', titleColor: '#c9d1d9', bodyColor: '#c9d1d9', borderColor: '#30363d', borderWidth: 1, callbacks: { label: (c) => c.dataset.label + ': ' + fmtNum(c.parsed.y) } } },
    scales: { x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 8 } }, y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', callback: v => v.toLocaleString() } } }
  }
});`;
}

function buildDrawdownChartScript(
	strategyCurve: Array<{ date: string; equity: number }>,
	benchmarks: PoolReportBenchmark[],
): string {
	const labels = JSON.stringify(strategyCurve.map((p) => p.date));
	const computeDrawdown = (curve: Array<{ date: string; equity: number }>) => {
		let peak = curve[0]?.equity ?? 0;
		return curve.map((p) => {
			if (p.equity > peak) peak = p.equity;
			return peak > 0 ? ((p.equity - peak) / peak) * 100 : 0;
		});
	};

	const datasets = [
		{
			label: "策略回撤",
			data: computeDrawdown(strategyCurve),
			borderColor: "#f85149",
			backgroundColor: "rgba(248,81,73,0.1)",
			fill: true,
			tension: 0.1,
			pointRadius: 0,
			pointHoverRadius: 4,
			borderWidth: 1.5,
		},
		...benchmarks.map((b, i) => ({
			label: `${b.label}回撤`,
			data: computeDrawdown(b.equityCurve),
			borderColor: i === 0 ? "#f0883e" : "#3fb950",
			backgroundColor: "transparent",
			fill: false,
			tension: 0.1,
			pointRadius: 0,
			pointHoverRadius: 4,
			borderWidth: 1.2,
			borderDash: i === 0 ? [4, 4] : [2, 2],
		})),
	];

	return `
new Chart(document.getElementById('drawdownChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: ${labels},
    datasets: ${JSON.stringify(datasets)}
  },
  options: {
    responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#c9d1d9' } }, tooltip: { backgroundColor: '#161b22', titleColor: '#c9d1d9', bodyColor: '#c9d1d9', borderColor: '#30363d', borderWidth: 1, callbacks: { label: (c) => c.dataset.label + ': ' + c.parsed.y.toFixed(2) + '%' } } },
    scales: { x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 8 } }, y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', callback: v => v.toFixed(1) + '%' } } }
  }
});`;
}

function buildMonthlyHeatmap(curve: Array<{ date: string; equity: number }>): string {
	const monthly = new Map<string, { start: number; end: number }>();
	for (const p of curve) {
		const d = new Date(p.date);
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
		const entry = monthly.get(key);
		if (!entry) {
			monthly.set(key, { start: p.equity, end: p.equity });
		} else {
			entry.end = p.equity;
		}
	}

	const years = [...new Set([...monthly.keys()].map((k) => k.split("-")[0]))].sort();
	const months = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

	let html = '<div class="heatmap-grid"><div class="heatmap-header"></div>';
	for (const m of months) html += `<div class="heatmap-header">${+m}月</div>`;
	for (const y of years) {
		html += `<div class="heatmap-year">${y}</div>`;
		for (const m of months) {
			const key = `${y}-${m}`;
			const entry = monthly.get(key);
			if (!entry) {
				html += '<div class="heatmap-cell" style="background:transparent;color:var(--text-muted)">-</div>';
				continue;
			}
			const ret = ((entry.end - entry.start) / entry.start) * 100;
			const intensity = Math.min(Math.abs(ret) / 10, 1);
			const bg =
				ret >= 0 ? `rgba(248,81,73,${0.15 + intensity * 0.55})` : `rgba(63,185,80,${0.15 + intensity * 0.55})`;
			const color = ret >= 0 ? "var(--red)" : "var(--green)";
			html += `<div class="heatmap-cell" style="background:${bg};color:${color}">${ret.toFixed(1)}%</div>`;
		}
	}
	html += "</div>";
	return html;
}

function buildTradeRows(
	trades: PoolTrade[],
	fmtNum: (n: number | undefined, digits?: number) => string,
	fmtPct: (n: number | undefined) => string,
): string {
	return trades
		.map((t, i) => {
			const dirCls = t.direction === "buy" ? "buy" : "sell";
			const dirText = t.direction === "buy" ? "买入" : "卖出";
			const pnlCls = t.pnl == null ? "" : t.pnl > 0 ? "pos" : t.pnl < 0 ? "neg" : "";
			return `<tr>
      <td class="num">${i + 1}</td>
      <td>${t.date}</td>
      <td class="${dirCls}">${dirText}</td>
      <td>${escapeHtml(t.code)}</td>
      <td class="num">${t.shares.toLocaleString("zh-CN")}</td>
      <td class="num">${fmtNum(t.price)}</td>
      <td class="num">${fmtNum(t.amount)}</td>
      <td class="num">${t.daysHeld ?? "-"}</td>
      <td class="num ${pnlCls}">${t.pnl != null ? fmtNum(t.pnl) : "-"}</td>
      <td class="num ${pnlCls}">${t.pnlPct != null ? fmtPct(t.pnlPct) : "-"}</td>
      <td>${escapeHtml(t.memo ?? "")}</td>
    </tr>`;
		})
		.join("");
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
