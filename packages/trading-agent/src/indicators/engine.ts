import type { KlineRow } from "../data/types.js";

export interface MAConfig {
	period: number;
}

export interface MACDConfig {
	fast: number;
	slow: number;
	signal: number;
}

export interface RSIConfig {
	period: number;
}

export interface SupertrendConfig {
	period: number;
	multiplier: number;
}

export interface SupertrendResult {
	upper: (number | null)[];
	lower: (number | null)[];
	trend: ("up" | "down" | null)[];
	values: (number | null)[];
}

export interface CrossConfig {
	fast: number;
	slow: number;
}

export interface MAResult {
	values: (number | null)[];
}

export interface MACDResult {
	dif: (number | null)[];
	dea: (number | null)[];
	hist: (number | null)[];
}

export interface RSIResult {
	values: (number | null)[];
}

export interface KDConfig {
	period: number;
	smoothK: number;
	smoothD: number;
}

export interface KDResult {
	k: (number | null)[];
	d: (number | null)[];
}

export type CrossType = "golden" | "death" | "none";

export interface CrossResult {
	type: CrossType;
	index: number; // index in klines where cross occurred, -1 if none
}

// ─── Simple Moving Average ──────────────────────────────────────

export function computeMA(closes: (number | null)[], period: number): MAResult {
	const values: (number | null)[] = [];
	let sum = 0;
	let count = 0;

	for (let i = 0; i < closes.length; i++) {
		const c = closes[i];
		if (c != null) {
			sum += c;
			count++;
		}
		if (i >= period) {
			const old = closes[i - period];
			if (old != null) {
				sum -= old;
				count--;
			}
		}
		values.push(count >= period ? sum / count : null);
	}
	return { values };
}

// ─── Exponential Moving Average ─────────────────────────────────

function computeEMA(values: (number | null)[], period: number): (number | null)[] {
	const result: (number | null)[] = [];
	let ema: number | null = null;
	const multiplier = 2 / (period + 1);

	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v == null) {
			result.push(ema);
			continue;
		}
		if (ema == null) {
			// Initialize with SMA of first `period` values
			let sum = 0;
			let count = 0;
			for (let j = Math.max(0, i - period + 1); j <= i; j++) {
				if (values[j] != null) {
					sum += values[j]!;
					count++;
				}
			}
			ema = count > 0 ? sum / count : null;
		} else {
			ema = v * multiplier + ema * (1 - multiplier);
		}
		result.push(ema);
	}
	return result;
}

// ─── MACD ───────────────────────────────────────────────────────

export function computeMACD(
	closes: (number | null)[],
	config: MACDConfig = { fast: 12, slow: 26, signal: 9 },
): MACDResult {
	const emaFast = computeEMA(closes, config.fast);
	const emaSlow = computeEMA(closes, config.slow);
	const dif: (number | null)[] = [];
	for (let i = 0; i < closes.length; i++) {
		if (emaFast[i] != null && emaSlow[i] != null) {
			dif.push(emaFast[i]! - emaSlow[i]!);
		} else {
			dif.push(null);
		}
	}
	const dea = computeEMA(dif, config.signal);
	const hist: (number | null)[] = [];
	for (let i = 0; i < closes.length; i++) {
		if (dif[i] != null && dea[i] != null) {
			hist.push(2 * (dif[i]! - dea[i]!));
		} else {
			hist.push(null);
		}
	}
	return { dif, dea, hist };
}

// ─── RSI ────────────────────────────────────────────────────────

export function computeRSI(closes: (number | null)[], config: RSIConfig = { period: 14 }): RSIResult {
	const values: (number | null)[] = new Array(closes.length).fill(null);
	let avgGain = 0;
	let avgLoss = 0;
	let first = true;

	for (let i = 1; i < closes.length; i++) {
		const curr = closes[i];
		const prev = closes[i - 1];
		if (curr == null || prev == null) {
			values[i] = values[i - 1];
			continue;
		}
		const change = curr - prev;
		const gain = change > 0 ? change : 0;
		const loss = change < 0 ? -change : 0;

		if (first && i >= config.period) {
			// Initialize with simple average
			let gSum = 0;
			let lSum = 0;
			for (let j = i - config.period + 1; j <= i; j++) {
				const c = closes[j];
				const p = closes[j - 1];
				if (c != null && p != null) {
					const ch = c - p;
					gSum += ch > 0 ? ch : 0;
					lSum += ch < 0 ? -ch : 0;
				}
			}
			avgGain = gSum / config.period;
			avgLoss = lSum / config.period;
			first = false;
		} else if (!first) {
			avgGain = (avgGain * (config.period - 1) + gain) / config.period;
			avgLoss = (avgLoss * (config.period - 1) + loss) / config.period;
		}

		if (!first) {
			if (avgLoss === 0) {
				values[i] = avgGain === 0 ? 50 : 100;
			} else {
				const rs = avgGain / avgLoss;
				values[i] = 100 - 100 / (1 + rs);
			}
		}
	}
	return { values };
}

