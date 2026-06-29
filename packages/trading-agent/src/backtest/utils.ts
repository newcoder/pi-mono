/**
 * Shared math/date utilities used across the backtest module.
 * Consolidates functions that were duplicated in 2-6 places.
 */

/** Round to `digits` decimal places (default 4). */
export function round(v: number, digits = 4): number {
	const mult = 10 ** digits;
	return Math.round(v * mult) / mult;
}

/** Arithmetic mean of valid numbers. Returns 0 for empty input. */
export function average(values: Array<number | null | undefined>): number {
	const valid = values.filter((v): v is number => v != null && !Number.isNaN(v));
	if (valid.length === 0) return 0;
	return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/** Population standard deviation. Requires pre-computed mean. */
export function stdDev(values: Array<number | null | undefined>, mean: number): number {
	let sqSum = 0;
	let count = 0;
	for (const v of values) {
		if (v != null && !Number.isNaN(v)) {
			sqSum += (v - mean) ** 2;
			count++;
		}
	}
	return count > 0 ? Math.sqrt(sqSum / count) : 0;
}

/** Number of whole days between two YYYY-MM-DD strings (UTC-safe). */
export function daysBetween(a: string, b: string): number {
	const da = new Date(`${a}T00:00:00Z`);
	const db = new Date(`${b}T00:00:00Z`);
	return Math.round(Math.abs(db.getTime() - da.getTime()) / 86_400_000);
}

/** Convert YYYYMMDD to YYYY-MM-DD. Returns input unchanged if not 8 digits. */
export function yyyymmddToDate(yyyymmdd: string | undefined, fallback: string): string {
	if (!yyyymmdd || yyyymmdd.length !== 8) return fallback;
	return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
