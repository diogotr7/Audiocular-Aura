import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UgreenDriver, encodeUgreenBand, decodeUgreenBand, encodeUgreenPreamp, decodeUgreenPreamp, assertUgreenConfig, validateUgreenProfile, ugreenPacket, isUgreen, ugreenWriteMask } from '../src/ugreen.ts';
import { encodeUgreenControls, decodeUgreenControls, encodeUgreenOutput, decodeUgreenOutput, ugreenMicGainMaximum } from '../src/ugreenControls.ts';
import { calculateBiquad, getMagnitude } from '../src/peq.ts';
import { parseTextProfile } from '../src/profiles.ts';

const factory = JSON.parse(readFileSync(new URL('./fixtures/ugreen-factory.json', import.meta.url))).registers;
class MockHid extends EventTarget {
  vendorId = 0x12d1; productId = 0x0010; opened = true;
  config = [...factory]; flash = [...factory]; traffic = [];
  silence = false; dropSaveReply = false; wrongStatus = false; stale = false; badReadback = false;
  emit(reportId, bytes) {
    const padded = new Uint8Array(12); padded.set(bytes, 1);
    const event = new Event('inputreport');
    Object.assign(event, { device: this, reportId, data: new DataView(padded.buffer, 1, 10) });
    this.dispatchEvent(event);
  }
  async sendReport(reportId, payload) {
    const data = new Uint8Array(payload);
    this.traffic.push(data);
    assert.equal(reportId, 0x4b); assert.equal(data.length, 10);
    if (this.silence) return;
    const view = new DataView(data.buffer);
    const addr = view.getUint32(0, true), cmd = data[4], value = view.getUint32(6, true);
    const response = new Uint8Array(data), out = new DataView(response.buffer);
    if (cmd === 0x21) out.setUint32(6, this.config[addr], true);
    else if (cmd === 0x31) {
      assert.ok(ugreenWriteMask(addr));
      assert.equal((value ^ factory[addr]) & ~ugreenWriteMask(addr), (this.config[addr] ^ factory[addr]) & ~ugreenWriteMask(addr));
      if (!this.badReadback) this.config[addr] = value;
      out.setUint32(6, this.wrongStatus ? 1 : 3, true);
    } else if (cmd === 0x32) {
      this.flash = [...this.config]; out.setUint32(6, 3, true);
      if (this.dropSaveReply) return;
    } else if (cmd === 0x08) {
      response.fill(0);
      out.setUint32(0, addr === 0x82068 ? factory[0x1a] : addr === 0x82064 ? factory[0x19] : this.flash[(addr - 0x81000) / 4], true);
    } else assert.fail(`Forbidden opcode ${cmd}`);
    if (this.stale && cmd === 0x21) {
      const stale = new Uint8Array(response); stale[3] = 1;
      this.emit(0x4b, stale); this.emit(1, response);
    }
    queueMicrotask(() => this.emit(0x4b, response));
  }
  writes() { return this.traffic.filter(packet => packet[4] === 0x31 || packet[4] === 0x32); }
}
async function connected() {
  const device = new MockHid(), driver = new UgreenDriver(device);
  const profile = await driver.initialize();
  return { device, driver, profile };
}