// ─── KD (Stochastic Oscillator) ─────────────────────────────────

export function computeKD(klines: KlineRow[], config: KDConfig = { period: 9, smoothK: 3, smoothD: 3 }): KDResult {
	const { period, smoothK, smoothD } = config;
	const n = klines.length;
	const k: (number | null)[] = new Array(n).fill(null);
	const d: (number | null)[] = new Array(n).fill(null);
	let prevK = 50;
	let prevD = 50;

	for (let i = period - 1; i < n; i++) {
		let highestHigh = -Infinity;
		let lowestLow = Infinity;
		for (let j = i - period + 1; j <= i; j++) {
			const h = klines[j].high;
			const l = klines[j].low;
			if (h != null) highestHigh = Math.max(highestHigh, h);
			if (l != null) lowestLow = Math.min(lowestLow, l);
		}
		const close = klines[i].close;
		if (highestHigh === -Infinity || lowestLow === Infinity || close == null) continue;

		const rsv = highestHigh === lowestLow ? 50 : ((close - lowestLow) / (highestHigh - lowestLow)) * 100;
		const currK: number = ((smoothK - 1) / smoothK) * prevK + (1 / smoothK) * rsv;
		const currD: number = ((smoothD - 1) / smoothD) * prevD + (1 / smoothD) * currK;

		k[i] = currK;
		d[i] = currD;
		prevK = currK;
		prevD = currD;
	}

	return { k, d };
}

// ─── Average True Range ─────────────────────────────────────────

function computeATR(
	highs: (number | null)[],
	lows: (number | null)[],
	closes: (number | null)[],
	period: number,
): (number | null)[] {
	const atr: (number | null)[] = new Array(closes.length).fill(null);
	let atrValue: number | null = null;

	for (let i = 0; i < closes.length; i++) {
		const h = highs[i];
		const l = lows[i];
		const c = closes[i];
		const prevC = i > 0 ? closes[i - 1] : null;
		if (h == null || l == null || c == null) continue;

		const tr1 = h - l;
		const tr2 = prevC != null ? Math.abs(h - prevC) : 0;
		const tr3 = prevC != null ? Math.abs(l - prevC) : 0;
		const tr = Math.max(tr1, tr2, tr3);

		if (atrValue == null) {
			// Wilder's smoothing initialization: simple average of first `period` TR values
			let sum = 0;
			let count = 0;
			for (let j = Math.max(0, i - period + 1); j <= i; j++) {
				const hj = highs[j];
				const lj = lows[j];
				const cj = closes[j];
				const pcj = j > 0 ? closes[j - 1] : null;
				if (hj == null || lj == null || cj == null) continue;
				const t1 = hj - lj;
				const t2 = pcj != null ? Math.abs(hj - pcj) : 0;
				const t3 = pcj != null ? Math.abs(lj - pcj) : 0;
				sum += Math.max(t1, t2, t3);
				count++;
			}
			if (count >= period) {
				atrValue = sum / period;
				atr[i] = atrValue;
			}
		} else {
			atrValue = (atrValue * (period - 1) + tr) / period;
			atr[i] = atrValue;
		}
	}
	return atr;
}

// ─── Supertrend ─────────────────────────────────────────────────

