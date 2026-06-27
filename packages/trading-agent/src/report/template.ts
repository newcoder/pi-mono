// ─── HTML Report Template ───────────────────────────────────────────────────
// Self-contained HTML file with embedded CSS, Chart.js from CDN, and data.

export const REPORT_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{TITLE}}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
:root {
  --bg: #0f1419;
  --bg-card: #161b22;
  --bg-hover: #1c2128;
  --border: #30363d;
  --text: #c9d1d9;
  --text-secondary: #8b949e;
  --text-muted: #484f58;
  --accent: #58a6ff;
  --accent-dim: #388bfd;
  --green: #3fb950;
  --red: #f85149;
  --orange: #f0883e;
  --yellow: #d29922;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
  --font-mono: "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
}
.container { max-width: 1200px; margin: 0 auto; padding: 24px; }
header {
  border-bottom: 1px solid var(--border);
  padding-bottom: 20px;
  margin-bottom: 24px;
}
header h1 { font-size: 1.6rem; font-weight: 600; color: #fff; margin-bottom: 8px; }
header .subtitle {
  font-size: 0.9rem;
  color: var(--text-secondary);
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
header .subtitle span { display: inline-flex; align-items: center; gap: 4px; }

/* Metric Cards */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.metric-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  text-align: center;
  transition: border-color .2s;
}
.metric-card:hover { border-color: var(--accent-dim); }
.metric-card .label {
  font-size: 0.75rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}
.metric-card .value {
  font-size: 1.4rem;
  font-weight: 700;
  font-family: var(--font-mono);
}
.metric-card .value.pos { color: var(--red); }
.metric-card .value.neg { color: var(--green); }
.metric-card .value.neu { color: var(--text); }

/* Chart Section */
.chart-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  margin-bottom: 24px;
}
.chart-section h2 {
  font-size: 1rem;
  font-weight: 600;
  color: #fff;
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.chart-wrapper { position: relative; height: 360px; }

/* Tables */
.table-section {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 20px;
  margin-bottom: 24px;
}
.table-section h2 {
  font-size: 1rem;
  font-weight: 600;
  color: #fff;
  margin-bottom: 16px;
}
.table-wrapper { overflow-x: auto; }
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th, td { padding: 10px 12px; text-align: left; }
th {
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-weight: 500;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
td { border-bottom: 1px solid var(--border); color: var(--text); }
tr:hover td { background: var(--bg-hover); }
td.num { font-family: var(--font-mono); text-align: right; }
td.pos { color: var(--red); }
td.neg { color: var(--green); }
td.buy { color: var(--red); font-weight: 500; }
td.sell { color: var(--green); font-weight: 500; }

/* Monthly Heatmap */
.heatmap-grid {
  display: grid;
  grid-template-columns: 60px repeat(12, 1fr);
  gap: 3px;
  font-size: 0.75rem;
}
.heatmap-cell {
  padding: 6px 4px;
  text-align: center;
  border-radius: 4px;
  font-family: var(--font-mono);
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.heatmap-header {
  color: var(--text-secondary);
  font-weight: 500;
}
.heatmap-year {
  color: var(--text-secondary);
  font-weight: 500;
  text-align: right;
  padding-right: 8px;
}

/* Footer */
footer {
  text-align: center;
  color: var(--text-muted);
  font-size: 0.8rem;
  padding: 24px;
  border-top: 1px solid var(--border);
}

/* Responsive */
@media (max-width: 768px) {
  .container { padding: 12px; }
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .chart-wrapper { height: 260px; }
  th, td { padding: 8px; font-size: 0.8rem; }
}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>{{TITLE}}</h1>
  <div class="subtitle">
    <span>&#128197; {{DATE_RANGE}}</span>
    <span>&#128176; 初始资金 {{INITIAL_CAPITAL}}</span>
    <span>&#128295; {{STRATEGY}}</span>
    <span>&#128336; 生成于 {{GENERATED_AT}}</span>
  </div>
</header>

<section class="metrics" id="metrics"></section>

<section class="chart-section">
  <h2>&#128200; 收益曲线</h2>
  <div class="chart-wrapper">
    <canvas id="equityChart"></canvas>
  </div>
</section>

<section class="chart-section">
  <h2>&#128200; 回撤曲线</h2>
  <div class="chart-wrapper">
    <canvas id="drawdownChart"></canvas>
  </div>
</section>

<section class="table-section">
  <h2>&#128203; 月度收益 (%)</h2>
  <div id="monthlyHeatmap"></div>
</section>

<section class="table-section">
  <h2>&#128260; 调仓明细</h2>
  <div class="table-wrapper">
    <table id="tradesTable">
      <thead>
        <tr>
          <th>序号</th>
          <th>日期</th>
          <th>方向</th>
          <th>代码</th>
          <th>数量</th>
          <th>价格</th>
          <th>金额</th>
          <th>持仓天数</th>
          <th>盈亏</th>
          <th>盈亏率</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody id="tradesBody"></tbody>
    </table>
  </div>
</section>

<footer>
  由 Trading Agent 自动生成 &middot; pi-mono
</footer>
</div>

<script>
const REPORT = {{REPORT_DATA}};

// ── Helpers ──────────────────────────────────────────────────────
const fmtNum = (n, d=2) => n == null ? '-' : n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (n) => {
  if (n == null) return '-';
  const s = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  return s;
};
const clsVal = (n) => n == null ? 'neu' : (n > 0 ? 'pos' : n < 0 ? 'neg' : 'neu');
const clsTd = (n) => '<span class="' + clsVal(n) + '">' + fmtPct(n) + '</span>';

// ── Metric Cards ─────────────────────────────────────────────────
const metricsEl = document.getElementById('metrics');
const cards = [
  { label: '总收益率', value: fmtPct(REPORT.metrics.totalReturn), cls: clsVal(REPORT.metrics.totalReturn) },
  { label: '年化收益率', value: fmtPct(REPORT.metrics.annualizedReturn), cls: clsVal(REPORT.metrics.annualizedReturn) },
  { label: '夏普比率', value: fmtNum(REPORT.metrics.sharpeRatio), cls: 'neu' },
  { label: '最大回撤', value: fmtPct(REPORT.metrics.maxDrawdown), cls: 'neg' },
  { label: '最大回撤天数', value: REPORT.metrics.maxDrawdownDuration ?? '-', cls: 'neu' },
  { label: '胜率', value: fmtPct(REPORT.metrics.winRate), cls: clsVal(REPORT.metrics.winRate) },
  { label: '盈亏比', value: fmtNum(REPORT.metrics.profitFactor), cls: 'neu' },
  { label: '交易次数', value: String(REPORT.metrics.totalTrades ?? REPORT.trades.length), cls: 'neu' },
  { label: '平均盈利', value: fmtNum(REPORT.metrics.avgWin), cls: 'pos' },
  { label: '平均亏损', value: fmtNum(REPORT.metrics.avgLoss), cls: 'neg' },
  { label: '平均持仓天数', value: fmtNum(REPORT.metrics.avgHoldingDays, 1), cls: 'neu' },
];
for (const b of REPORT.benchmarks || []) {
  cards.push({ label: b.label + '总收益', value: fmtPct(b.totalReturn), cls: clsVal(b.totalReturn) });
  cards.push({ label: b.label + '最大回撤', value: fmtPct(-b.maxDrawdown), cls: 'neg' });
}
metricsEl.innerHTML = cards.map(m =>
  '<div class="metric-card">' +
    '<div class="label">' + m.label + '</div>' +
    '<div class="value ' + m.cls + '">' + m.value + '</div>' +
  '</div>'
).join('');

// ── Equity Curve Chart ───────────────────────────────────────────
const fmtEq = (n) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eqCtx = document.getElementById('equityChart').getContext('2d');
const eqLabels = REPORT.equityCurve.map(p => p.date);
const eqData = REPORT.equityCurve.map(p => p.equity);

const eqDatasets = [{
  label: '净值',
  data: eqData,
  borderColor: '#58a6ff',
  backgroundColor: 'rgba(88,166,255,0.08)',
  fill: true,
  tension: 0.1,
  pointRadius: 0,
  pointHoverRadius: 4,
  borderWidth: 1.5,
}];
for (let i = 0; i < (REPORT.benchmarks || []).length; i++) {
  const b = REPORT.benchmarks[i];
  eqDatasets.push({
    label: b.label,
    data: b.equityCurve.map(p => p.equity),
    borderColor: i === 0 ? '#f0883e' : '#3fb950',
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.1,
    pointRadius: 0,
    pointHoverRadius: 4,
    borderWidth: 1.2,
    borderDash: i === 0 ? [4, 4] : [2, 2],
  });
}

new Chart(eqCtx, {
  type: 'line',
  data: { labels: eqLabels, datasets: eqDatasets },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#c9d1d9' } },
      tooltip: {
        backgroundColor: '#161b22',
        titleColor: '#c9d1d9',
        bodyColor: '#c9d1d9',
        borderColor: '#30363d',
        borderWidth: 1,
        callbacks: { label: (ctx) => ctx.dataset.label + ': ' + fmtEq(ctx.parsed.y) }
      }
    },
    scales: {
      x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 8 } },
      y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', callback: v => v.toLocaleString() } }
    }
  }
});

