# UGREEN KT0210 support

Supported adapter: **USB `12d1:0010`, firmware `1.0.1_210719_B1`**.
Other UGREEN models and firmware revisions are not validated. This older Selene
protocol is separate from AuraPEQ's generic KTMicro R/W/S implementation.

## Using it

Run AuraPEQ locally (`npm install`, `npm run dev`) in a Chromium browser with
WebHID, then connect the adapter. Connection reads its actual configuration and
does not overwrite EQ. All 15 playback bands appear, including their enable flags.

The existing AutoEQ database and parametric text importer support peak (`PK`),
low shelf (`LSQ`), high shelf (`HSQ`), low-pass (`LP`) and high-pass (`HP`) filters.
Pass filters also accept text without a Gain field. Text and JSON profiles with fewer
filters are padded with neutral filters. More than 15 filters, unsupported types,
and values outside the supported limits are rejected before hardware writes.
Auto Preamp is optional, using AuraPEQ's existing behavior. Its existing gain
warnings remain available when syncing or saving. The UGREEN driver does not
impose an additional requirement to offset EQ boosts with preamp attenuation.

Limits: 20–20000 Hz, ±12 dB peak/shelf gain, Q 0.2–10 for peaks and
0.2–5 for shelves/pass filters, preamp −20–0 dB. Pass-filter gain is fixed at 0.
Filter gain/frequency are quantized to 0.1 dB/0.1 Hz and Q to 0.001.
Preamp uses rounded native linear gain, referenced to each channel's own factory
calibration. Notch, global tone tilt, analog amplifier gain mode, DAC hardware
filter selection and factory reset remain unavailable.

### Firmware-mapped controls

A UGREEN panel appears after connection, populated from actual device state:

- Five microphone EQ bands with peak, shelves and low/high-pass.
- Microphone digital gain relative to factory (−20 dB to the native 16-bit
  maximum, converted using the device’s factory reference).
- Channel balance (−12 to +12 dB; positive favors right), implemented by
  attenuating the opposite channel while retaining separate factory references.
- Main audio DSP enable. Bypass also bypasses its gain stages; it does not
  bypass every part of the application audio pipeline.
- Microphone noise gate, microphone compressor, stereo output limiter and
  silence detection with their mapped thresholds, envelopes and hold parameters.

These controls and the pass filters are **Experimental**. Their mappings come
from firmware analysis; their new audio effects have not been physically tested.
Timing inputs are firmware parameters, not measured milliseconds. The compressor
curve parameter is not labeled a conventional ratio. Unresolved variant bits are
preserved; there is no analog low/high gain or DAC filter control.

Panel edits and controls JSON imports stay in a draft. **Apply controls to RAM**
changes only the controls; manual **Sync/Send** applies playback EQ and the control
draft. Playback slider edits, AutoEQ imports, undo and A/B switching preserve
applied mic/dynamics settings and do not apply utility drafts. **Revert draft**
returns to the last applied controls. Export/import controls JSON is separate from
AuraPEQ's playback profile export. Connecting performs no writes.

Edits and Sync affect RAM. **Save to Flash** is explicit: it verifies the displayed
playback profile and control draft together, sends one configuration-save command and lets the adapter reboot. Keep
the page open for automatic reconnect and verification of RAM and saved flash.
If a command times out, reconnect and inspect the device; the app never retries
the save automatically. Pending verification is retained only in the current page.

## Transport and preservation

WebHID output/input report `0x4b` has **10 payload bytes**, excluding the report ID:
`address LE32 | opcode | reserved 0 | value LE32`.

| Command | Opcode | Reply |
| --- | --- | --- |
| Configuration read | `0x21` | Echo first six bytes; word at offset 6 |
| Configuration write | `0x31` | Same echo; status 3 |
| Configuration save | `0x32` | Same echo; status 3, then USB reboot |
| Memory read | `0x08` | Word at offset 0; remaining six bytes zero |

Transactions are serialized; addressless memory replies must never overlap.
Configuration is 256 words. Playback filters occupy `0x35..0x52`, microphone
filters `0x53..0x5c`, and native output gain/balance is `0x1a`. Additional mapped
control fields occupy `0x18`, `0x19`, `0x1b..0x1d`, `0x25..0x27`, `0x2c..0x2e`
and `0x31..0x32`. Writes are restricted to these mapped fields with bit masks for
reserved bits and unresolved variants. USB identity, clocks, calibration and
other fields are preserved. Applying playback alone also preserves mic/dynamics.
The complete target is validated before writes; filter and dynamics groups are
disabled before parameter updates and re-enabled afterward. Each write and the
whole target are checked by readback. Failure blocks saving until a fresh read.
Apply-and-save is one serialized transaction. Full configuration checks
ignore only bit 24 of `0xb9`, the live microphone-detection bit.

