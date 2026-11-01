import type { Band } from "./main.ts";
import { decodeUgreenBand, encodeUgreenBand } from "./ugreen.ts";

export interface UgreenControls {
	dspEnabled: boolean;
	balanceDb: number;
	micGainDb: number;
	micBands: Band[];
	silence: { enabled: boolean; upperDb: number; lowerDb: number; hold: number; attack: number; release: number };
	gate: { enabled: boolean; lowerDb: number; upperDb: number; closedGainDb: number; detectorTime: number; attack: number; release: number; openHold: number; closeHold: number };
	limiter: { enabled: boolean; thresholdDb: number; attack: number; release: number; detectorAttack: number; detectorRelease: number };
	compressor: { enabled: boolean; thresholdDb: number; curve: number; detectorTime: number; attack: number; release: number };
}

// Only named fields are mutable. Reserved bits and unresolved dynamics variants
// are protected even in words that contain controls. USB/calibration are absent.
export const UGREEN_CONTROL_MASKS: Readonly<Record<number, number>> = {
	0x18: 1, 0x19: 0xffff, 0x1b: 0x8000ffff, 0x1c: 0xffff, 0x1d: 0xffffffff,
	0x25: 0xffffffff, 0x26: 0xffffffff, 0x27: 0xffffffff,
	0x2c: 0x800000ff, 0x2d: 0xffffffff, 0x2e: 0xffffffff,
	0x31: 0x9fffffff, 0x32: 0xffffffff,
};
const byte = (word: number, shift: number) => (word >> shift << 24) >> 24;
const lo = (word: number) => word & 0xffff;
const hi = (word: number) => word >>> 16;
const enabled = (word: number) => !!(word & 0x80000000);
const rounded = (value: number) => Math.round(value * 10) / 10;

function number(value: number, min: number, max: number, label: string, integer = false): number {
	if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
		throw new Error(`${label} must be ${integer ? 'an integer ' : ''}from ${min} to ${max}.`);
	}
	return value;
}
function flag(value: boolean): number {
	if (typeof value !== "boolean") throw new Error("Invalid UGREEN enable flag.");
	return value ? 0x80000000 : 0;
}
const time = (value: number, label: string, max = 60000) => number(value, 1, max, label, true);
const pair = (a: number, b: number) => ((b << 16) | a) >>> 0;

export function encodeUgreenOutput(gain: number, balanceDb: number, factory: number): number {
	number(gain, -20, 0, "Playback attenuation");
	number(balanceDb, -12, 12, "Channel balance");
	const left = Math.round(lo(factory) * 10 ** ((gain - Math.max(balanceDb, 0)) / 20));
	const right = Math.round(hi(factory) * 10 ** ((gain - Math.max(-balanceDb, 0)) / 20));
	return pair(left, right);
}
export function decodeUgreenOutput(value: number, factory: number): { gain: number; balanceDb: number } {
	const left = 20 * Math.log10(lo(value) / lo(factory));
	const right = 20 * Math.log10(hi(value) / hi(factory));
	if (![left, right].every(Number.isFinite)) throw new Error("UGREEN output is muted or has invalid calibration.");
	return { gain: rounded(Math.max(left, right)), balanceDb: rounded(right - left) };
}

/** Highest displayed 0.1 dB gain representable by the unsigned native word. */
export function ugreenMicGainMaximum(factory: number): number {
	if (!lo(factory)) throw new Error("Invalid UGREEN microphone gain calibration.");
	return rounded(20 * Math.log10(65535 / lo(factory)));
}

export function decodeUgreenControls(c: number[], outputFactory: number, micFactory: number): UgreenControls {
	const micGainDb = rounded(20 * Math.log10(lo(c[0x19]) / lo(micFactory)));
	if (!Number.isFinite(micGainDb)) throw new Error("UGREEN microphone gain is muted or has invalid calibration.");
	return {
		dspEnabled: !!(c[0x18] & 1), balanceDb: decodeUgreenOutput(c[0x1a], outputFactory).balanceDb, micGainDb,
		micBands: Array.from({ length: 5 }, (_, i) => decodeUgreenBand(i, c[0x53 + i * 2], c[0x54 + i * 2])),
		silence: { enabled: enabled(c[0x1b]), upperDb: byte(c[0x1b], 0), lowerDb: byte(c[0x1b], 8), hold: lo(c[0x1c]), attack: lo(c[0x1d]), release: hi(c[0x1d]) },
		gate: { enabled: enabled(c[0x25]), lowerDb: byte(c[0x25], 0), upperDb: byte(c[0x25], 8), closedGainDb: byte(c[0x25], 16), detectorTime: (c[0x25] >>> 24) & 127, attack: lo(c[0x26]), release: hi(c[0x26]), openHold: lo(c[0x27]), closeHold: hi(c[0x27]) },
		limiter: { enabled: enabled(c[0x2c]), thresholdDb: byte(c[0x2c], 0), attack: lo(c[0x2d]), release: hi(c[0x2d]), detectorAttack: lo(c[0x2e]), detectorRelease: hi(c[0x2e]) },
		compressor: { enabled: enabled(c[0x31]), thresholdDb: byte(c[0x31], 0), curve: ((c[0x31] >>> 8) & 255) / 100, detectorTime: (c[0x31] >>> 16) & 8191, attack: lo(c[0x32]), release: hi(c[0x32]) },
	};
}

