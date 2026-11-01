#!/usr/bin/env python3
"""Development-only WebHID transport for the Node hardware test. No HTTP server.

JSON lines on stdin/stdout. Refuses unknown commands, non-EQ writes, active
audio streams, and save unless --allow-save is explicit. Does not retry.
"""
import json
import os
from pathlib import Path
import select
import struct
import sys
import time


def find_device():
    for event in Path('/sys/class/hidraw').glob('*/device/uevent'):
        if 'HID_ID=0003:000012D1:00000010' in event.read_text():
            return '/dev/' + event.parent.parent.name
    raise RuntimeError('UGREEN adapter is not connected')


def audio_idle():
    for path in Path('/proc/asound').glob('card*/usbid'):
        if path.read_text().strip() == '12d1:0010':
            for status in path.parent.glob('pcm*/sub*/status'):
                if status.read_text().strip() != 'closed':
                    return False
    return True


def require_idle():
    # PipeWire may briefly open the device while discovering it after reboot.
    deadline = time.monotonic() + 5
    while not audio_idle():
        if time.monotonic() >= deadline:
            raise RuntimeError('Stop playback/capture before hardware tests')
        time.sleep(.1)


fd = os.open(find_device(), os.O_RDWR | os.O_NONBLOCK)
try:
    for line in sys.stdin:
        request = json.loads(line)
        try:
            data = bytes.fromhex(request['data'])
            if request['report'] != 0x4b or len(data) != 10:
                raise ValueError('Invalid report')
            address, opcode, reserved, value = struct.unpack('<IBBI', data)
            if reserved or opcode not in (0x08, 0x21, 0x31, 0x32):
                raise ValueError('Unsupported command')
            if opcode in (0x21, 0x31) and not 0 <= address <= 255:
                raise ValueError('Invalid register')
            if opcode == 0x31 and not (address == 0x1a or 0x35 <= address <= 0x52):
                raise ValueError('Writes restricted to playback EQ and preamp')
            if opcode == 0x08 and not (address % 4 == 0 and
                    (0x40000 <= address < 0x50000 or 0x80000 <= address < 0x87000)):
                raise ValueError('Memory read outside known ranges')
            if opcode == 0x32 and ('--allow-save' not in sys.argv or address or value):
                raise ValueError('Save is disabled')
            if opcode in (0x31, 0x32): require_idle()
            while select.select([fd], [], [], 0)[0]: os.read(fd, 64)
            os.write(fd, b'\x4b' + data)
            deadline = time.monotonic() + 1
            matched = False
            while (remaining := deadline - time.monotonic()) > 0:
                if not select.select([fd], [], [], remaining)[0]: break
                response = os.read(fd, 64)
                if len(response) == 11 and response[0] == 0x4b and (
                        response[5:] == bytes(6) if opcode == 0x08 else response[1:7] == data[:6]):
                    print(json.dumps({'id': request['id'], 'data': response[1:].hex()}), flush=True)
                    matched = True
                    break
            if not matched:
                raise TimeoutError('No matching HID response')
        except Exception as exc:
            print(json.dumps({'id': request['id'], 'error': str(exc)}), flush=True)
finally:
    os.close(fd)