export function computeSupertrend(
	klines: KlineRow[],
	config: SupertrendConfig = { period: 10, multiplier: 3 },
): SupertrendResult {
	const period = config.period;
	const multiplier = config.multiplier;
	const n = klines.length;

	const closes = klines.map((k) => k.close);
	const highs = klines.map((k) => k.high);
	const lows = klines.map((k) => k.low);

	const upper: (number | null)[] = new Array(n).fill(null);
	const lower: (number | null)[] = new Array(n).fill(null);
	const trend: ("up" | "down" | null)[] = new Array(n).fill(null);
	const values: (number | null)[] = new Array(n).fill(null);

	const atr = computeATR(highs, lows, closes, period);

	let prevFinalUpper: number | null = null;
	let prevFinalLower: number | null = null;
	let prevTrend: "up" | "down" | null = null;

	for (let i = 0; i < n; i++) {
		const h = highs[i];
		const l = lows[i];
		const c = closes[i];
		const atrValue = atr[i];
		if (h == null || l == null || c == null || atrValue == null) continue;

		const mid = (h + l) / 2;
		const basicUpper = mid + multiplier * atrValue;
		const basicLower = mid - multiplier * atrValue;

		let finalUpper: number;
		let finalLower: number;
		if (prevFinalUpper != null && prevFinalLower != null) {
			finalUpper =
				basicUpper < prevFinalUpper || closes[i - 1] == null || closes[i - 1]! > prevFinalUpper
					? basicUpper
					: prevFinalUpper;
			finalLower =
				basicLower > prevFinalLower || closes[i - 1] == null || closes[i - 1]! < prevFinalLower
					? basicLower
					: prevFinalLower;
		} else {
			finalUpper = basicUpper;
			finalLower = basicLower;
		}

		let currentTrend: "up" | "down";
		if (prevTrend != null && prevFinalUpper != null && prevFinalLower != null) {
			if (prevTrend === "down" && c > prevFinalUpper) {
				currentTrend = "up";
			} else if (prevTrend === "up" && c < prevFinalLower) {
				currentTrend = "down";
			} else {
				currentTrend = prevTrend;
			}
		} else {
			currentTrend = c > mid ? "up" : "down";
		}

		upper[i] = finalUpper;
		lower[i] = finalLower;
		trend[i] = currentTrend;
		values[i] = currentTrend === "up" ? finalLower : finalUpper;

		prevFinalUpper = finalUpper;
		prevFinalLower = finalLower;
		prevTrend = currentTrend;
	}

	return { upper, lower, trend, values };
}

// ─── Cross Detection ────────────────────────────────────────────

export function detectCross(fastValues: (number | null)[], slowValues: (number | null)[]): CrossResult {
	for (let i = 1; i < fastValues.length; i++) {
		const fPrev = fastValues[i - 1];
		const sPrev = slowValues[i - 1];
		const fCurr = fastValues[i];
		const sCurr = slowValues[i];
		if (fPrev == null || sPrev == null || fCurr == null || sCurr == null) continue;

		if (fPrev <= sPrev && fCurr > sCurr) {
			return { type: "golden", index: i };
		}
		if (fPrev >= sPrev && fCurr < sCurr) {
			return { type: "death", index: i };
		}
	}
	return { type: "none", index: -1 };
}

// ─── Kline-based helpers ────────────────────────────────────────

export function getCloses(klines: KlineRow[]): (number | null)[] {
	return klines.map((k) => k.close);
}

export function getVolumes(klines: KlineRow[]): (number | null)[] {
	return klines.map((k) => k.volume);
}

/**
 * Check if a golden cross occurred on the latest day for given MA periods.
 */
export function hasGoldenCross(klines: KlineRow[], fast: number, slow: number): boolean {
	if (klines.length < slow + 1) return false;
	const closes = getCloses(klines);
	const maFast = computeMA(closes, fast);
	const maSlow = computeMA(closes, slow);
	const result = detectCross(maFast.values, maSlow.values);
	return result.type === "golden" && result.index === klines.length - 1;
}

/**
 * Check if a death cross occurred on the latest day for given MA periods.
 */
export function hasDeathCross(klines: KlineRow[], fast: number, slow: number): boolean {
	if (klines.length < slow + 1) return false;
	const closes = getCloses(klines);
	const maFast = computeMA(closes, fast);
	const maSlow = computeMA(closes, slow);
	const result = detectCross(maFast.values, maSlow.values);
	return result.type === "death" && result.index === klines.length - 1;
}

/**
 * Check if MACD golden cross (DIF crosses above DEA) on latest day.
 */
export function hasMACDGoldenCross(klines: KlineRow[]): boolean {
	if (klines.length < 27) return false;
	const closes = getCloses(klines);
	const macd = computeMACD(closes);
	const result = detectCross(macd.dif, macd.dea);
	return result.type === "golden" && result.index === klines.length - 1;
}

/**
 * Check if MACD death cross on latest day.
 */
export function hasMACDDeathCross(klines: KlineRow[]): boolean {
	if (klines.length < 27) return false;
	const closes = getCloses(klines);
	const macd = computeMACD(closes);
	const result = detectCross(macd.dif, macd.dea);
	return result.type === "death" && result.index === klines.length - 1;
}

/**
 * Compute latest RSI value.
 */
export function getLatestRSI(klines: KlineRow[], period = 14): number | null {
	if (klines.length < period + 1) return null;
	const closes = getCloses(klines);
	const rsi = computeRSI(closes, { period });
	for (let i = rsi.values.length - 1; i >= 0; i--) {
		if (rsi.values[i] != null) return rsi.values[i];
	}
	return null;
}
