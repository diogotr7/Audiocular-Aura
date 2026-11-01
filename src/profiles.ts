import type { Band, EQ } from "./main.ts";

export interface ProfileData { globalGain: number; bands: EQ; }

export function neutralBand(index: number): Band {
	return {
		index,
		freq: 1000,
		gain: 0,
		q: 0.71,
		type: "PK",
		enabled: true,
	};
}

export function parseTextProfile(content: string, currentBandsCount: number, strict = false): ProfileData {
	const lines = content.split(/\r?\n/);
	// Start from a clean neutral baseline — never inherit current active EQ values
	const bands: EQ = Array.from({ length: currentBandsCount }, (_, i) => neutralBand(i)) as EQ;
	let globalGain = 0;

	// Regex for Preamp: "Preamp: -8.0 dB"
	const preampRegex = /^Preamp:\s*([+-]?\d+(\.\d+)?)\s*(?:dB)?/i;

	// Regex for Filter: "Filter 1: ON PK Fc 34 Hz Gain -2.6 dB Q 0.80"
	const filterRegex =
		/^Filter\s+(\d+):\s+(ON|OFF)\s+([A-Z]+)\s+Fc\s+(\d+(?:\.\d+)?)\s*(?:Hz)?\s+Gain\s+([+-]?\d+(?:\.\d+)?)\s*(?:dB)?\s+Q\s+(\d+(?:\.\d+)?)/i;
	const passRegex = /^Filter\s+(\d+):\s+(ON|OFF)\s+(LP|HP)\s+Fc\s+(\d+(?:\.\d+)?)\s*(?:Hz)?\s+Q\s+(\d+(?:\.\d+)?)\s*$/i;

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		const preampMatch = trimmed.match(preampRegex);
		if (preampMatch) {
			globalGain = parseFloat(preampMatch[1]);
			continue;
		}

		const pass = strict ? trimmed.match(passRegex) : null;
		const filterMatch = trimmed.match(filterRegex) ?? (pass ? [pass[0], pass[1], pass[2], pass[3], pass[4], "0", pass[5]] : null);
		if (filterMatch) {
			const index = parseInt(filterMatch[1], 10) - 1; // 1-based to 0-based
			if (strict && (index < 0 || index >= bands.length)) throw new Error(`Profile filter ${index + 1} exceeds the ${currentBandsCount}-band device limit.`);
			if (index >= 0 && index < bands.length) {
				const enabled = filterMatch[2].toUpperCase() === "ON";
				const type = filterMatch[3].toUpperCase(); // e.g. PK, LSQ, HSQ
				const freq = parseFloat(filterMatch[4]);
				const gain = parseFloat(filterMatch[5]);
				const q = parseFloat(filterMatch[6]);

				if (strict && !["PK", "LS", "LSC", "LSQ", "HS", "HSC", "HSQ", "LP", "HP"].includes(type)) throw new Error(`Unsupported profile filter type: ${type}`);
				// Normalize type names
				let finalType = "PK";
				if (type === "LS" || type === "LSC" || type === "LSQ") {
					finalType = "LSQ";
				} else if (type === "HS" || type === "HSC" || type === "HSQ") {
					finalType = "HSQ";
				} else if (strict && (type === "LP" || type === "HP")) {
					finalType = type;
				}

				bands[index] = {
					...bands[index],
					freq,
					gain,
					q,
					type: finalType,
					enabled,
				};
			}
		}
		else if (strict && /^Filter\s/i.test(trimmed)) throw new Error(`Invalid filter declaration: ${trimmed}`);
	}

	return { globalGain, bands };
}
