// effects.js — DualSense OUTPUT control (adaptive triggers + lightbar) over WebHID.
// Works over USB (report 0x02) and Bluetooth (report 0x31 + CRC-32 seeded with 0xA2).
//
// Trigger effect recipes use the community-standard generator encodings:
//   Feedback (mode 0x21) = uniform resistance wall from a position to the end.
//   Weapon   (mode 0x25) = resist between start..end then 'break' (a click).
// Effect block = 11 bytes: [mode, p1..p10]. Position scale 0-9 (~10% travel each).

// ---------- common 47-byte output payload ----------
// common[0]=validFlag0, [1]=validFlag1, [2]=motorR, [3]=motorL,
// [10]=R2 mode, [11..20]=R2 params, [21]=L2 mode, [22..31]=L2 params,
// [39]=validFlag2, [44..46]=lightbar R,G,B.
const FLAG0_TRIGGERS = 0x04 | 0x08; // R2 + L2 trigger effect enable
const FLAG1_LIGHTBAR = 0x04;        // lightbar enable (flag1 bit2)
const FLAG2_LIGHTBAR_SETUP = 0x02;

export function buildCommon({ rEff = null, lEff = null, led = null } = {}) {
  const c = new Uint8Array(47);
  let f0 = 0, f1 = 0, f2 = 0;
  if (rEff) { c.set(rEff.slice(0, 11), 10); f0 |= 0x04; }
  if (lEff) { c.set(lEff.slice(0, 11), 21); f0 |= 0x08; }
  if (led) {
    f1 |= FLAG1_LIGHTBAR; f2 |= FLAG2_LIGHTBAR_SETUP;
    c[44] = led[0] & 0xff; c[45] = led[1] & 0xff; c[46] = led[2] & 0xff;
  }
  c[0] = f0; c[1] = f1; c[39] = f2;
  return c;
}

// ---------- CRC-32 (reflected IEEE/zlib) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- send an output report based on connection mode ----------
export async function sendOutput(ds, common) {
  if (!ds?.device?.opened) throw new Error('Controller not connected.');
  if (ds.mode === 'usb') {
    // USB: report 0x02, data = common payload (47 bytes), padded to 47.
    await ds.device.sendReport(0x02, common);
  } else {
    // Bluetooth: report 0x31, data = [tag 0x02, ...common, CRC32 LE].
    // CRC computed over [0xA2, 0x31, 0x02, ...common].
    const data = new Uint8Array(1 + common.length + 4);
    data[0] = 0x02;                 // tag
    data.set(common, 1);
    const crcInput = new Uint8Array(3 + common.length);
    crcInput[0] = 0xa2; crcInput[1] = 0x31; crcInput[2] = 0x02;
    crcInput.set(common, 3);
    const crc = crc32(crcInput);
    const o = 1 + common.length;
    data[o] = crc & 0xff; data[o + 1] = (crc >> 8) & 0xff;
    data[o + 2] = (crc >> 16) & 0xff; data[o + 3] = (crc >> 24) & 0xff;
    await ds.device.sendReport(0x31, data);
  }
}

// ---------- trigger effect recipes (11-byte blocks) ----------
export function effOff() { return [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 11); }

export function effFeedback(position, strength) {
  if (strength <= 0) return effOff();
  position = clamp(position, 0, 9); strength = clamp(strength, 1, 8);
  const force = (strength - 1) & 0x07;
  let forceZones = 0, active = 0;
  for (let i = position; i < 10; i++) { forceZones |= force << (3 * i); active |= 1 << i; }
  return [0x21, active & 0xff, (active >> 8) & 0xff,
    forceZones & 0xff, (forceZones >> 8) & 0xff, (forceZones >> 16) & 0xff, (forceZones >> 24) & 0xff,
    0, 0, 0, 0];
}

export function effWeapon(start, end, strength) {
  start = clamp(start, 2, 7); end = clamp(end, start + 1, 8); strength = clamp(strength, 1, 8);
  const zones = (1 << start) | (1 << end);
  return [0x25, zones & 0xff, (zones >> 8) & 0xff, (strength - 1) & 0xff, 0, 0, 0, 0, 0, 0, 0];
}

export const TRIGGER_PRESETS = {
  off: () => effOff(),
  light: () => effFeedback(3, 4),
  firm: () => effFeedback(2, 6),
  max: () => effFeedback(1, 8),
  weapon: () => effWeapon(3, 5, 8),
};

// ---------- high-level helpers ----------
export async function applyTriggers(ds, leftEff, rightEff) {
  await sendOutput(ds, buildCommon({ lEff: leftEff, rEff: rightEff }));
}
export async function applyLightbar(ds, r, g, b) {
  await sendOutput(ds, buildCommon({ led: [r, g, b] }));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
