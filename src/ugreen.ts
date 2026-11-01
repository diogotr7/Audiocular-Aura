import type { Band } from "./main.ts";
import { UGREEN_CONTROL_MASKS, decodeUgreenControls, decodeUgreenOutput, encodeUgreenControls, encodeUgreenOutput, ugreenMicGainMaximum } from "./ugreenControls.ts";
import type { UgreenControls } from "./ugreenControls.ts";

/** KT0210 Selene firmware. Do not substitute the newer KTMicro R/W/S protocol. */
export const UGREEN_VID = 0x12d1;
export const UGREEN_PID = 0x0010;
export const UGREEN_FIRMWARE = "1.0.1_210719_B1";
export const UGREEN_FREQUENCIES = [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000];
const REPORT = 0x4b;
const READ = 0x21, WRITE = 0x31, SAVE = 0x32, MEMORY = 0x08;
const FIRST_BAND = 0x35, OUTPUT_GAIN = 0x1a;
const TYPES: Record<string, number> = { PK: 0, LP: 1, HP: 2, LSQ: 3, HSQ: 4 };
const TYPE_NAMES: Record<number, string> = { 0: "PK", 1: "LP", 2: "HP", 3: "LSQ", 4: "HSQ" };
export const isUgreenPass = (type: string): boolean => type === "LP" || type === "HP";
export const ugreenMaxQ = (type: string): number => type === "PK" ? 10 : 5;
export function ugreenWriteMask(reg: number): number {
	return reg === OUTPUT_GAIN || reg >= FIRST_BAND && reg <= 0x5c ? 0xffffffff : UGREEN_CONTROL_MASKS[reg] ?? 0;
}

export function isUgreen(device: Pick<HIDDevice, "vendorId" | "productId">): boolean {
	return device.vendorId === UGREEN_VID && device.productId === UGREEN_PID;
}

export function ugreenPacket(address: number, opcode: number, value = 0): Uint8Array {
	const packet = new Uint8Array(10);
	const view = new DataView(packet.buffer);
	view.setUint32(0, address, true);
	packet[4] = opcode;
	view.setUint32(6, value, true);
	return packet;
}

export function encodeUgreenBand(band: Band): [number, number] {
	if (!Number.isInteger(band.index) || band.index < 0 || band.index >= 15 ||
		!Number.isFinite(band.freq) || band.freq < 20 || band.freq > 20000 ||
		!Number.isFinite(band.gain) || band.gain < -12 || band.gain > 12 ||
		!Number.isFinite(band.q) || band.q < .2 || band.q > ugreenMaxQ(band.type) ||
		(isUgreenPass(band.type) && band.gain !== 0) ||
		!Object.hasOwn(TYPES, band.type) || typeof band.enabled !== "boolean") {
		throw new Error("UGREEN filter limits: 20–20000 Hz, ±12 dB, Q 0.2–10 for peak / 0.2–5 otherwise. Pass-filter gain must be 0.");
	}
	// Pass-filter coefficient generation treats a zero gain field as identity.
	// A -0.1 dB sentinel activates it; it is not used as pass-filter gain.
	const gainWord = isUgreenPass(band.type) ? (band.enabled ? -1 : 0) : Math.round(band.gain * 10);
	return [(((gainWord & 0xffff) << 16) | Math.round(band.q * 1000)) >>> 0,
		((band.enabled ? 0x80000000 : 0) | (TYPES[band.type] << 28) | Math.round(band.freq * 10)) >>> 0];
}

export function decodeUgreenBand(index: number, parameter: number, frequency: number): Band {
	const gain = (parameter >> 16) / 10;
	const type = TYPE_NAMES[(frequency >>> 28) & 7];
	if (!type) throw new Error(`UGREEN band ${index + 1} has an unsupported filter type; no settings were changed.`);
	return { index, freq: (frequency & 0x0fffffff) / 10, gain: isUgreenPass(type) ? 0 : gain,
		q: (parameter & 0xffff) / 1000, type, enabled: !!(frequency & 0x80000000) && (!isUgreenPass(type) || gain !== 0) };
}

