import type { UgreenDriver } from "./ugreen.ts";
import { isUgreenPass, ugreenMaxQ } from "./ugreen.ts";
import type { UgreenControls } from "./ugreenControls.ts";

let active: UgreenDriver | null = null;
let snapshot: UgreenControls | null = null;
let busy = false;
let curveMaximum = 1;
let saveAll: (() => Promise<void>) | null = null;
const card = () => document.getElementById("ugreenControlsCard")!;
const status = (message: string, error = false) => {
	const node = document.getElementById("ugreenControlStatus");
	if (node) { node.textContent = message; node.classList.toggle("error", error); }
};
const id = (path: string) => "ug-" + path.replaceAll(".", "-");
const toggle = (path: string, label: string, value: boolean) => `<label class="ug-toggle"><input id="${id(path)}" data-path="${path}" type="checkbox" ${value ? "checked" : ""}> ${label}</label>`;
const numeric = (path: string, label: string, value: number, min: number, max: number, step = 1) => `<label class="ug-field" for="${id(path)}"><span>${label}</span><input id="${id(path)}" data-path="${path}" type="number" value="${value}" min="${min}" max="${max}" step="${step}" required></label>`;
const times = (path: string, value: { attack: number; release: number }) => numeric(path + ".attack", "Gain attack", value.attack, 1, 60000) + numeric(path + ".release", "Gain release", value.release, 1, 60000);

export function getUgreenControlsDraft(): UgreenControls {
	if (!active || !snapshot) throw new Error("Connect and read the UGREEN controls first.");
	const draft = structuredClone(snapshot);
	for (const element of card().querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-path]")) {
		if (!element.checkValidity()) throw new Error(`Correct the value for ${element.closest('label')?.textContent?.trim() || element.getAttribute('aria-label')}.`);
		const keys = element.dataset.path!.split(".");
		let target: any = draft;
		for (const key of keys.slice(0, -1)) target = target[key];
		target[keys.at(-1)!] = element instanceof HTMLSelectElement ? element.value : element.type === "checkbox" ? element.checked : element.valueAsNumber;
	}
	active.validateControls(draft);
	return draft;
}

