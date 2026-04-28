import { type Job, scheduleJob } from "node-schedule";
import type { SessionMemory } from "../core/session-memory.js";
import type { TradingSession } from "../core/trading-session.js";

export interface Routine {
	name: string;
	schedule: string;
	timezone: string;
	fn: (session: TradingSession, memory?: SessionMemory) => Promise<void>;
}

export class TaskScheduler {
	private jobs: Map<string, Job> = new Map();
	private routines: Map<string, Routine> = new Map();

	register(routine: Routine): void {
		this.routines.set(routine.name, routine);
	}

	start(session: TradingSession, memory?: SessionMemory): void {
		for (const [name, routine] of this.routines) {
			// Cancel existing job before creating a new one to prevent leaks
			if (this.jobs.has(name)) {
				this.jobs.get(name)!.cancel();
			}
			const job = scheduleJob({ rule: routine.schedule, tz: routine.timezone }, async () => {
				console.log(`[Scheduler] Routine "${name}" triggered at ${new Date().toISOString()}`);
				try {
					await routine.fn(session, memory);
				} catch (err) {
					console.error(`[Scheduler] Routine "${name}" failed:`, err);
				}
			});
			this.jobs.set(name, job);
			console.log(`[Scheduler] Registered "${name}" with schedule "${routine.schedule}" (${routine.timezone})`);
		}
	}

	stop(): void {
		for (const [name, job] of this.jobs) {
			job.cancel();
			console.log(`[Scheduler] Cancelled "${name}"`);
		}
		this.jobs.clear();
	}

	async runNow(name: string, session: TradingSession, memory?: SessionMemory): Promise<void> {
		const routine = this.routines.get(name);
		if (!routine) throw new Error(`Routine "${name}" not found`);
		console.log(`[Scheduler] Manually running "${name}"...`);
		await routine.fn(session, memory);
	}
}