// ── Drawdown Chart ───────────────────────────────────────────────
const computeDrawdown = (curve) => {
  let peak = curve[0]?.equity ?? 0;
  return curve.map(p => {
    if (p.equity > peak) peak = p.equity;
    return peak > 0 ? ((p.equity - peak) / peak) * 100 : 0;
  });
};

const ddCtx = document.getElementById('drawdownChart').getContext('2d');
const ddDatasets = [{
  label: '回撤',
  data: computeDrawdown(REPORT.equityCurve),
  borderColor: '#f85149',
  backgroundColor: 'rgba(248,81,73,0.1)',
  fill: true,
  tension: 0.1,
  pointRadius: 0,
  pointHoverRadius: 4,
  borderWidth: 1.5,
}];
for (let i = 0; i < (REPORT.benchmarks || []).length; i++) {
  const b = REPORT.benchmarks[i];
  ddDatasets.push({
    label: b.label + '回撤',
    data: computeDrawdown(b.equityCurve),
    borderColor: i === 0 ? '#f0883e' : '#3fb950',
    backgroundColor: 'transparent',
    fill: false,
    tension: 0.1,
    pointRadius: 0,
    pointHoverRadius: 4,
    borderWidth: 1.2,
    borderDash: i === 0 ? [4, 4] : [2, 2],
  });
}

