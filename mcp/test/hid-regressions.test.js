import test from 'node:test';
import assert from 'node:assert/strict';
import HID from 'node-hid';
import { Controller, parseSticks } from '../hid/dualsense.js';

function report(id, length) {
  const data = Array(length).fill(0); data[0] = id;
  const start = id === 0x31 ? 2 : 1;
  for (let i = 0; i < 4; i++) data[start + i] = 128;
  return data;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('omitted controller metadata defaults to an empty object', () => {
  assert.deepEqual(new Controller().info, {});
});
test('explicit paths resolve metadata, including the Edge product identifier', () => {
  const originalDevices = HID.devices, OriginalHID = HID.HID;
  const descriptor = { path: 'synthetic-controller', vendorId: 0x054c, productId: 0x0df2 };
  let closed = false;
  try {
    HID.devices = () => [descriptor];
    HID.HID = class { close() { closed = true; } };
    const c = new Controller(descriptor.path); c.open();
    assert.equal(c.isEdge, true); assert.equal(c.info.productId, descriptor.productId);
    c.close(); assert.equal(closed, true);
  } finally { HID.devices = originalDevices; HID.HID = OriginalHID; }
});
test('missing explicit path fails before trying to open a different device', () => {
  const original = HID.devices;
  try { HID.devices = () => []; assert.throws(() => new Controller('synthetic-missing').open(), /no longer connected/); }
  finally { HID.devices = original; }
});
test('USB and full Bluetooth reports use the same logical button masks', () => {
  const usb = report(1, 64), bt = report(0x31, 78);
  usb[8] = bt[9] = 0x28; usb[9] = bt[10] = 1; usb[10] = bt[11] = 2;
  assert.equal(parseSticks(usb).buttons, parseSticks(bt).buttons);
});
test('basic Bluetooth triggers do not read button bytes', () => {
  const basic = report(1, 10); basic[5] = 0x28; basic[6] = 1; basic[7] = 2;
  basic[8] = 11; basic[9] = 222;
  const sticks = parseSticks(basic);
  assert.equal(sticks.mode, 'bt-compat'); assert.equal(sticks.l2, 11); assert.equal(sticks.r2, 222);
  const padded = new Array(78).fill(0); padded.splice(0, basic.length, ...basic);
  assert.equal(parseSticks(padded).mode, 'bt-compat'); assert.equal(parseSticks(padded).l2, 11); assert.equal(parseSticks(padded).r2, 222);
});
test('truncated and unknown input reports are rejected', () => {
  assert.equal(parseSticks([1, 128, 128, 128, 128]), null);
  assert.equal(parseSticks(report(0x31, 20)), null);
  assert.equal(parseSticks(report(0x7f, 64)), null);
});
test('USB and Bluetooth battery fields are read from their respective offsets', () => {
  for (const [id, length, index] of [[1, 64, 53], [0x31, 78, 54]]) {
    const data = report(id, length); data[index] = 0x15;
    const c = new Controller(); c.dev = { readTimeout() { return data; } };
    assert.deepEqual(c.getBattery(), { level: 50, status: 'charging', mode: id === 1 ? 'usb' : 'bt' });
  }
});
test('output reports have standard lengths and correct Bluetooth CRC coverage', () => {
  for (const mode of ['usb', 'bt']) {
    const packets = []; const c = new Controller(); c._mode = mode;
    c.dev = { write(packet) { packets.push(packet); } };
    c.applyLightbar(10, 20, 30); c.applyLightbar(10, 20, 30);
    const packet = packets[0]; assert.equal(packet.length, mode === 'usb' ? 63 : 78);
    if (mode === 'bt') {
      assert.deepEqual(packet.slice(0, 3), [0x31, 0, 0x10]); assert.equal(packets[1][1], 0x10);
      assert.deepEqual(packet.slice(47, 50), [10, 20, 30]);
      assert.equal(Buffer.from(packet).readUInt32LE(74), crc32([0xa2, ...packet.slice(0, 74)]));
    }
  }
});
test('unknown transport refuses output rather than guessing Bluetooth', () => {
  let written = false; const c = new Controller();
  c.dev = { write() { written = true; } }; c.readSticksOnce = () => null;
  assert.throws(() => c.applyLightbar(0, 0, 0), /transport detected/); assert.equal(written, false);
});
test('missing reports reset the rest gate instead of counting silence as stability', async () => {
  const originalNow = Date.now; let now = 0, reads = 0;
  const c = new Controller(); c.dev = {};
  c._readOnce = () => {
    now += 100; reads++;
    return reads === 3 ? null : { s: { lx: 128, ly: 128, rx: 128, ry: 128 } };
  };
  try {
    Date.now = () => now;
    assert.equal(await c.waitForRest({ needStable: 200, timeout: 600 }), false);
  } finally { Date.now = originalNow; }
});
