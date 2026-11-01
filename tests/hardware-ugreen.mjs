// Runs the actual TypeScript driver against hidraw. RAM tests restore the
// initial profile in finally. Pass --save explicitly for a flash/reboot test.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { UgreenDriver, ugreenPacket, assertUgreenConfig, encodeUgreenPreamp } from '../src/ugreen.ts';
import { calculateBiquad, getMagnitude } from '../src/peq.ts';

class HidrawDevice extends EventTarget {
  vendorId = 0x12d1; productId = 0x0010; opened = true;
  sequence = 0; waiting = new Map();
  constructor() {
    super();
    this.child = spawn('python3', ['tests/hidraw-transport.py', ...(process.argv.includes('--save') ? ['--allow-save'] : [])]);
    this.child.stderr.pipe(process.stderr);
    createInterface({ input: this.child.stdout }).on('line', line => {
      const response = JSON.parse(line), pending = this.waiting.get(response.id);
      if (!pending) return;
      this.waiting.delete(response.id);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(Uint8Array.from(Buffer.from(response.data, 'hex')));
    });
    this.child.on('exit', () => {
      for (const pending of this.waiting.values()) pending.reject(new Error('hidraw transport exited'));
      this.waiting.clear();
    });
  }
  request(report, data) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.waiting.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, report, data: Buffer.from(data).toString('hex') }) + '\n');
    });
  }
  async sendReport(reportId, packet) {
    const data = await this.request(reportId, packet);
    const event = new Event('inputreport');
    Object.assign(event, { reportId, data: new DataView(data.buffer), device: this });
    this.dispatchEvent(event);
  }
  async memory(address) {
    const data = await this.request(0x4b, ugreenPacket(address, 0x08));
    return new DataView(data.buffer).getUint32(0, true);
  }
  close() { this.child.stdin.end(); }
}

let device = new HidrawDevice();
const traffic = [];
let driver = new UgreenDriver(device, (direction, data) => traffic.push({ direction, data: Buffer.from(data).toString('hex') }), 6000);
const readProfile = await driver.initialize();
const initial = process.argv.includes('--restore-backup')
  ? JSON.parse(await readFile('/tmp/ugreen-aurapeq-hardware.json', 'utf8')).initial : readProfile;
const result = { initial, filters: [], restored: false };
let saveAttempted = false;
const reconnect = async () => {
  driver.dispose(); device.close();
  await new Promise(resolve => setTimeout(resolve, 2500));
  device = new HidrawDevice();
  driver = new UgreenDriver(device, undefined, 6000);
  return driver.initialize();
};
try {
  for (const [type, freq] of [['PK', 1000], ['LSQ', 100], ['HSQ', 4000]]) {
    const bands = initial.bands.map(band => ({ ...band }));
    bands[8] = { index: 8, type, freq, gain: 3, q: .707, enabled: true };
    await driver.apply(bands, -6);
    const object = await device.memory(0x42b70 + 8 * 4);
    assert.equal((await device.memory(object + 32)) & 0xff, 1, 'DSP processing object must be active');
    const pointer = await device.memory(object + 4);
    const raw = [];
    for (let i = 0; i < 5; i++) raw.push(await device.memory(pointer + i * 4));
    const coefficientBits = type === 'PK' ? 28 : 24;
    const coefficients = raw.map(word => (word | 0) / 2 ** coefficientBits);
    const response = frequency => {
      const w = 2 * Math.PI * frequency / 48000;
      const [b0, b1, b2, a1, a2] = coefficients;
      const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w);
      const ni = -b1 * Math.sin(w) - b2 * Math.sin(2 * w);
      const dr = 1 - a1 * Math.cos(w) - a2 * Math.cos(2 * w);
      const di = a1 * Math.sin(w) + a2 * Math.sin(2 * w);
      return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
    };
    const gainObjects = [await device.memory(0x42c44), await device.memory(0x42c48)];
    const targets = [];
    for (const address of gainObjects) targets.push(await device.memory(address));
    const factory = await device.memory(0x82068);
    const expectedGain = encodeUgreenPreamp(-6, factory);
    assert.deepEqual(targets, [expectedGain & 0xffff, expectedGain >>> 16]);
    const ideal = calculateBiquad(bands[8]);
    let maxErrorDb = 0;
    for (let i = 0; i < 256; i++) {
      const f = 20 * 1000 ** (i / 255);
      maxErrorDb = Math.max(maxErrorDb, Math.abs(response(f) - getMagnitude(f, [ideal])));
    }
    assert.ok(maxErrorDb < .05, `${type} DSP response differs from RBJ by ${maxErrorDb} dB`);
    result.filters.push({ type, freq, raw, coefficientBits, responseDb: [20, freq, 20000].map(response), maxErrorDb, preampTargets: targets });
  }
  if (process.argv.includes('--save')) {
    saveAttempted = true;
    const saved = await driver.save();
    await reconnect();
    await driver.verifySaved(saved);
    result.saveVerified = true;
  }
} finally {
  try {
    // Re-open even after an ambiguous save response; never retry the test save.
    if (saveAttempted) await reconnect();
    await driver.apply(initial.bands, initial.gain);
    if (saveAttempted) {
      const restored = await driver.save();
      const final = await reconnect();
      await driver.verifySaved(restored);
      assertUgreenConfig(final.config, initial.config, true);
    } else {
      const final = await driver.initialize();
      assertUgreenConfig(final.config, initial.config, true);
    }
    result.restored = true;
  } finally {
    driver.dispose(); device.close();
    await writeFile('/tmp/ugreen-aurapeq-hardware.json', JSON.stringify({ ...result, traffic }, null, 2));
  }
}
console.log(JSON.stringify({ ...result, initial: undefined }, null, 2));
