import WebSocket from "ws";

const WS_URL = process.env.TRADING_AGENT_WS_URL || "ws://localhost:3000";
const PROMPT = `请使用 backtest_strategy 工具对 53 号自选股股池进行回测：
- 策略：supertrend
- 开始日期：20230615
- 结束日期：20260612
- 初始资金：100000000（1 亿元）
- 满仓等权：full_position=true, full_position_mode=equal_weight
- 基准指数：sh000905,sh000300
- 保存最终持仓为新股票池：save_holdings_as_pool=true

请直接调用工具执行，并告诉我回测结果、HTML 报告链接以及保存的股池名称。`;

const TIMEOUT_MS = Number(process.env.TRADING_AGENT_TEST_TIMEOUT) || 5 * 60 * 1000;

function log(...args) {
	const ts = new Date().toISOString().slice(11, 23);
	console.log(`[${ts}]`, ...args);
}

async function main() {
	log(`Connecting to ${WS_URL} ...`);

	const ws = new WebSocket(WS_URL);

	let finished = false;
	const events = [];
	let toolStart = null;
	let toolEnd = null;
	let assistantText = "";

	const timeout = setTimeout(() => {
		log("TIMEOUT: test did not finish within", TIMEOUT_MS, "ms");
		ws.close();
	}, TIMEOUT_MS);

	ws.on("open", () => {
		log("WebSocket connected");
		ws.send(JSON.stringify({ type: "prompt", message: PROMPT }));
		log("Prompt sent");
	});

	ws.on("message", (data) => {
		let msg;
		try {
			msg = JSON.parse(data.toString("utf-8"));
		} catch (err) {
			log("Failed to parse WS message:", data.toString("utf-8").slice(0, 200));
			return;
		}

		events.push(msg);

		if (msg.type === "connected") {
			log("Server ack:", msg.message);
			return;
		}

		if (msg.type === "agent_event") {
			const ev = msg.event;
			switch (ev?.type) {
				case "message_update": {
					const delta = ev.assistantMessageEvent;
					if (delta?.type === "text_delta") {
						assistantText += delta.delta || "";
					}
					break;
				}
				case "tool_execution_start": {
					log(`Tool start: ${ev.toolName}`, JSON.stringify(ev.args).slice(0, 200));
					if (ev.toolName === "backtest_strategy") {
						toolStart = { toolCallId: ev.toolCallId, args: ev.args, time: Date.now() };
					}
					break;
				}
				case "tool_execution_update": {
					// partial results are not used in this test
					break;
				}
				case "tool_execution_end": {
					log(`Tool end: ${ev.toolName} isError=${ev.isError}`);
					if (ev.toolName === "backtest_strategy") {
						toolEnd = {
							toolCallId: ev.toolCallId,
							isError: ev.isError,
							result: ev.result,
							durationMs: toolStart ? Date.now() - toolStart.time : undefined,
						};
					}
					break;
				}
				case "agent_end": {
					log("Agent run ended");
					finished = true;
					clearTimeout(timeout);
					ws.close();
					break;
				}
				default:
					// ignore other events
					break;
			}
		}
	});

	ws.on("error", (err) => {
		log("WebSocket error:", err.message);
		clearTimeout(timeout);
		process.exit(1);
	});

	ws.on("close", () => {
		log("WebSocket closed");
		clearTimeout(timeout);
		printSummary();
		process.exit(finished && toolEnd && !toolEnd.isError ? 0 : 1);
	});

	function printSummary() {
		console.log("\n========== BACKTEST STRATEGY AUTO TEST SUMMARY ==========");
		console.log("Assistant text preview:\n", assistantText.slice(0, 600));
		if (toolStart) {
			console.log("\nbacktest_strategy CALL DETECTED");
			console.log("  args:", JSON.stringify(toolStart.args, null, 2));
		} else {
			console.log("\nbacktest_strategy CALL NOT DETECTED");
		}
		if (toolEnd) {
			console.log("\nbacktest_strategy RESULT");
			console.log("  isError:", toolEnd.isError);
			if (toolEnd.durationMs != null) console.log("  durationMs:", toolEnd.durationMs);
			const details = toolEnd.result?.details || {};
			console.log("  poolName:", details.poolName);
			console.log("  strategy:", details.strategy);
			console.log("  reportUrl:", details.reportUrl);
			console.log("  holdingsPoolId:", details.holdingsPoolId);
			console.log("  holdingsPoolName:", details.holdingsPoolName);
			const metrics = details.metrics || {};
			console.log("  metrics:", {
				totalReturn: metrics.totalReturn,
				annualizedReturn: metrics.annualizedReturn,
				maxDrawdown: metrics.maxDrawdown,
				winRate: metrics.winRate,
			});
			if (toolEnd.result?.content?.[0]?.text) {
				console.log("\nTool result text:\n", toolEnd.result.content[0].text);
			}
		}
		console.log("=========================================================\n");
	}
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
