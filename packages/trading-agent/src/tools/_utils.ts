import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const HOME = process.env.HOME || process.env.USERPROFILE || ".";

// Bundled skills take priority over external ones
const BUNDLED_A_SHARE_SCRIPTS = join(__dirname, "../../skills/a-share-analysis/scripts");
const EXTERNAL_A_SHARE_SCRIPTS = join(HOME, ".agents/skills/a-share-analysis/scripts");

const BUNDLED_LOCAL_DATA_SCRIPTS = join(__dirname, "../../skills/local-data/scripts");
const EXTERNAL_LOCAL_DATA_SCRIPTS = join(HOME, ".agents/skills/local-data/scripts");

const BUNDLED_NL_SCREENER_SCRIPTS = join(__dirname, "../../skills/nl-stock-screener/scripts");
const EXTERNAL_NL_SCREENER_SCRIPTS = join(HOME, ".agents/skills/nl-stock-screener/scripts");

const BUNDLED_CONCEPT_ANALYSIS_SCRIPTS = join(__dirname, "../../skills/concept-analysis/scripts");
const EXTERNAL_CONCEPT_ANALYSIS_SCRIPTS = join(HOME, ".agents/skills/concept-analysis/scripts");

const BUNDLED_A_STOCK_DATA_SCRIPTS = join(__dirname, "../../skills/a-stock-data/scripts");
const EXTERNAL_A_STOCK_DATA_SCRIPTS = join(HOME, ".agents/skills/a-stock-data/scripts");

const BUNDLED_STOCK_RADAR_SCRIPTS = join(__dirname, "../../skills/stock-radar/scripts");
const EXTERNAL_STOCK_RADAR_SCRIPTS = join(HOME, ".agents/skills/stock-radar/scripts");

/** Resolve script path: bundled takes priority over external. */
export function resolveScriptPath(scriptName: string, bundledDir: string, externalDir: string): string {
	const bundled = join(bundledDir, scriptName);
	if (existsSync(bundled)) return bundled;
	return join(externalDir, scriptName);
}

/** Resolve a-share script path (bundled优先). */
export function resolveAShareScript(scriptName: string): string {
	return resolveScriptPath(scriptName, BUNDLED_A_SHARE_SCRIPTS, EXTERNAL_A_SHARE_SCRIPTS);
}

/** Resolve local-data script path (bundled优先). */
export function resolveLocalDataScript(scriptName: string): string {
	return resolveScriptPath(scriptName, BUNDLED_LOCAL_DATA_SCRIPTS, EXTERNAL_LOCAL_DATA_SCRIPTS);
}

/** Resolve nl-screener script path (bundled优先). */
export function resolveNLScreenerScript(scriptName: string): string {
	return resolveScriptPath(scriptName, BUNDLED_NL_SCREENER_SCRIPTS, EXTERNAL_NL_SCREENER_SCRIPTS);
}

/** Resolve concept-analysis script path (bundled优先). */
export function resolveConceptAnalysisScript(scriptName: string): string {
	return resolveScriptPath(scriptName, BUNDLED_CONCEPT_ANALYSIS_SCRIPTS, EXTERNAL_CONCEPT_ANALYSIS_SCRIPTS);
}

/** Resolve a-stock-data script path (bundled优先). */
export function resolveAStockDataScript(scriptName: string): string {
	return resolveScriptPath(scriptName, BUNDLED_A_STOCK_DATA_SCRIPTS, EXTERNAL_A_STOCK_DATA_SCRIPTS);
}

/** Resolve stock-radar script path (bundled优先). */
export function resolveStockRadarScript(scriptName: string): string {
	return resolveScriptPath(scriptName, BUNDLED_STOCK_RADAR_SCRIPTS, EXTERNAL_STOCK_RADAR_SCRIPTS);
}

// Legacy export for backward compatibility
export const SCRIPTS_DIR = EXTERNAL_A_SHARE_SCRIPTS;

const DEFAULT_TIMEOUT_MS = 30000;

/** In-flight Python script executions keyed by script+args. Prevents duplicate
 *  concurrent subprocesses for identical calls (e.g. frontend polling the same
 *  stock quote simultaneously). */
const inFlight = new Map<string, Promise<string>>();

function runPythonCommand(cmd: string, script: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		// Resolve script path if not absolute (bundled takes priority)
		const scriptPath = script.startsWith("/") || script.includes(":") ? script : resolveAShareScript(script);
		const cwd = dirname(scriptPath);
		const proc = spawn(cmd, [scriptPath, ...args], {
			cwd,
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
	const key = `${script}\0${args.join("\0")}`;
	const existing = inFlight.get(key);
	if (existing) {
		return existing;
	}

	const promise = (async (): Promise<string> => {
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
	})();

	inFlight.set(key, promise);
	promise.then(
		() => inFlight.delete(key),
		() => inFlight.delete(key),
	);

	return promise;
}

/** Run a Python script with a specific interpreter and working directory.
 *  Used for calling external toolchains like tq_tool with their own venv.
 */
export async function runPythonCustom(
	pythonPath: string,
	scriptPath: string,
	args: string[],
	cwd: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const fullCmd = `${pythonPath} ${scriptPath} ${args.join(" ")}`;
		console.log(`[runPythonCustom] Spawn: ${fullCmd}\n  cwd=${cwd}`);
		const proc = spawn(pythonPath, [scriptPath, ...args], {
			cwd,
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
			reject(new Error(`Python script timed out after ${timeoutMs}ms: ${scriptPath}`));
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
			console.error(`[runPythonCustom] Process error: ${err.message}`);
			reject(err);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) return;
			console.log(`[runPythonCustom] Exit code: ${code}, stderr: ${stderr.trim() || "(empty)"}`);
			if (code !== 0) {
				reject(new Error(stderr.trim() || `Python script exited with code ${code}`));
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

export async function runJsonScript(script: string, args: string[], timeoutMs?: number): Promise<any> {
	const stdout = await runPython(script, args, timeoutMs);
	const start = stdout.search(/[[{]/);
	if (start === -1) {
		throw new Error(`No JSON found in script output: ${stdout.slice(0, 200)}`);
	}
	return JSON.parse(stdout.slice(start));
}

/** Run a Python script from the a-stock-data skill directory and parse JSON output. */
export async function runAStockDataJsonScript(script: string, args: string[], timeoutMs?: number): Promise<any> {
	const scriptPath = resolveAStockDataScript(script);
	const stdout = await runPython(scriptPath, args, timeoutMs);
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