export function encodeUgreenPreamp(gain: number, factory: number): number {
	if (!Number.isFinite(gain) || gain < -20 || gain > 0) {
		throw new Error("UGREEN preamp supports attenuation from −20 to 0 dB.");
	}
	return encodeUgreenOutput(gain, 0, factory);
}

export function decodeUgreenPreamp(value: number, factory: number): number {
	return decodeUgreenOutput(value, factory).gain;
}

/** Validate the entire profile before transmitting any write, including imports. */
export function validateUgreenProfile(bands: Band[], gain: number): void {
	if (bands.length !== 15 || bands.some((band, index) => band.index !== index)) {
		throw new Error("UGREEN requires exactly 15 uniquely indexed playback bands.");
	}
	bands.forEach(encodeUgreenBand);
	encodeUgreenPreamp(gain, 0x1f451f45);
}

function checkFirmware(config: number[]): void {
	const bytes = new Uint8Array(16);
	const view = new DataView(bytes.buffer);
	for (let i = 0; i < 4; i++) view.setUint32(i * 4, config[5 + i], true);
	const version = new TextDecoder().decode(bytes).replace(/\0+$/, "");
	if (version !== UGREEN_FIRMWARE || config[0] !== 0x12345678 || config[255] !== 0x12345678) {
		throw new Error(`Unsupported UGREEN firmware (${version}); expected ${UGREEN_FIRMWARE}. No settings were changed.`);
	}
}

export function assertUgreenConfig(current: number[], baseline: number[], includeEq = false): void {
	if (current.length !== 256 || baseline.length !== 256) throw new Error("Incomplete UGREEN configuration backup.");
	for (let reg = 0; reg < 256; reg++) {
		const mask = reg === 0xb9 ? 0xfeffffff : includeEq ? 0xffffffff : ~ugreenWriteMask(reg);
		if ((current[reg] & mask) !== (baseline[reg] & mask)) {
			throw new Error(`UGREEN configuration changed at 0x${reg.toString(16)}. Reconnect and read the device before saving.`);
		}
	}
}

/** One transaction at a time; a timeout invalidates the session, never retries a save. */
export class UgreenDriver {
	private device: HIDDevice;
	private queue: Promise<unknown> = Promise.resolve();
	private pending: { packet: Uint8Array; resolve: (value: number) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
	private closed = false;
	private baseline: number[] | null = null;
	private expected: number[] | null = null;
	private factoryGain = 0;
	private factoryMicGain = 0;
	private logger: (direction: "tx" | "rx", data: Uint8Array) => void;
	private timeout: number;
	private latestApply = 0;

	constructor(device: HIDDevice, logger: (direction: "tx" | "rx", data: Uint8Array) => void = () => {}, timeout = 1000) {
		if (!isUgreen(device)) throw new Error("Not the supported UGREEN 12d1:0010 adapter.");
		this.device = device;
		this.logger = logger;
		this.timeout = timeout;
		device.addEventListener("inputreport", this.onReport);
	}

	private onReport = (event: HIDInputReportEvent): void => {
		if (event.reportId !== REPORT || event.data.byteLength !== 10 || !this.pending) return;
		const data = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
		const request = this.pending.packet;
		this.logger("rx", data);
		const memory = request[4] === MEMORY;
		if (memory ? data.slice(4).some(byte => byte !== 0) : data.slice(0, 6).some((byte, i) => byte !== request[i])) return;
		const value = event.data.getUint32(memory ? 0 : 6, true);
		const pending = this.pending;
		this.pending = null;
		clearTimeout(pending.timer);
		if ((request[4] === WRITE || request[4] === SAVE) && value !== 3) {
			pending.reject(new Error(`UGREEN command failed with status ${value}; reconnect before saving.`));
		} else pending.resolve(value);
	};

	dispose(): void {
		this.closed = true;
		this.device.removeEventListener("inputreport", this.onReport);
		if (this.pending) {
			clearTimeout(this.pending.timer);
			this.pending.reject(new Error("UGREEN disconnected."));
			this.pending = null;
		}
	}

	private transact<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(() => {
			if (this.closed) throw new Error("UGREEN session ended; reconnect before trying again.");
			return operation();
		});
		this.queue = result.catch(() => {});
		return result;
	}