test('exact VID:PID required, Huawei devices are not treated as UGREEN', () => {
  assert.equal(isUgreen({ vendorId: 0x12d1, productId: 0x0010 }), true);
  assert.equal(isUgreen({ vendorId: 0x12d1, productId: 0x0001 }), false);
  assert.throws(() => new UgreenDriver({ vendorId: 0x12d1, productId: 1 }));
});
test('captured request encoding uses ten bytes excluding WebHID report ID', () => {
  const words = encodeUgreenBand({ index: 8, freq: 1000, gain: -3, q: .707, type: 'PK', enabled: true });
  assert.deepEqual(words, [0xffe202c3, 0x80002710]);
  assert.equal(Buffer.from(ugreenPacket(0x45, 0x31, words[0])).toString('hex'), '450000003100c302e2ff');
});
test('connection reads all 15 actual filters and never writes', async () => {
  const { device, driver, profile } = await connected();
  assert.equal(profile.bands.length, 15);
  assert.equal(profile.bands[8].gain, -6); assert.equal(profile.bands[8].enabled, false);
  assert.equal(profile.gain, 0); assert.equal(device.writes().length, 0);
  driver.dispose();
});
test('firmware mismatch prevents writes', async () => {
  const device = new MockHid(); device.config[5] = 0;
  const driver = new UgreenDriver(device);
  await assert.rejects(driver.initialize(), /Unsupported UGREEN firmware/);
  assert.equal(device.writes().length, 0); driver.dispose();
});
test('stale full-address replies, other report IDs and DataView offsets are handled', async () => {
  const device = new MockHid(); device.stale = true;
  const driver = new UgreenDriver(device);
  await driver.initialize(); driver.dispose();
});
test('AutoEQ text retains shelves, preamp and filter 15 without inheriting old bands', () => {
  const profile = parseTextProfile('Preamp: -6.0 dB\nFilter 1: ON LSQ Fc 100 Hz Gain +3.0 dB Q 0.707\nFilter 2: ON HSQ Fc 4000 Hz Gain 2.0 dB Q 0.707\nFilter 15: ON PK Fc 1000 Hz Gain -2 dB Q 1', 15, true);
  assert.equal(profile.globalGain, -6); assert.equal(profile.bands[0].type, 'LSQ');
  assert.equal(profile.bands[1].type, 'HSQ'); assert.equal(profile.bands[14].gain, -2);
  assert.equal(profile.bands[13].gain, 0); validateUgreenProfile(profile.bands, profile.globalGain);
});
test('AutoEQ overflow and unsupported filter types are rejected, not silently substituted', () => {
  assert.throws(() => parseTextProfile('Filter 16: ON PK Fc 1000 Hz Gain -3 dB Q 1', 15, true), /limit/);
  assert.throws(() => parseTextProfile('Filter 1: ON NOTCH Fc 1000 Hz Gain -3 dB Q 1', 15, true), /Unsupported/);
});
test('native attenuation preserves per-channel factory calibration', () => {
  const word = encodeUgreenPreamp(-6, 0x1f451f45);
  assert.equal(word, 0x0fac0fac);
  assert.equal(decodeUgreenPreamp(word, 0x1f451f45), -6);
  assert.throws(() => encodeUgreenPreamp(3, factory[0x1a]));
});
test('entire imported profile is checked before any write', async () => {
  const { device, driver, profile } = await connected();
  const bands = profile.bands.map(band => ({ ...band })); bands[14].q = .1;
  await assert.rejects(driver.apply(bands, 0), /Q/);
  assert.equal(device.writes().length, 0); driver.dispose();
});
test('boosted EQ is accepted at zero preamp without an extra headroom policy', async () => {
  const { device, driver, profile } = await connected();
  const bands = profile.bands.map(band => ({ ...band }));
  bands[8] = { index: 8, freq: 1000, gain: 6, q: .707, type: 'PK', enabled: true };
  bands[9] = { ...bands[8], index: 9 };
  await driver.apply(bands, 0);
  assert.equal(device.config[0x45], 0x003c02c3);
  assert.equal(device.config[0x47], 0x003c02c3);
  assert.equal(device.config[0x1a], factory[0x1a]);
  assert.ok(device.writes().length > 0);
  assert.ok(device.writes().every(packet => packet[4] === 0x31));
  driver.dispose();
});
test('apply writes attenuation before boosts and uses only allowed RAM registers', async () => {
  const { device, driver, profile } = await connected();
  profile.bands[8] = { index: 8, freq: 1000, gain: 3, q: .707, type: 'PK', enabled: true };
  await driver.apply(profile.bands, -6);
  assert.equal(new DataView(device.writes()[0].buffer).getUint32(0, true), 0x1a);
  assert.equal(device.config[0x45], 0x001e02c3); assert.equal(device.config[0x46], 0x80002710);
  assert.ok(device.writes().every(packet => packet[4] === 0x31));
  assertUgreenConfig(device.config, factory); driver.dispose();
});
test('save refuses unrelated changes including USB identity', async () => {
  const { device, driver } = await connected(); device.config[0xb7] ^= 1;
  await assert.rejects(driver.save(), /configuration changed/);
  assert.equal(device.writes().length, 0); driver.dispose();
});
test('save refuses unverified external EQ edits', async () => {
  const { device, driver } = await connected(); device.config[0x45] ^= 1;
  await assert.rejects(driver.save(), /configuration changed/); driver.dispose();
});
test('write failure/readback failure cannot be followed by save', async () => {
  for (const failure of ['wrongStatus', 'badReadback']) {
    const { device, driver, profile } = await connected(); device[failure] = true;
    profile.bands[8].gain = -3; profile.bands[8].enabled = true;
    await assert.rejects(driver.apply(profile.bands, 0));
    await assert.rejects(driver.save(), /Apply and verify/);
    assert.ok(device.writes().every(packet => packet[4] !== 0x32)); driver.dispose();
  }
});
test('save sends once, ends the old session, and verifies flash after reconnect', async () => {
  const { device, driver, profile } = await connected();
  profile.bands[14].gain = -3; profile.bands[14].enabled = true;
  await driver.apply(profile.bands, 0); const saved = await driver.save();
  assert.equal(device.writes().filter(packet => packet[4] === 0x32).length, 1);
  await assert.rejects(driver.apply(profile.bands, 0), /session ended/);
  const reconnected = new UgreenDriver(device); await reconnected.initialize();
  await reconnected.verifySaved(saved);
  device.flash[0x51] ^= 1; await assert.rejects(reconnected.verifySaved(saved), /flash differs/);
  reconnected.dispose();
});
test('save timeout is not retried and the session cannot send again', async () => {
  const device = new MockHid(), driver = new UgreenDriver(device, () => {}, 10);
  await driver.initialize(); device.dropSaveReply = true;
  await assert.rejects(driver.save(), /timed out/);
  await assert.rejects(driver.save(), /session ended/);
  assert.equal(device.writes().filter(packet => packet[4] === 0x32).length, 1); driver.dispose();
});
test('obsolete realtime slider updates are skipped before transmission', async () => {
  const { device, driver, profile } = await connected();
  const bands = profile.bands.map(band => ({ ...band }));
  bands[8].enabled = true; bands[8].gain = -1;
  const first = driver.applyLatest(bands, 0);
  bands[8].gain = -2; const second = driver.applyLatest(bands, 0);
  bands[8].gain = -3; const third = driver.applyLatest(bands, 0);
  await Promise.all([first, second, third]);
  const parameters = device.writes().filter(packet => new DataView(packet.buffer).getUint32(0, true) === 0x45);
  assert.equal(parameters.length, 1);
  assert.equal(device.config[0x45], 0xffe202c3);
  driver.dispose();
});
test('only the live microphone-detection bit is ignored in config guards', () => {
  const current = [...factory]; current[0xb9] ^= 1 << 24;
  assertUgreenConfig(current, factory, true);
  current[0xb9] ^= 1 << 23; assert.throws(() => assertUgreenConfig(current, factory, true));
});

