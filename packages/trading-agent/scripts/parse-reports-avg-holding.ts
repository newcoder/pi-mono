import fs from "node:fs";
import path from "node:path";

const REPORT_DIR = `${process.env.HOME || process.env.USERPROFILE || "."}/.trading-agent/reports`;

function parseAvgHoldingDays(html: string): number | null {
	const m = html.match(/平均持仓天数:\s*([\d.]+)/);
	return m ? Number(m[1]) : null;
}

function main() {
	const files = fs.readdirSync(REPORT_DIR).filter((f) => f.endsWith(".html") && f.includes("sw2龙头股池"));
	const out: Record<string, number> = {};
	for (const f of files) {
		const html = fs.readFileSync(path.join(REPORT_DIR, f), "utf-8");
		const days = parseAvgHoldingDays(html);
		if (days != null) out[f] = days;
	}
	console.log(JSON.stringify(out, null, 2));
}

main();