Band parameter: signed upper 16 bits = gain ×10; lower 16 bits = Q ×1000.
Frequency: bit 31 enabled, bits 28–30 type (`PK=0`, `LSQ=3`, `HSQ=4`), lower 28
bits = Hz ×10. Types include `LP=1` and `HP=2`; their gain field uses a
nonzero −0.1 dB sentinel because zero makes the firmware generate identity,
while the pass-filter mathematics ignores gain. User configuration flash begins at `0x81000`; factory configuration
begins at `0x82000`. Factory channel gain is read at `0x82068`, microphone gain at `0x82064`.

## Validation and limits of evidence

`npm test` requires Node 22.18+ (or Node 24+) for TypeScript stripping. The tests
cover protocol encoding, actual factory backup decoding, AutoEQ parsing, complete
profile validation, calibration, write readback, config guards, reconnect/flash
verification, stale replies, timeout without retry and realtime coalescing.

With the dev server running, open `/tests/browser-ugreen.html`. This separate test
page uses a simulated HID device; it checks full application connection, 15-band
rendering, AutoEQ shelves/preamp, Auto Preamp, band 15 edits, pass-filter gain
locking, JSON padding, control draft isolation, microphone EQ/gain, balance,
dynamics, controls JSON import/revert and combined save/reconnect with DSP bypass.
It also checks rejection of invalid playback imports. It never opens a physical adapter.

The **actual TypeScript driver** was separately tested through Linux hidraw on
the physical adapter. At +3 dB, Q 0.707, peak at 1 kHz, low shelf at 100 Hz and
high shelf at 4 kHz produced active DSP objects with response error below
0.0011 dB against the RBJ curve over 256 frequencies. Peak coefficients use Q28;
shelves use Q24. A −6 dB preamp set both DSP gain targets to 4012, from factory
8005. Save/reboot, complete flash verification and restoration of the original
256-word configuration passed. See [captured results](ugreen-hardware-result.json).

This verifies DSP state and persistence, not an analog frequency-response or
distortion measurement. Native attenuation is after the EQ chain; it does not
prove that arbitrary boosted filters cannot clip internally. Physical browser
WebHID connection was confirmed by the user. The automated browser integration
test uses simulation, while the physical DSP and save/reboot tests use hidraw;
the connection confirmation alone does not establish browser EQ writes or saves.

For deliberate hardware validation, stop playback/capture and run:

```sh
node --experimental-strip-types tests/hardware-ugreen.mjs
# Adds two persistent saves, verifies reboot and restores the initial profile:
node --experimental-strip-types tests/hardware-ugreen.mjs --save
```

Hardware tests require Python 3 and read/write access to the adapter's hidraw node.
They record the initial backup and results at `/tmp/ugreen-aurapeq-hardware.json`.
If a run cannot restore, preserve that backup; `--save --restore-backup` restores
its recorded initial profile after testing. Do not run another test first and
overwrite the recovery file. No arbitrary memory writes, reset or calibration
commands are implemented.

## Analog loopback measurements

Measured at the headphone output (3.5 mm into a Behringer UFO202 line input,
stepped sines 20 Hz–18 kHz, 1/6 octave), driving the adapter through this
driver's encoding. Errors are against ideal RBJ biquads.

| Test (48 kHz stream) | Result |
|---|---|
| Peak, low shelf, high shelf; cuts and boosts up to ±12 dB, Q 0.7–4 | within 0.08 dB |
| High-pass / low-pass (−0.1 dB sentinel in the gain field) | within 0.2 dB |
| All 15 bands at once, mixed types | within 0.04 dB of the summed curve |
| Preamp −6 dB; balance +3 / −4 dB | exact to 0.05 dB, correct channel |
| Main DSP bypass | removes EQ **and** preamp/balance |
| Limiter, −12 dB threshold | soft, about 4–5:1 above threshold, not a hard ceiling |
| Saved profile after save-reboot and after a physical replug | within 0.05 dB |

Sample-rate caveats (the host normally resamples to 48 kHz, e.g. PipeWire's
default; these only apply when something opens the adapter at another rate):

- **44.1 kHz:** the firmware keeps 48 kHz coefficients, so every filter sits
  about 8 % lower in frequency (errors up to 1.3 dB for a busy profile).
- **96 kHz:** coefficients are recomputed correctly and high-frequency bands
  and low-frequency cuts are accurate, but stacking low-frequency boosts
  (e.g. +4 dB shelf at 80 Hz, +2 dB at 63 Hz, +3 dB at 160 Hz) makes the output
  collapse; with six or more such bands it is essentially silent.
