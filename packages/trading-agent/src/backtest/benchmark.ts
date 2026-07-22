import { spawn } from "node:child_process";

export interface IndexPoint {
	date: string;
	close: number;
}

/** Run Python subprocess and return stdout. Times out after `timeoutMs`. */
function runPythonAsync(code: string, args: string[], timeoutMs = 30_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn("python", ["-c", code, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 3000);
			reject(new Error("Python index fetch timed out"));
		}, timeoutMs);

		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		proc.stdout.on("data", (d: string) => { stdout += d; });
		proc.stderr.on("data", (d: string) => { stderr += d; });
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new Error(stderr.trim() || `exit code ${code}`));
			else resolve(stdout.trim());
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Fetch daily index closes from akshare for the given symbol (e.g. "sh000905").
 * Dates are inclusive and formatted as YYYY-MM-DD.
 */
export async function fetchIndexCurve(symbol: string, start: string, end: string): Promise<IndexPoint[]> {
	const pythonCode = `
import akshare as ak
import json, sys
import pandas as pd

symbol = sys.argv[1]
start = sys.argv[2]
end = sys.argv[3]

df = ak.stock_zh_index_daily_tx(symbol=symbol)
df['date'] = pd.to_datetime(df['date'])
mask = (df['date'] >= start) & (df['date'] <= end)
df = df.loc[mask].sort_values('date')
records = [{'date': d.strftime('%Y-%m-%d'), 'close': float(c)} for d, c in zip(df['date'], df['close'])]
print(json.dumps(records))
`;

	const stdout = await runPythonAsync(pythonCode, [symbol, start, end], 30_000);
	try {
		return JSON.parse(stdout) as IndexPoint[];
	} catch {
		throw new Error(`Invalid JSON from akshare for ${symbol}: ${stdout.slice(0, 200)}`);
	}
}

export interface BenchmarkCurve {
	label: string;
	equityCurve: Array<{ date: string; equity: number }>;
	totalReturn: number;
	maxDrawdown: number;
}

/**
 * Normalize an index curve to the same initial capital as the strategy, then align
 * it to the strategy's trading dates (forward-fill missing days).
 */
export function buildBenchmarkCurve(
	label: string,
	raw: IndexPoint[],
	strategyCurve: Array<{ date: string; equity: number }>,
	initialCapital: number,
): BenchmarkCurve {
	if (raw.length === 0 || strategyCurve.length === 0) {
		return { label, equityCurve: [], totalReturn: 0, maxDrawdown: 0 };
	}

	const base = raw[0].close;
	const ratio = base > 0 ? initialCapital / base : 1;
	const normalized = raw.map((p) => ({ date: p.date, equity: p.close * ratio }));
	const byDate = new Map(normalized.map((p) => [p.date, p.equity]));

	let last = normalized[0].equity;
	const equityCurve = strategyCurve.map((p) => {
		if (byDate.has(p.date)) last = byDate.get(p.date)!;
		return { date: p.date, equity: last };
	});

	const initial = equityCurve[0].equity;
	const final = equityCurve[equityCurve.length - 1].equity;
	const totalReturn = initial > 0 ? ((final - initial) / initial) * 100 : 0;

	let peak = initial;
	let maxDrawdown = 0;
	for (const p of equityCurve) {
		if (p.equity > peak) peak = p.equity;
		const dd = peak > 0 ? ((peak - p.equity) / peak) * 100 : 0;
		if (dd > maxDrawdown) maxDrawdown = dd;
	}

	return { label, equityCurve, totalReturn, maxDrawdown };
}