	private exchange(address: number, opcode: number, value = 0): Promise<number> {
		if (this.closed) return Promise.reject(new Error("UGREEN session ended; reconnect."));
		if (opcode === WRITE && (!ugreenWriteMask(address) || !this.baseline || ((value ^ this.baseline[address]) & ~ugreenWriteMask(address)) !== 0)) {
			return Promise.reject(new Error("UGREEN write is outside the mapped controls or changes protected bits."));
		}
		const packet = ugreenPacket(address, opcode, value);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending = null;
				this.closed = true;
				reject(new Error("UGREEN response timed out. Command was not retried; reconnect and verify device state."));
			}, this.timeout);
			this.pending = { packet, resolve, reject, timer };
			this.logger("tx", packet);
			this.device.sendReport(REPORT, packet).catch(error => {
				if (this.pending?.packet !== packet) return;
				clearTimeout(timer);
				this.pending = null;
				this.closed = true;
				reject(error);
			});
		});
	}

	private async config(): Promise<number[]> {
		const words: number[] = [];
		for (let reg = 0; reg < 256; reg++) words.push(await this.exchange(reg, READ));
		checkFirmware(words);
		return words;
	}

	private async write(reg: number, value: number): Promise<void> {
		await this.exchange(reg, WRITE, value);
		if (await this.exchange(reg, READ) !== value) throw new Error(`UGREEN write readback failed at 0x${reg.toString(16)}.`);
	}

	initialize(): Promise<{ bands: Band[]; gain: number; controls: UgreenControls; config: number[] }> {
		return this.transact(async () => {
			const config = await this.config();
			this.factoryGain = await this.exchange(0x82068, MEMORY);
			this.factoryMicGain = await this.exchange(0x82064, MEMORY);
			if (!(this.factoryGain & 0xffff) || !(this.factoryGain >>> 16)) throw new Error("Invalid UGREEN factory gain calibration.");
			if (!(this.factoryMicGain & 0xffff)) throw new Error("Invalid UGREEN microphone gain calibration.");
			const gain = decodeUgreenPreamp(config[OUTPUT_GAIN], this.factoryGain);
			const bands = UGREEN_FREQUENCIES.map((_, i) => decodeUgreenBand(i, config[FIRST_BAND + i * 2], config[FIRST_BAND + i * 2 + 1]));
			this.baseline = [...config];
			this.expected = [...config];
			return { bands, gain, controls: decodeUgreenControls(config, this.factoryGain, this.factoryMicGain), config };
		});
	}

	apply(bands: Band[], gain: number): Promise<void> {
		this.latestApply++;
		return this.applyProfile(bands, gain);
	}

	/** Drop obsolete slider updates that have not started transmitting. */
	applyLatest(bands: Band[], gain: number): Promise<void> {
		return this.applyProfile(bands, gain, ++this.latestApply);
	}
	applyAll(bands: Band[], gain: number, controls: UgreenControls): Promise<void> {
		this.latestApply++;
		return this.applyProfile(bands, gain, undefined, structuredClone(controls));
	}
	applyControls(controls: UgreenControls): Promise<UgreenControls> {
		const draft = structuredClone(controls);
		return this.transact(async () => {
			await this.applyTarget(undefined, undefined, draft);
			return decodeUgreenControls(this.expected!, this.factoryGain, this.factoryMicGain);
		});
	}
	get micGainMaximum(): number { return ugreenMicGainMaximum(this.factoryMicGain); }
	validateControls(controls: UgreenControls): void {
		if (!this.expected) throw new Error("Read the UGREEN configuration first.");
		encodeUgreenControls(this.expected, controls, decodeUgreenOutput(this.expected[OUTPUT_GAIN], this.factoryGain).gain, this.factoryGain, this.factoryMicGain);
	}
	applyAndSave(bands: Band[], gain: number, controls: UgreenControls): Promise<number[]> {
		this.latestApply++;
		const profile = bands.map(band => ({ ...band })), draft = structuredClone(controls);
		return this.transact(async () => {
			await this.applyTarget(profile, gain, draft);
			return this.persist();
		});
	}

	private applyProfile(bands: Band[], gain: number, revision?: number, controls?: UgreenControls): Promise<void> {
		const profile = bands.map(band => ({ ...band }));
		return this.transact(async () => {
			if (revision !== undefined && revision !== this.latestApply) return;
			await this.applyTarget(profile, gain, controls);
		});
	}
	private async applyTarget(profile?: Band[], gain?: number, controls?: UgreenControls): Promise<void> {
		if (profile) validateUgreenProfile(profile, gain!);
		if (!this.baseline || !this.expected) throw new Error("Read UGREEN configuration before applying; the previous write must be verified.");
		const current = await this.config();
		assertUgreenConfig(current, this.baseline);
		assertUgreenConfig(current, this.expected, true);
		const output = decodeUgreenOutput(current[OUTPUT_GAIN], this.factoryGain);
		const target = controls ? encodeUgreenControls(current, controls, gain ?? output.gain, this.factoryGain, this.factoryMicGain) : [...current];
		if (profile) {
			const balance = controls?.balanceDb ?? output.balanceDb;
			const encodedOutput = encodeUgreenOutput(gain!, balance, this.factoryGain);
			target[OUTPUT_GAIN] = gain === output.gain && balance === output.balanceDb ? current[OUTPUT_GAIN] : encodedOutput;
			profile.forEach(band => {
				[target[FIRST_BAND + band.index * 2], target[FIRST_BAND + band.index * 2 + 1]] = encodeUgreenBand(band);
			});
		}
		// The full target is validated before the first write. A failed partial
		// application cannot subsequently save until explicitly re-read.
		this.expected = null;
		const put = async (reg: number, value: number) => {
			if (current[reg] === value) return;
			await this.write(reg, value); current[reg] = value;
		};
		if (!(target[0x18] & 1)) await put(0x18, target[0x18]);
		if ((target[OUTPUT_GAIN] & 0xffff) < (current[OUTPUT_GAIN] & 0xffff) || (target[OUTPUT_GAIN] >>> 16) < (current[OUTPUT_GAIN] >>> 16)) await put(OUTPUT_GAIN, target[OUTPUT_GAIN]);
		if ((target[0x19] & 0xffff) < (current[0x19] & 0xffff)) await put(0x19, target[0x19]);
		for (let reg = FIRST_BAND; reg <= 0x5c; reg += 2) {
			if (current[reg] === target[reg] && current[reg + 1] === target[reg + 1]) continue;
			await put(reg + 1, (current[reg + 1] & 0x7fffffff) >>> 0);
			await put(reg, target[reg]); await put(reg + 1, target[reg + 1]);
		}
		for (const group of [[0x1b, 0x1c, 0x1d], [0x25, 0x26, 0x27], [0x2c, 0x2d, 0x2e], [0x31, 0x32]]) {
			if (group.every(reg => current[reg] === target[reg])) continue;
			const lead = group[0];
			if (current[lead] & 0x80000000) await put(lead, (current[lead] & 0x7fffffff) >>> 0);
			for (const reg of group.slice(1)) await put(reg, target[reg]);
			await put(lead, target[lead]);
		}
		await put(0x19, target[0x19]); await put(OUTPUT_GAIN, target[OUTPUT_GAIN]);
		await put(0x18, target[0x18]);
		assertUgreenConfig(await this.config(), target, true);
		this.expected = target;
	}

	save(): Promise<number[]> {
		this.latestApply++;
		return this.transact(() => this.persist());
	}
	private async persist(): Promise<number[]> {
		if (!this.baseline || !this.expected) throw new Error("Apply and verify the UGREEN profile before saving.");
		const current = await this.config();
		assertUgreenConfig(current, this.baseline); assertUgreenConfig(current, this.expected, true);
		await this.exchange(0, SAVE); // once; adapter acknowledges, then re-enumerates
		this.expected = null; this.dispose();
		return current;
	}

	verifySaved(snapshot: number[]): Promise<void> {
		return this.transact(async () => {
			assertUgreenConfig(await this.config(), snapshot, true);
			for (let reg = 0; reg < 256; reg++) {
				const mask = reg === 0xb9 ? 0xfeffffff : 0xffffffff;
				if (((await this.exchange(0x81000 + reg * 4, MEMORY)) & mask) !== (snapshot[reg] & mask)) {
					throw new Error(`UGREEN saved flash differs at word ${reg}. Save was not retried.`);
				}
			}
			this.expected = [...snapshot];
		});
	}
}
