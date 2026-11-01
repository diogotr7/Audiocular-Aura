// Test-only page. Never opens the real adapter or requests HID permission.
const { ugreenWriteMask } = await import('/src/ugreen.ts');
const factory = (await (await fetch('/tests/fixtures/ugreen-factory.json')).json()).registers;
class MockHid extends EventTarget {
  vendorId = 0x12d1; productId = 0x0010; productName = 'UGREEN KT0210 (TEST DEVICE)';
  opened = false; collections = [{ usagePage: 0xff00 }];
  config = [...factory]; flash = [...factory]; writes = [];
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(reportId, payload) {
    const response = new Uint8Array(payload), view = new DataView(response.buffer);
    const address = view.getUint32(0, true), opcode = response[4];
    if (reportId !== 0x4b || response.length !== 10) throw new Error('Wrong HID report');
    if (opcode === 0x21) view.setUint32(6, this.config[address], true);
    else if (opcode === 0x31) {
      if (!ugreenWriteMask(address) || ((view.getUint32(6, true) ^ this.config[address]) & ~ugreenWriteMask(address))) throw new Error('Unexpected write');
      this.writes.push({ address, value: view.getUint32(6, true) });
      this.config[address] = view.getUint32(6, true); view.setUint32(6, 3, true);
    } else if (opcode === 0x32) {
      this.flash = [...this.config]; view.setUint32(6, 3, true);
    } else if (opcode === 0x08) {
      response.fill(0); view.setUint32(0, address === 0x82068 ? factory[0x1a] : address === 0x82064 ? factory[0x19] : this.flash[(address - 0x81000) / 4], true);
    } else throw new Error('Unexpected opcode');
    queueMicrotask(() => {
      const event = new Event('inputreport');
      Object.assign(event, { device: this, reportId, data: view }); this.dispatchEvent(event);
    });
  }
}
const device = new MockHid(), hid = new EventTarget();
// Regression: real adapter state may already exceed the old arbitrary +6 dB cap.
const initialMicGain = Math.round((factory[0x19] & 65535) * 10 ** (7.2 / 20));
device.config[0x19] = initialMicGain; device.flash[0x19] = initialMicGain;
hid.getDevices = async () => [];
hid.requestDevice = async () => [device];
Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
const originalFetch = window.fetch.bind(window);
window.fetch = (url, options) => originalFetch(String(url).includes('/Audiocular-Aura/main/devices.json') ? '/devices.json' : url, options);
const html = new DOMParser().parseFromString(await (await originalFetch('/index.html')).text(), 'text/html');
document.body.className = html.body.className;
document.body.innerHTML = html.body.innerHTML;
html.head.querySelectorAll('link').forEach(link => document.head.append(link.cloneNode(true)));
document.querySelectorAll('script').forEach(script => script.remove());
const status = document.createElement('p'); status.id = 'testResult'; status.style.cssText = 'padding:16px;background:#222;color:white;position:sticky;top:0;z-index:999';
document.querySelector('.app-wrapper').prepend(status);
const check = (condition, message) => { if (!condition) throw new Error(message); };
try {
  await import('/src/main.ts');
  const fn = await import('/src/fn.ts'), dsp = await import('/src/dsp.ts');
  await fn.connectToDevice();
  check(fn.getDevice() === device, 'Connection failed');
  check(fn.getEqState().length === 15, 'Wrong band count');
  check(device.writes.length === 0, 'Connecting changed hardware');
  check(document.querySelectorAll('#eqStrips > div').length === 15, 'Missing band strips');
  const { showSyncing, hideSyncing } = await import('/src/helpers.ts');
  const layout = () => ['.connection-card', '.visualizer-card', '.strips-card', '.bottom-grid', '#ugreenControlsCard', '.log-card'].map(selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  });
  const idleLayout = JSON.stringify(layout());
  showSyncing(); showSyncing();
  check(getComputedStyle(document.getElementById('syncingIndicator')).visibility === 'visible', 'Sync indicator not visible');
  check(JSON.stringify(layout()) === idleLayout, 'Showing sync spinner shifted page layout');
  hideSyncing();
  check(getComputedStyle(document.getElementById('syncingIndicator')).visibility === 'visible', 'Concurrent sync indicator hidden early');
  hideSyncing();
  check(getComputedStyle(document.getElementById('syncingIndicator')).visibility === 'hidden', 'Idle sync indicator still visible');
  check(JSON.stringify(layout()) === idleLayout, 'Hiding sync spinner shifted page layout');
  check(document.getElementById('deviceUtilityCard').hidden, 'Unsupported utilities exposed');
  check(document.getElementById('tiltControls').hidden, 'Unsupported tilt exposed');
  check(document.getElementById('globalGainSlider').max === '0', 'Preamp boost exposed');
  check(!document.querySelector('#sel-type-14 option[value="NOTCH"]'), 'Unsupported notch exposed');
  check(!document.getElementById('ugreenControlsCard').hidden, 'UGREEN panel missing');
  check(document.querySelectorAll('.ug-mic-table tbody tr').length === 5, 'Missing mic bands');
  const existingMic = document.getElementById('ug-micGainDb');
  check(existingMic.value === '7.2' && existingMic.checkValidity(), 'Existing +7.2 dB mic gain incorrectly rejected');
  const readPanel = await import('/src/ugreenPanel.ts');
  check(readPanel.getUgreenControlsDraft().micGainDb === 7.2, 'Existing mic draft rejected');
  const edit = (id, value) => {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = value; else el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const panel = await import('/src/ugreenPanel.ts');
  edit('ug-balanceDb', 3); edit('ug-micGainDb', -6);
  check(device.writes.length === 0, 'Draft transmitted before Apply');
  const { loadProfileFromText } = await import('/src/importExport.ts');
  await loadProfileFromText('Preamp: -6 dB\nFilter 1: ON LSQ Fc 100 Hz Gain +3 dB Q 0.707\nFilter 15: ON HSQ Fc 4000 Hz Gain +3 dB Q 0.707', 'AutoEQ integration test');
  check(device.config[0x36] === 0xb00003e8 && device.config[0x52] === 0xc0009c40, 'AutoEQ shelves not applied');
  check(device.config[0x19] === initialMicGain, 'Playback import applied mic draft');
  check(fn.getGlobalGainState() === -6 && device.config[0x1a] === 0x0fac0fac, 'AutoEQ preamp not applied');
  await fn.updateState(14, 'gain', -3); await dsp.syncToDevice();
  check(device.config[0x51] === 0xffe202c3, 'Band 15 edit not applied');
  await fn.toggleAutoPreamp(true);
  await fn.updateState(14, 'gain', 3); await dsp.syncToDevice();
  check(fn.getGlobalGainState() < -2.9, 'Auto Preamp did not compensate boosts');
  await fn.toggleAutoPreamp(false);
  await dsp.setDeviceGlobalGain(0);
  check(device.config[0x1a] === factory[0x1a] && fn.getGlobalGainState() === 0, 'Extra headroom policy blocked boosts at zero preamp');
  const count = device.writes.length;
  await loadProfileFromText('Filter 16: ON PK Fc 1000 Hz Gain -3 dB Q 1', 'invalid');
  check(device.writes.length === count, 'Invalid import changed hardware');
  const fileTarget = { files: [new File([JSON.stringify({ globalGain: -6, bands: fn.getEqState().slice(0, 10) })], 'ten-band.json')], value: 'pending' };
  const { importProfile } = await import('/src/importExport.ts');
  await importProfile({ target: fileTarget });
  for (let i = 0; i < 100 && fileTarget.value; i++) await new Promise(resolve => setTimeout(resolve, 20));
  check(!fileTarget.value && fn.getEqState()[14].gain === 0, 'JSON padding inherited previous EQ');
  await fn.updateState(0, 'type', 'HP'); await dsp.syncToDevice();
  check((device.config[0x36] >>> 28 & 7) === 2 && device.config[0x35] >>> 16 === 65535, 'Playback pass filter sentinel missing');
  check(document.getElementById('num-gain-0').disabled, 'Pass gain editable');
  edit('ug-micBands-0-type', 'HP'); edit('ug-micBands-0-freq', 100);
  const micEnable = document.querySelector('[data-path="micBands.0.enabled"]'); micEnable.checked = true; micEnable.dispatchEvent(new Event('input', { bubbles: true }));
  edit('ug-gate-enabled', true); edit('ug-compressor-enabled', true); edit('ug-limiter-enabled', true);
  const beforeApply = device.writes.length;
  document.getElementById('ugApply').click();
  for (let i = 0; i < 200 && document.getElementById('ugApply').disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
  check(document.getElementById('ugreenControlStatus').textContent.includes('verified in RAM'), 'Utility Apply failed: ' + document.getElementById('ugreenControlStatus').textContent);
  check(device.writes.length > beforeApply && device.config[0x19] !== factory[0x19], 'Mic gain not written');
  check(device.config[0x53] >>> 16 === 65535 && (device.config[0x54] >>> 28 & 7) === 2, 'Mic HP missing');
  check([0x25, 0x2c, 0x31].every(reg => device.config[reg] >>> 31), 'Dynamics not enabled');
  check(device.flash[0x19] === initialMicGain, 'Apply persisted flash');
  const controlsBeforePlayback = [...device.config];
  await dsp.syncToDevice();
  for (const reg of [0x19, 0x25, 0x2c, 0x31, 0x53, 0x54]) check(device.config[reg] === controlsBeforePlayback[reg], 'Playback changed applied control');
  edit('ug-limiter-thresholdDb', -5);
  await dsp.syncToDevice(true);
  check((device.config[0x2c] & 255) === 251, 'Manual Sync omitted control draft');
  check(document.getElementById('ugreenControlStatus').textContent.includes('verified in RAM'), 'Manual Sync did not commit controls');
  edit('ug-balanceDb', -2); document.getElementById('ugRevert').click();
  check(document.getElementById('ug-balanceDb').value === '3', 'Revert did not restore applied state');
  // Exercise the real import handler with a mock file; it must remain a draft.
  const controlsImport = panel.getUgreenControlsDraft(); controlsImport.silence.hold = 3000;
  const importWrites = device.writes.length;
  await document.getElementById('ugImport').onchange({ target: { files: [new File([JSON.stringify({ controls: controlsImport })], 'controls.json')] } });
  check(document.getElementById('ug-silence-hold').value === '3000' && device.writes.length === importWrites, 'Controls import wrote device');
  edit('ug-dspEnabled', false); edit('ug-balanceDb', -2);
  window.confirm = () => true; // Test device only; no physical HID access.
  await dsp.flashToFlash();
  const saved = [...device.config];
  await fn.disconnectDevice(); await fn.connectToDevice();
  check(!panel.getUgreenControlsDraft().dspEnabled && panel.getUgreenControlsDraft().balanceDb === -2, 'Saved control draft not restored');
  check(device.config[0x1c] === 3000, 'Save omitted imported draft');
  check(saved.every((word, index) => device.flash[index] === word), 'Save changed unrelated flash');
  check(document.getElementById('logConsole').textContent.includes('save verified after reconnect'), 'Reconnect did not verify save');
  status.textContent = 'PASS — Stable sync spinner layout; new controls: draft isolation, mic EQ/gain, balance, DSP bypass, gate/compressor/limiter, controls JSON, RAM apply, combined flash save/reconnect; UGREEN connect, 15 bands, read-only initialization, AutoEQ shelves/preamp, optional Auto Preamp, boosts at zero preamp, band 15 editing, JSON padding, save/reconnect verification, unsupported controls, invalid import';
  document.title = 'PASS — UGREEN browser integration';
  const previewSync = document.createElement('button');
  previewSync.textContent = 'Preview syncing indicator';
  let previewingSync = false;
  previewSync.onclick = () => {
    previewingSync = !previewingSync;
    if (previewingSync) showSyncing(); else hideSyncing();
  };
  status.append(document.createElement('br'), previewSync);
} catch (error) {
  status.textContent = `FAIL — ${error.message}`; document.title = 'FAIL — UGREEN browser integration'; console.error(error);
}