test('all factory controls round-trip exactly and connect without writes', async () => {
  const { device, driver, profile } = await connected();
  assert.equal(profile.controls.micBands.length, 5);
  assert.equal(profile.controls.micGainDb, 0);
  assert.deepEqual(encodeUgreenControls(factory, profile.controls, 0, factory[0x1a], factory[0x19]), factory);
  await driver.applyControls(profile.controls);
  assert.equal(device.writes().length, 0); driver.dispose();
});
test('LP/HP use the nonzero firmware sentinel, disable correctly, and plot their response', () => {
  for (const type of ['LP', 'HP']) {
    const band = { index: 0, freq: 1000, gain: 0, q: .707, type, enabled: true };
    const words = encodeUgreenBand(band);
    assert.equal(words[0] >>> 16, 65535);
    assert.deepEqual(decodeUgreenBand(0, ...words), band);
    assert.equal(decodeUgreenBand(0, words[0] & 0xffff, words[1]).enabled, false);
    assert.equal(encodeUgreenBand({ ...band, enabled: false })[0] >>> 16, 0);
    const coeff = calculateBiquad(band);
    assert.ok(Math.abs(getMagnitude(1000, [coeff]) + 3.01) < .02);
    assert.ok(getMagnitude(type === 'LP' ? 100 : 10000, [coeff]) > -.01);
    assert.ok(getMagnitude(type === 'LP' ? 10000 : 100, [coeff]) < -39);
  }
  const profile = parseTextProfile('Filter 1: ON HP Fc 100 Hz Q 0.707\nFilter 2: ON LP Fc 10000 Hz Q 0.707', 15, true);
  assert.equal(profile.bands[0].type, 'HP'); assert.equal(profile.bands[1].gain, 0);
  assert.throws(() => encodeUgreenBand({ ...profile.bands[0], q: 5.001 }), /Q/);
  assert.throws(() => encodeUgreenBand({ ...profile.bands[0], type: 'LSQ', q: 6 }), /Q/);
});
test('native balance respects separate factory calibration and playback preserves utility state', async () => {
  const calibration = 0x20001000;
  const word = encodeUgreenOutput(-6, 3, calibration);
  assert.deepEqual(decodeUgreenOutput(word, calibration), { gain: -6, balanceDb: 3 });
  const { device, driver, profile } = await connected();
  const u = structuredClone(profile.controls); u.balanceDb = 3; u.micGainDb = -6;
  u.gate.enabled = true; u.compressor.enabled = true; u.limiter.enabled = true;
  u.micBands[4] = { index: 4, type: 'HP', freq: 100, gain: 0, q: .707, enabled: true };
  await driver.applyControls(u);
  const before = [...device.config];
  await driver.apply(profile.bands, -6);
  for (let reg = 0; reg < 256; reg++) if (reg !== 0x1a) assert.equal(device.config[reg], before[reg]);
  assert.equal(decodeUgreenOutput(device.config[0x1a], factory[0x1a]).balanceDb, 3);
  assert.equal(decodeUgreenControls(device.config, factory[0x1a], factory[0x19]).micGainDb, -6);
  driver.dispose();
});
test('utility codec preserves reserved fields and gain quantization during unrelated edits', () => {
  const c = [...factory]; c[0x19] |= 0x12340000; c[0x19] = (c[0x19] - 2) >>> 0;
  c[0x1a] = (c[0x1a] - 1) >>> 0; c[0x1b] |= 0x01230000; c[0x1c] |= 0x45670000;
  c[0x2c] |= 0x40005500; c[0x31] |= 0x40000000;
  const u = decodeUgreenControls(c, factory[0x1a], factory[0x19]); u.silence.hold++;
  const encoded = encodeUgreenControls(c, u, 0, factory[0x1a], factory[0x19]);
  for (let reg = 0; reg < 256; reg++) if (reg !== 0x1c) assert.equal(encoded[reg], c[reg] >>> 0, `word ${reg}`);
  assert.equal(encoded[0x1c] >>> 16, c[0x1c] >>> 16);
  const tampered = [...c]; tampered[0x2c] ^= 1 << 30;
  assert.throws(() => assertUgreenConfig(tampered, c), /configuration changed/);
});
test('complete utility validation precedes writes, including the last parameter', async () => {
  const { device, driver, profile } = await connected();
  const u = structuredClone(profile.controls); u.balanceDb = 3; u.compressor.release = 0;
  await assert.rejects(driver.applyAll(profile.bands, -6, u), /release/);
  assert.equal(device.writes().length, 0); driver.dispose();
});
test('dynamics disable before timing changes and re-enable after parameters', async () => {
  const { device, driver, profile } = await connected();
  const u = structuredClone(profile.controls); u.silence.hold++;
  await driver.applyControls(u);
  const w = device.writes().map(p => ({ reg: new DataView(p.buffer).getUint32(0, true), val: new DataView(p.buffer).getUint32(6, true) }));
  assert.deepEqual(w.map(x => x.reg), [0x1b, 0x1c, 0x1b]);
  assert.equal(w[0].val >>> 31, 0); assert.equal(w[2].val >>> 31, 1);
  driver.dispose();
});
test('DSP bypass reconnects, enabling happens after the other writes', async () => {
  const device = new MockHid(); device.config[0x18] &= ~1;
  const driver = new UgreenDriver(device), profile = await driver.initialize();
  assert.equal(profile.controls.dspEnabled, false);
  const u = structuredClone(profile.controls); u.dspEnabled = true; u.micGainDb = -6;
  await driver.applyControls(u);
  assert.equal(new DataView(device.writes().at(-1).buffer).getUint32(0, true), 0x18);
  driver.dispose();
});
test('control failure and external edits block flash save', async () => {
  const { device, driver, profile } = await connected();
  const u = structuredClone(profile.controls); u.limiter.enabled = true;
  device.badReadback = true;
  await assert.rejects(driver.applyControls(u));
  await assert.rejects(driver.save(), /Apply and verify/);
  assert.ok(device.writes().every(p => p[4] !== 0x32)); driver.dispose();
  const other = await connected(); other.device.config[0x26] ^= 1;
  await assert.rejects(other.driver.applyControls(other.profile.controls), /configuration changed/);
  await assert.rejects(other.driver.save(), /configuration changed/); other.driver.dispose();
});
test('apply and save all is atomic, persists both mic endpoints and DSP bypass, and reconnect verifies', async () => {
  const { device, driver, profile } = await connected();
  const u = structuredClone(profile.controls); u.dspEnabled = false; u.balanceDb = -2;
  u.micBands[0] = { index: 0, freq: 100, gain: -3, q: .707, type: 'PK', enabled: true };
  u.micBands[4] = { index: 4, freq: 10000, gain: 0, q: .707, type: 'LP', enabled: true };
  const saving = driver.applyAndSave(profile.bands, -6, u);
  const queued = driver.apply(profile.bands, 0);
  const [saved] = await Promise.all([saving, assert.rejects(queued, /session ended/)]);
  assert.equal(device.writes().filter(p => p[4] === 0x32).length, 1);
  assert.equal(device.flash[0x53] >>> 16, 65506); assert.equal(device.flash[0x5b] >>> 16, 65535);
  assert.equal(device.writes()[0][0], 0x18);
  const reconnected = new UgreenDriver(device); const read = await reconnected.initialize();
  assert.equal(read.controls.dspEnabled, false); assert.equal(read.controls.balanceDb, -2);
  await reconnected.verifySaved(saved); reconnected.dispose();
});