/** Produce a complete validated target before any write. Unnamed bits survive. */
export function encodeUgreenControls(current: number[], u: UgreenControls, gain: number, outputFactory: number, micFactory: number): number[] {
	const c = [...current];
	if (typeof u.dspEnabled !== "boolean") throw new Error("Invalid DSP enable flag.");
	c[0x18] = ((c[0x18] & ~1) | Number(u.dspEnabled)) >>> 0;
	const output = decodeUgreenOutput(current[0x1a], outputFactory);
	const encodedOutput = encodeUgreenOutput(gain, u.balanceDb, outputFactory);
	c[0x1a] = output.gain === gain && output.balanceDb === u.balanceDb ? current[0x1a] : encodedOutput;
	number(u.micGainDb, -20, ugreenMicGainMaximum(micFactory), "Microphone gain");
	// The maximum displayed dB value is rounded to 0.1 dB, so its native
	// conversion can slightly exceed 65535. Quantize that endpoint to the maximum.
	const mic = Math.min(65535, Math.round(lo(micFactory) * 10 ** (u.micGainDb / 20)));
	number(mic, 1, 65535, "Calibrated microphone gain", true);
	if (rounded(20 * Math.log10(lo(current[0x19]) / lo(micFactory))) !== u.micGainDb) {
		c[0x19] = ((c[0x19] & 0xffff0000) | mic) >>> 0;
	}
	if (u.micBands.length !== 5 || u.micBands.some((b, i) => b.index !== i)) throw new Error("UGREEN requires exactly five indexed microphone filters.");
	u.micBands.forEach((b, i) => { [c[0x53 + i * 2], c[0x54 + i * 2]] = encodeUgreenBand(b); });
	const s = u.silence;
	number(s.upperDb, -60, -1, "Silence upper threshold", true); number(s.lowerDb, -60, -1, "Silence lower threshold", true);
	if (s.lowerDb > s.upperDb) throw new Error("Silence lower threshold must not exceed its upper threshold.");
	c[0x1b] = ((c[0x1b] & ~UGREEN_CONTROL_MASKS[0x1b]) | flag(s.enabled) | ((s.lowerDb & 255) << 8) | (s.upperDb & 255)) >>> 0;
	c[0x1c] = ((c[0x1c] & 0xffff0000) | time(s.hold, "Silence hold")) >>> 0;
	c[0x1d] = pair(time(s.attack, "Silence attack"), time(s.release, "Silence release"));
	const g = u.gate;
	number(g.lowerDb, -50, -20, "Gate lower threshold", true); number(g.upperDb, -50, -20, "Gate upper threshold", true);
	if (g.lowerDb > g.upperDb) throw new Error("Gate lower threshold must not exceed its upper threshold.");
	number(g.closedGainDb, -60, 0, "Gate closed gain", true);
	c[0x25] = (flag(g.enabled) | (time(g.detectorTime, "Gate detector time", 127) << 24) | ((g.closedGainDb & 255) << 16) | ((g.upperDb & 255) << 8) | (g.lowerDb & 255)) >>> 0;
	c[0x26] = pair(time(g.attack, "Gate attack"), time(g.release, "Gate release"));
	c[0x27] = pair(time(g.openHold, "Gate open hold"), time(g.closeHold, "Gate close hold"));
	const l = u.limiter;
	number(l.thresholdDb, -40, -1, "Limiter threshold", true);
	c[0x2c] = ((c[0x2c] & ~UGREEN_CONTROL_MASKS[0x2c]) | flag(l.enabled) | (l.thresholdDb & 255)) >>> 0;
	c[0x2d] = pair(time(l.attack, "Limiter attack"), time(l.release, "Limiter release"));
	c[0x2e] = pair(time(l.detectorAttack, "Limiter detector attack"), time(l.detectorRelease, "Limiter detector release"));
	const p = u.compressor;
	number(p.thresholdDb, -80, -1, "Compressor threshold", true);
	// Flag 29 changes the transfer-curve interpretation. Preserve it and flag 30.
	number(p.curve, (c[0x31] & (1 << 29)) ? .01 : 1, (c[0x31] & (1 << 29)) ? 1 : 2.55, "Compressor curve parameter");
	c[0x31] = ((c[0x31] & ~UGREEN_CONTROL_MASKS[0x31]) | flag(p.enabled) | (time(p.detectorTime, "Compressor detector time", 8191) << 16) | (Math.round(p.curve * 100) << 8) | (p.thresholdDb & 255)) >>> 0;
	c[0x32] = pair(time(p.attack, "Compressor attack"), time(p.release, "Compressor release"));
	return c;
}
