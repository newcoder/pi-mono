import { spawn } from "node:child_process";
import { join } from "node:path";

export const SCRIPTS_DIR = join(
	process.env.HOME || process.env.USERPROFILE || ".",
	".agents/skills/a-share-analysis/scripts",
);

const DEFAULT_TIMEOUT_MS = 30000;

function runPythonCommand(cmd: string, script: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, [script, ...args], {
			cwd: SCRIPTS_DIR,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			setTimeout(() => proc.kill("SIGKILL"), 5000);
			reject(new Error(`Python script timed out after ${timeoutMs}ms: ${script}`));
		}, timeoutMs);

		proc.stdout.setEncoding("utf-8");
		proc.stderr.setEncoding("utf-8");
		proc.stdout.on("data", (d) => {
			stdout += d;
		});
		proc.stderr.on("data", (d) => {
			stderr += d;
		});
		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return;
			if (code !== 0) {
				reject(new Error(stderr.trim() || `Python script exited with code ${code}`));
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

export async function runPython(script: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
	const commands = ["python3", "python", "py"];
	let lastError: Error | undefined;

	for (const cmd of commands) {
		try {
			return await runPythonCommand(cmd, script, args, timeoutMs);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (
				message.includes("ENOENT") ||
				message.includes("not found") ||
				message.includes("not recognized") ||
				message.includes("No such file")
			) {
				continue;
			}
			lastError = err instanceof Error ? err : new Error(message);
		}
	}

	throw lastError ?? new Error(`No Python interpreter found. Tried: ${commands.join(", ")}`);
}

export async function runJsonScript(script: string, args: string[], timeoutMs?: number): Promise<any> {
	const stdout = await runPython(script, args, timeoutMs);
	const start = stdout.search(/[[{]/);
	if (start === -1) {
		throw new Error(`No JSON found in script output: ${stdout.slice(0, 200)}`);
	}
	return JSON.parse(stdout.slice(start));
}

export function formatNumber(n: number | null | undefined, digits = 2): string {
	if (n == null || Number.isNaN(n)) return "—";
	if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(digits)}亿`;
	if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(digits)}万`;
	return n.toFixed(digits);
}