test('existing +7.2 dB microphone gain is valid and unchanged by other controls', async () => {
  const device = new MockHid();
  device.config[0x19] = Math.round((factory[0x19] & 65535) * 10 ** (7.2 / 20));
  const native = device.config[0x19];
  const driver = new UgreenDriver(device), profile = await driver.initialize();
  assert.equal(profile.controls.micGainDb, 7.2);
  assert.ok(driver.micGainMaximum >= 7.2);
  driver.validateControls(profile.controls);
  await driver.applyControls(profile.controls);
  assert.equal(device.writes().length, 0);
  const draft = structuredClone(profile.controls); draft.silence.hold++;
  await driver.applyControls(draft);
  assert.equal(device.config[0x19], native); driver.dispose();
});
test('microphone maximum follows calibration and quantizes the endpoint without overflow', () => {
  for (const micFactory of [8005, 18339, 32768]) {
    const c = [...factory]; c[0x19] = micFactory;
    const u = decodeUgreenControls(c, factory[0x1a], micFactory);
    const max = ugreenMicGainMaximum(micFactory);
    u.micGainDb = max;
    const encoded = encodeUgreenControls(c, u, 0, factory[0x1a], micFactory);
    assert.ok((encoded[0x19] & 65535) > 65000);
    assert.equal(decodeUgreenControls(encoded, factory[0x1a], micFactory).micGainDb, max);
    u.micGainDb = max + .1;
    assert.throws(() => encodeUgreenControls(c, u, 0, factory[0x1a], micFactory), /Microphone gain/);
  }
});
