import {
	getDevice,
	getEqState,
	getGlobalGainState,
	renderUI,
	setEqState,
	setGlobalGainState,
	setLastAppliedEqName,
	initSlots,
	isCompareActive,
} from "./fn.ts";
import { syncToDevice } from "./dsp.ts";
import { log, updateGlobalGain } from "./helpers.ts";
import { parseTextProfile, neutralBand, type ProfileData } from "./profiles.ts";
import { isUgreen, validateUgreenProfile } from "./ugreen.ts";

/**
 * Export profile to JSON file
 */
export async function exportProfile() {
	const globalGainState = getGlobalGainState();
	const eqState = getEqState();
	
	const data = {
		device: getDevice()?.productName || "Audiocular Aura",
		timestamp: new Date().toISOString(),
		globalGain: globalGainState,
		bands: eqState,
	};
	
	const blob = new Blob([JSON.stringify(data, null, 2)], {
		type: "application/json",
	});
	
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "aura_peq_profile.json";
	a.click();
}

/**
 * Export profile to AutoEq-compatible parametric text file
 * Format: Preamp: X dB / Filter N: ON/OFF PK|LSQ|HSQ Fc XXXX Hz Gain X.X dB Q X.XX
 */
export async function exportProfileAsText() {
	const globalGainState = getGlobalGainState();
	const eqState = getEqState();

	// Map internal type names to AutoEq standard names
	const typeMap: Record<string, string> = {
		PK: "PK",
		LSQ: "LSQ",
		HSQ: "HSQ",
		LP: "LP", HP: "HP",
	};

	const lines: string[] = [];
	lines.push(`Preamp: ${globalGainState.toFixed(1)} dB`);

	eqState.forEach((band, i) => {
		const enabled = band.enabled ? "ON" : "OFF";
		const type = typeMap[band.type] || "PK";
		const freq = Math.round(band.freq);
		const gain = band.gain.toFixed(1);
		const q = band.q.toFixed(2);
		lines.push(`Filter ${i + 1}: ${enabled} ${type} Fc ${freq} Hz Gain ${gain} dB Q ${q}`);
	});

	const text = lines.join("\n");
	const blob = new Blob([text], { type: "text/plain" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = "aura_peq_profile.txt";
	a.click();
}

/**
 * Parse JSON profile data
 */
function parseJsonProfile(content: string): ProfileData {
	const data = JSON.parse(content);
	if (!data.bands) {
		throw new Error("Invalid JSON profile: missing 'bands' property");
	}
	return {
		globalGain: data.globalGain || 0,
		bands: data.bands,
	};
}

/**
 * Import profile from file
 * @param e Event object
 */
export async function importProfile(e: Event) {
	const target = e.target as HTMLInputElement;
	if (!target.files) return;
	const file = target.files[0];
	if (!file) return;

	const reader = new FileReader();
	reader.onload = async (event) => {
		try {
			const result = event.target?.result as string;
			let profile: ProfileData;

			// Heuristic format detection
			if (result.trim().startsWith("{")) {
				profile = parseJsonProfile(result);
			} else if (
				result.trim().startsWith("Preamp:") ||
				result.includes("Filter 1:")
			) {
				profile = parseTextProfile(result, getEqState().length, !!getDevice() && isUgreen(getDevice()!));
			} else {
				throw new Error("Unknown file format. Must be JSON or AutoEq txt file.");
			}

			// Update internal state and handle variable band count
			let importedBands = profile.bands;
			const currentBandsCount = getEqState().length;
			if (importedBands.length > currentBandsCount) {
				if (getDevice() && isUgreen(getDevice()!)) throw new Error("UGREEN supports at most 15 filters; this profile was not applied.");
				log(`Note: Imported profile has ${importedBands.length} bands but current device only supports ${currentBandsCount} bands. Keeping the first ${currentBandsCount} bands.`);
				importedBands = importedBands.slice(0, currentBandsCount);
			} else if (importedBands.length < currentBandsCount) {
				// Fill remaining slots with neutral flat bands, not current EQ state
				const extraNeutral = Array.from(
					{ length: currentBandsCount - importedBands.length },
					(_, i) => neutralBand(importedBands.length + i)
				);
				importedBands = [...importedBands, ...extraNeutral];
			}
			
			// Normalize indices to match new length
			importedBands.forEach((band, idx) => {
				band.index = idx;
			});
			if (getDevice() && isUgreen(getDevice()!)) validateUgreenProfile(importedBands, profile.globalGain);

			// Re-create DOM elements for strips to ensure correct bands count
			const stripsContainer = document.getElementById("eqStrips");
			if (stripsContainer) {
				stripsContainer.innerHTML = "";
			}

			setEqState(importedBands);
			setGlobalGainState(profile.globalGain);

			// Update UI and send preamp packet
			await updateGlobalGain(profile.globalGain, !!getDevice() && isUgreen(getDevice()!));
			renderUI(importedBands);

			const name = `Imported: ${file.name.replace(/\.[^/.]+$/, "")}`;
			setLastAppliedEqName(name);
			if (!isCompareActive()) {
				initSlots();
			}

			const device = getDevice();
			if (device) {
				log(`Syncing imported profile to DAC...`);
				await syncToDevice();
				log(`Synced: ${name}`);
			}
			if (typeof (window as any).pushHistory === "function") {
				(window as any).pushHistory();
			}
		} catch (err) {
			log(`Import Error: ${(err as Error).message}`);
			console.error(err);
		} finally {
			// Clear value to allow selecting same file again
			target.value = "";
		}
	};
	reader.readAsText(file);
}

/**
 * Load EQ profile from raw text content
 * @param content The raw txt preset content
 * @param presetName Name of the preset being loaded
 */
export async function loadProfileFromText(content: string, presetName?: string) {
	try {
		const profile = parseTextProfile(content, getEqState().length, !!getDevice() && isUgreen(getDevice()!));
		if (getDevice() && isUgreen(getDevice()!)) validateUgreenProfile(profile.bands, profile.globalGain);

		// Update internal state and handle variable band count
		let importedBands = profile.bands;
		const currentBandsCount = getEqState().length;
		if (importedBands.length > currentBandsCount) {
			importedBands = importedBands.slice(0, currentBandsCount);
		} else if (importedBands.length < currentBandsCount) {
			// Fill remaining slots with neutral flat bands, not current EQ state
			const extraNeutral = Array.from(
				{ length: currentBandsCount - importedBands.length },
				(_, i) => neutralBand(importedBands.length + i)
			);
			importedBands = [...importedBands, ...extraNeutral];
		}
		
		// Normalize indices to match new length
		importedBands.forEach((band, idx) => {
			band.index = idx;
		});

		// Re-create DOM elements for strips to ensure correct bands count
		const stripsContainer = document.getElementById("eqStrips");
		if (stripsContainer) {
			stripsContainer.innerHTML = "";
		}

		// Update internal state
		setEqState(importedBands);
		(window as any).resetTiltState?.();
		
		const autoPreamp = (window as any).getAutoPreampEnabled?.();
		if (autoPreamp) {
			(window as any).setManualPreampState?.(profile.globalGain);
			await (window as any).recalculateAutoPreamp?.(!!getDevice() && isUgreen(getDevice()!));
		} else {
			setGlobalGainState(profile.globalGain);
			await updateGlobalGain(profile.globalGain, !!getDevice() && isUgreen(getDevice()!));
		}
		renderUI(importedBands);

		const name = presetName || "Loaded Profile";
		setLastAppliedEqName(name);
		if (!isCompareActive()) {
			initSlots();
		}

		const device = getDevice();
		if (device) {
			log(`Syncing preset "${name}" to DAC...`);
			await syncToDevice();
			log(`Synced: ${name}`);
		}
		if (typeof (window as any).pushHistory === "function") {
			(window as any).pushHistory();
		}
	} catch (err) {
		log(`AutoEq Parsing Error: ${(err as Error).message}`);
		console.error(err);
	}
}
