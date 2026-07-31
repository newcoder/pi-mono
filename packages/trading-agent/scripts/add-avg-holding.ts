import fs from "node:fs";
import path from "node:path";

const HOME = process.env.HOME || process.env.USERPROFILE || ".";
const REPORT_DIR = path.join(HOME, ".trading-agent", "reports");

function parseAvgHoldingDays(html: string): number | null {
	const m = html.match(/平均持仓天数<\/div><div[^>]*>([\d.]+)/);
	return m ? Number(m[1]) : null;
}

function addAvgHolding(jsonPath: string) {
	const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as any[];
	for (const row of data) {
		if (!row.reportUrl) continue;
		const fileName = decodeURIComponent(path.basename(new URL(row.reportUrl).pathname));
		const reportPath = path.join(REPORT_DIR, fileName);
		if (fs.existsSync(reportPath)) {
			const html = fs.readFileSync(reportPath, "utf-8");
			const days = parseAvgHoldingDays(html);
			if (days != null) row.avgHoldingDays = days;
		}
	}
	const outPath = jsonPath.replace(".json", "_with_holding.json");
	fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
	console.log(`Wrote ${outPath}`);
}

for (const file of ["backtest_rankby_sw2.json", "backtest_rankby_sw2_max10.json"]) {
	if (fs.existsSync(file)) addAvgHolding(file);
}