new Chart(ddCtx, {
  type: 'line',
  data: { labels: eqLabels, datasets: ddDatasets },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#c9d1d9' } },
      tooltip: {
        backgroundColor: '#161b22',
        titleColor: '#c9d1d9',
        bodyColor: '#c9d1d9',
        borderColor: '#30363d',
        borderWidth: 1,
        callbacks: { label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.y.toFixed(2) + '%' }
      }
    },
    scales: {
      x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', maxTicksLimit: 8 } },
      y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', callback: v => v.toFixed(1) + '%' } }
    }
  }
});

// ── Monthly Heatmap ──────────────────────────────────────────────
function buildMonthlyHeatmap() {
  const monthly = {};
  for (const p of REPORT.equityCurve) {
    const d = new Date(p.date);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    if (!monthly[key]) monthly[key] = { start: p.equity, end: p.equity, first: p.date, last: p.date };
    monthly[key].end = p.equity;
    monthly[key].last = p.date;
  }

  const years = [...new Set(Object.keys(monthly).map(k => k.split('-')[0]))].sort();
  const months = ['01','02','03','04','05','06','07','08','09','10','11','12'];

  let html = '<div class="heatmap-grid">';
  html += '<div class="heatmap-header"></div>';
  for (const m of months) html += '<div class="heatmap-header">' + +m + '月</div>';

  for (const y of years) {
    html += '<div class="heatmap-year">' + y + '</div>';
    for (const m of months) {
      const key = y + '-' + m;
      const data = monthly[key];
      if (!data) {
        html += '<div class="heatmap-cell" style="background:transparent;color:var(--text-muted)">-</div>';
        continue;
      }
      const ret = ((data.end - data.start) / data.start) * 100;
      const intensity = Math.min(Math.abs(ret) / 10, 1);
      const color = ret >= 0
        ? 'rgba(248,81,73,' + (0.15 + intensity * 0.55) + ')'
        : 'rgba(63,185,80,' + (0.15 + intensity * 0.55) + ')';
      const textColor = ret >= 0 ? 'var(--red)' : 'var(--green)';
      html += '<div class="heatmap-cell" style="background:' + color + ';color:' + textColor + '">' + ret.toFixed(1) + '%</div>';
    }
  }
  html += '</div>';
  document.getElementById('monthlyHeatmap').innerHTML = html;
}
buildMonthlyHeatmap();

// ── Trades Table ─────────────────────────────────────────────────
const tbody = document.getElementById('tradesBody');
tbody.innerHTML = REPORT.trades.map((t, i) => {
  const dirCls = t.direction === 'buy' ? 'buy' : 'sell';
  const dirText = t.direction === 'buy' ? '买入' : '卖出';
  const pnlCls = t.pnl == null ? '' : (t.pnl > 0 ? 'pos' : t.pnl < 0 ? 'neg' : '');
  return '<tr>' +
    '<td class="num">' + (i+1) + '</td>' +
    '<td>' + t.date + '</td>' +
    '<td class="' + dirCls + '">' + dirText + '</td>' +
    '<td>' + (t.code || '') + '</td>' +
    '<td class="num">' + fmtNum(t.quantity, 0) + '</td>' +
    '<td class="num">' + fmtNum(t.price) + '</td>' +
    '<td class="num">' + fmtNum(t.amount) + '</td>' +
    '<td class="num">' + (t.holdingDays ?? '-') + '</td>' +
    '<td class="num ' + pnlCls + '">' + (t.pnl != null ? fmtNum(t.pnl) : '-') + '</td>' +
    '<td class="num ' + pnlCls + '">' + (t.pnlPct != null ? fmtPct(t.pnlPct) : '-') + '</td>' +
    '<td>' + (t.memo || '') + '</td>' +
  '</tr>';
}).join('');
</script>
</body>
</html>`;