export function setUgreenControlsBusy(value: boolean): void {
	busy = value;
	for (const element of card()?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button") ?? []) element.disabled = value || !active;
	if (!value && snapshot) updatePassInputs();
}

function updatePassInputs(): void {
	for (let i = 0; i < 5; i++) {
		const type = document.getElementById(id(`micBands.${i}.type`)) as HTMLSelectElement;
		const gain = document.getElementById(id(`micBands.${i}.gain`)) as HTMLInputElement;
		const q = document.getElementById(id(`micBands.${i}.q`)) as HTMLInputElement;
		if (!type || !gain || !q) continue;
		gain.disabled = busy || isUgreenPass(type.value);
		if (isUgreenPass(type.value)) gain.value = "0";
		q.max = String(ugreenMaxQ(type.value));
	}
}

function render(): void {
	if (!snapshot) return;
	const u = snapshot;
	card().innerHTML = `
		<div class="card-header"><h2 class="card-title">UGREEN controls</h2><span class="ug-badge">Experimental</span></div>
		<p class="ug-help">Mapped from this firmware; new audio effects still need hardware validation. Edits are drafts until Apply. Save to Flash includes these controls and playback EQ.</p>
		<div class="ug-fields">${toggle("dspEnabled", "Enable main audio DSP", u.dspEnabled)}${numeric("balanceDb", "Balance (dB): − left / + right", u.balanceDb, -12, 12, .1)}${numeric("micGainDb", "Mic gain relative to factory (dB)", u.micGainDb, -20, active!.micGainMaximum, .1)}</div>
		<p class="ug-help">Main DSP bypass also bypasses its gain stages. Other device processing remains active.</p>
		<details open><summary>Microphone EQ · 5 bands</summary><div class="ug-table-scroll"><table class="ug-mic-table"><thead><tr><th>Band</th><th>On</th><th>Type</th><th>Hz</th><th>dB</th><th>Q</th></tr></thead><tbody>${u.micBands.map((b, i) => `<tr><th>${i + 1}</th><td><input data-path="micBands.${i}.enabled" type="checkbox" aria-label="Enable mic band ${i + 1}" ${b.enabled ? 'checked' : ''}></td><td><select data-path="micBands.${i}.type" id="${id(`micBands.${i}.type`)}" aria-label="Mic band ${i + 1} type">${Object.entries({ PK: 'Peak', LSQ: 'Low shelf', HSQ: 'High shelf', LP: 'Low-pass', HP: 'High-pass' }).map(([key, label]) => `<option value="${key}" ${b.type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></td>${(['freq', 'gain', 'q'] as const).map(key => `<td><input id="${id(`micBands.${i}.${key}`)}" data-path="micBands.${i}.${key}" type="number" aria-label="Mic band ${i + 1} ${key}" value="${b[key]}" min="${key === 'freq' ? 20 : key === 'gain' ? -12 : .2}" max="${key === 'freq' ? 20000 : key === 'gain' ? 12 : ugreenMaxQ(b.type)}" step="${key === 'q' ? .001 : .1}" required></td>`).join('')}</tr>`).join('')}</tbody></table></div></details>
		<details><summary>Noise gate · microphone</summary><div class="ug-fields">${toggle('gate.enabled', 'Enable noise gate', u.gate.enabled)}${numeric('gate.lowerDb', 'Lower threshold (dB)', u.gate.lowerDb, -50, -20)}${numeric('gate.upperDb', 'Upper threshold (dB)', u.gate.upperDb, -50, -20)}${numeric('gate.closedGainDb', 'Closed gain (dB)', u.gate.closedGainDb, -60, 0)}${times('gate', u.gate)}${numeric('gate.detectorTime', 'Detector time', u.gate.detectorTime, 1, 127)}${numeric('gate.openHold', 'Open hold', u.gate.openHold, 1, 60000)}${numeric('gate.closeHold', 'Close hold', u.gate.closeHold, 1, 60000)}</div></details>
		<details><summary>Compressor · microphone</summary><div class="ug-fields">${toggle('compressor.enabled', 'Enable mic compressor', u.compressor.enabled)}${numeric('compressor.thresholdDb', 'Threshold (dB)', u.compressor.thresholdDb, -80, -1)}${numeric('compressor.curve', 'Transfer curve parameter', u.compressor.curve, curveMaximum === 1 ? .01 : 1, curveMaximum, .01)}${times('compressor', u.compressor)}${numeric('compressor.detectorTime', 'Detector time', u.compressor.detectorTime, 1, 8191)}</div><p class="ug-help">Curve parameter uses the current firmware variant; it is not a conventional compressor ratio.</p></details>
		<details><summary>Limiter · stereo output</summary><div class="ug-fields">${toggle('limiter.enabled', 'Enable output limiter', u.limiter.enabled)}${numeric('limiter.thresholdDb', 'Threshold (dB)', u.limiter.thresholdDb, -40, -1)}${times('limiter', u.limiter)}${numeric('limiter.detectorAttack', 'Detector attack', u.limiter.detectorAttack, 1, 60000)}${numeric('limiter.detectorRelease', 'Detector release', u.limiter.detectorRelease, 1, 60000)}</div></details>
		<details><summary>Silence detection · mute / power</summary><div class="ug-fields">${toggle('silence.enabled', 'Enable silence detection', u.silence.enabled)}${numeric('silence.upperDb', 'Upper threshold (dB)', u.silence.upperDb, -60, -1)}${numeric('silence.lowerDb', 'Lower threshold (dB)', u.silence.lowerDb, -60, -1)}${numeric('silence.hold', 'Hold time', u.silence.hold, 1, 60000)}${numeric('silence.attack', 'Detector attack', u.silence.attack, 1, 60000)}${numeric('silence.release', 'Detector release', u.silence.release, 1, 60000)}</div></details>
		<p class="ug-help">Timing values use firmware parameters; their real duration has not been measured. Unresolved response variants keep their device values.</p>
		<div class="ug-actions"><button id="ugApply">Apply controls to RAM</button><button id="ugSave">Save all to Flash</button><button id="ugRevert">Revert draft</button><button id="ugExport">Export controls JSON</button><label class="ug-import">Import controls JSON<input id="ugImport" type="file" accept=".json,application/json"></label></div>
		<p id="ugreenControlStatus" role="status" class="ug-help">Device controls loaded; no writes on connection.</p>`;
	updatePassInputs();
	card().removeEventListener('input', onInput);
	card().addEventListener('input', onInput);
	document.getElementById('ugApply')!.onclick = () => { void apply(); };
	document.getElementById('ugSave')!.onclick = () => { if (!busy) void saveAll?.(); };
	document.getElementById('ugRevert')!.onclick = () => { if (!busy) { render(); status('Draft reverted to last applied controls.'); } };
	document.getElementById('ugExport')!.onclick = () => {
		try {
			const blob = new Blob([JSON.stringify({ version: 1, controls: getUgreenControlsDraft() }, null, 2)], { type: 'application/json' });
			const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'ugreen-controls.json'; link.click(); URL.revokeObjectURL(link.href);
		} catch (error) { status((error as Error).message, true); }
	};
	document.getElementById('ugImport')!.onchange = async event => {
		const input = event.target as HTMLInputElement, driver = active;
		if (!input.files?.[0] || !driver || busy) return;
		try {
			const content = await input.files[0].text();
			if (driver !== active) return;
			const imported = JSON.parse(content).controls as UgreenControls;
			driver.validateControls(imported);
			const previous = snapshot; snapshot = structuredClone(imported); render(); snapshot = previous;
			status('Controls imported into draft; nothing sent to hardware.');
		} catch (error) { status(`Import failed: ${(error as Error).message}`, true); }
	};
}
function onInput(): void {
	updatePassInputs();
	try { const draft = getUgreenControlsDraft(); status(JSON.stringify(draft) === JSON.stringify(snapshot) ? 'Controls match last applied values.' : 'Control draft changed; Apply or Save to use it.'); }
	catch (error) { status((error as Error).message, true); }
}
async function apply(): Promise<void> {
	if (!active || busy) return;
	const driver = active;
	try {
		const draft = getUgreenControlsDraft(); setUgreenControlsBusy(true);
		const verified = await driver.applyControls(draft);
		if (active !== driver) return;
		snapshot = verified; render(); status('Controls verified in RAM; saved flash unchanged.');
	} catch (error) { status((error as Error).message, true); }
	finally { if (active === driver) setUgreenControlsBusy(false); }
}

export function bindUgreenControls(driver: UgreenDriver | null, controls?: UgreenControls, config?: number[], onSave?: () => Promise<void>): void {
	active = driver; busy = false; snapshot = controls ? structuredClone(controls) : null;
	card().hidden = !driver;
	if (!driver || !controls) { card().removeEventListener('input', onInput); card().innerHTML = ''; return; }
	curveMaximum = config && !(config[0x31] & (1 << 29)) ? 2.55 : 1;
	saveAll = onSave ?? null;
	render();
}

export function commitUgreenControls(controls: UgreenControls): void {
	if (!active) return;
	snapshot = structuredClone(controls); render(); setUgreenControlsBusy(busy);
	status('Playback EQ and controls verified in RAM; saved flash unchanged.');
}
