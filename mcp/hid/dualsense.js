// hid/dualsense.js — node-hid engine for the DualSense MCP server.
// Ports the verified parsing/diagnostics/effects/calibration logic from the repo
// (dsdoctor.py, js/*.js). node-hid input data INCLUDES the report id at buf[0], so
// stick offsets follow the Python parser (not the report-id-stripped WebHID one).
import HID from 'node-hid';

export const SONY_VID = 0x054c;
export const DUALSENSE_PIDS = [0x0ce6, 0x0df2]; // DualSense, DualSense Edge
const EDGE_PID = 0x0df2;

// thresholds (raw 0..255, center 128) — mirror diagnostics.js
export const THRESHOLDS = { offset: [6, 19], jitter: [1.3, 2.5] };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (v) => clamp((v - 128) / 127, -1, 1);

// ---------------- discovery ----------------
export function listControllers() {
  return HID.devices()
    .filter((d) => d.vendorId === SONY_VID && DUALSENSE_PIDS.includes(d.productId))
    .map((d) => ({
      path: d.path,
      productId: d.productId,
      product: d.product || 'DualSense',
      serialNumber: d.serialNumber || null,
      transport: guessTransport(d),
      isEdge: d.productId === EDGE_PID,
    }));
}
function guessTransport(d) {
  // node-hid doesn't expose bus type reliably cross-platform; usagePage/path heuristics.
  if (typeof d.path === 'string' && /bluetooth|bt/i.test(d.path)) return 'bt';
  return 'usb';
}

// ---------------- input parsing ----------------
export function parseSticks(buf) {
  if (!buf || buf.length < 10) return null;
  const id = buf[0];
  if (id === 0x31 && buf.length >= 8) {
    if (buf.length < 78) return null;
    return { lx: buf[2], ly: buf[3], rx: buf[4], ry: buf[5], l2: buf[6], r2: buf[7], buttons: buttonMask(buf, 9), mode: 'bt' };
  }
  if (id === 0x01) {
    const mode = buf.length === 64 ? 'usb' : [10,78].includes(buf.length) ? 'bt-compat' : null;
    if (!mode) return null;
    return {
      lx: buf[1], ly: buf[2], rx: buf[3], ry: buf[4],
      l2: buf[mode === 'usb' ? 5 : 8], r2: buf[mode === 'usb' ? 6 : 9],
      buttons: buttonMask(buf, mode === 'usb' ? 8 : 5), mode,
    };
  }
  return null;
}
function buttonMask(buf, i) { return (buf[i] >> 4) | (buf[i + 1] << 4) | ((buf[i + 2] & 7) << 12); }

// ---------------- effect builders (clamped) ----------------
export function effOff() { return [0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; }
export function effFeedback(position, strength) {
  position = clamp(position | 0, 0, 9); strength = clamp(strength | 0, 1, 8);
  const force = (strength - 1) & 0x07;
  let fz = 0, active = 0;
  for (let i = position; i < 10; i++) { fz |= force << (3 * i); active |= 1 << i; }
  return [0x21, active & 0xff, (active >> 8) & 0xff, fz & 0xff, (fz >> 8) & 0xff, (fz >> 16) & 0xff, (fz >> 24) & 0xff, 0, 0, 0, 0];
}
export function effWeapon(start, end, strength) {
  start = clamp(start | 0, 2, 7); end = clamp(end | 0, start + 1, 8); strength = clamp(strength | 0, 1, 8);
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

// ---------------- output report (USB 0x02 / BT 0x31 + CRC32) ----------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0; return (c ^ 0xffffffff) >>> 0; }

function buildCommon({ rEff = null, lEff = null, led = null } = {}) {
  const c = new Array(47).fill(0);
  let f0 = 0, f1 = 0, f2 = 0;
  if (rEff) { for (let i = 0; i < 11; i++) c[10 + i] = rEff[i] & 0xff; f0 |= 0x04; }
  if (lEff) { for (let i = 0; i < 11; i++) c[21 + i] = lEff[i] & 0xff; f0 |= 0x08; }
  if (led) { f1 |= 0x04; c[44] = clamp(led[0] | 0, 0, 255); c[45] = clamp(led[1] | 0, 0, 255); c[46] = clamp(led[2] | 0, 0, 255); }
  c[0] = f0; c[1] = f1; c[38] = f2;
  return c;
}

// ---------------- diagnostics (ported from dsdoctor.py) ----------------
function axisStats(vals) {
  if (!vals.length) return { mean: 128, std: 0, mn: 128, mx: 128 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  return { mean, std: Math.sqrt(variance), mn: Math.min(...vals), mx: Math.max(...vals) };
}
function stickDiag(xs, ys) {
  const sx = axisStats(xs), sy = axisStats(ys);
  const offX = sx.mean - 128, offY = sy.mean - 128;
  const mag = Math.hypot(offX, offY);
  const jit = Math.max(sx.std, sy.std);
  const restMag = (mag + 2.5 * jit) / 127;
  const dz = Math.min(0.30, Math.max(0.05, Math.round(restMag * 1.8 * 100) / 100));
  const ang = (Math.atan2(offY, offX) * 180 / Math.PI + 360) % 360;
  const dir = ['right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'up', 'up-right'][Math.floor(((ang + 22.5) % 360) / 45)];
  let score = 100 - Math.min(Math.max(0, (mag - 2) * 3) + Math.max(0, (jit - 1) * 4), 100);
  score = Math.max(0, Math.round(score));
  const verdict = (mag < THRESHOLDS.offset[0] && jit < THRESHOLDS.jitter[0]) ? { label: 'healthy', tag: 'good' }
    : (mag < THRESHOLDS.offset[1] && jit < THRESHOLDS.jitter[1]) ? { label: 'mild wear', tag: 'warn' }
      : (mag < THRESHOLDS.offset[1]) ? { label: 'noisy', tag: 'warn' } : { label: 'drifting', tag: 'bad' };
  return {
    offset: { x: +offX.toFixed(2), y: +offY.toFixed(2), mag: +mag.toFixed(2) },
    jitter: +jit.toFixed(2), direction: dir,
    range: { xmin: sx.mn, xmax: sx.mx, ymin: sy.mn, ymax: sy.mx },
    deadzoneRec: dz, score, verdict,
  };
}
export function diagnoseFromFrames(frames, { mode, seconds } = {}) {
  const lx = frames.map((f) => f.lx), ly = frames.map((f) => f.ly);
  const rx = frames.map((f) => f.rx), ry = frames.map((f) => f.ry);
  const left = stickDiag(lx, ly), right = stickDiag(rx, ry);
  const overall = Math.min(left.score, right.score);
  return { mode, seconds, samples: frames.length, left, right, overall };
}

// ---------------- managed controller handle ----------------
export class Controller {
  constructor(info) { this.info = typeof info === 'string' ? { path: info } : (info || {}); this.dev = null; this._mode = null; }
  get mode() { return this._mode; }
  get isEdge() { return this.info.productId === EDGE_PID; }

  open() {
    if (this.dev) return;
    if (!this.info.path) {
      const found = listControllers()[0];
      if (!found) throw new Error('No DualSense found. Connect it via USB (Bluetooth is not reachable on macOS).');
      this.info = found;
    } else {
      const found = listControllers().find(d => d.path === this.info.path);
      if (!found) throw new Error('Selected controller is no longer connected. List controllers again.');
      this.info = found;
    }
    try { this.dev = new HID.HID(this.info.path); }
    catch (e) { throw new Error(`Could not open controller: ${e.message}. On Linux add a hidraw udev rule; on macOS grant Input Monitoring.`); }
  }
  close() { try { this.dev?.close(); } catch {} this.dev = null;this._lightbarReady=false;this._mode=null; }

  _readOnce(timeoutMs = 400) {
    const buf = this.dev.readTimeout(timeoutMs);
    if (!buf || !buf.length) return null;
    const s = parseSticks(buf);
    if (s) this._mode = s.mode;
    return { buf, s };
  }

  readSticksOnce(timeoutMs = 600) {
    this.open();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = this._readOnce(150);
      if (r?.s) {
        const { lx, ly, rx, ry, l2, r2, mode } = r.s;
        return { left: { raw: [lx, ly], norm: [+norm(lx).toFixed(3), +norm(ly).toFixed(3)] },
          right: { raw: [rx, ry], norm: [+norm(rx).toFixed(3), +norm(ry).toFixed(3)] }, l2, r2, mode };
      }
    }
    return null;
  }

  sampleSticks(ms = 2000) {
    this.open();
    const frames = []; let misses = 0; const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const r = this._readOnce(60);
      if (r?.s) frames.push({ t: performance.now() - t0, ...r.s });
      else misses++;
    }
    return { frames, mode: this._mode, n: frames.length, misses };
  }

  getBattery(timeoutMs = 600) {
    this.open();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = this._readOnce(150);
      if (!r) continue;
      const { buf, s } = r;
      if (!s) continue;
      let idx = s.mode === 'bt' ? 54 : s.mode === 'usb' ? 53 : -1;
      if (idx < 0 || buf.length <= idx) return { level: null, status: null, mode: s.mode, reason: 'battery byte not present in this report' };
      const b = buf[idx];
      const level = Math.min(100, (b & 0x0f) * 10);
      const status = ['discharging', 'charging', 'full'][(b >> 4) & 0x0f] || 'unknown';
      return { level, status, mode: s.mode };
    }
    return null;
  }

  readFirmware() {
    this.open();
    try {
      const v = this.dev.getFeatureReport(0x20, 64);
      if (!v || v[0] !== 0x20 || v.length < 12) return null;
      const build = Buffer.from(v.slice(1, 12)).toString('latin1').replace(/\0+$/, '').trim();
      return { build, old: / ?20(20|21)/.test(build) };
    } catch { return null; }
  }

  // ephemeral output (safe / reversible)
  _sendOutput(common) {
    this.open();
    if (this._mode == null) this.readSticksOnce(600); // detect mode
    if (this._mode === 'usb') { this.dev.write([0x02, ...common, ...new Array(15).fill(0)]); return; }
    if (this._mode !== 'bt' && this._mode !== 'bt-compat') throw new Error('No input transport detected; output refused.');
    // Sony/SDL framing: ID, sequence tag, tag, common block, reserved, CRC.
    this._seq = ((this._seq ?? -1) + 1) & 15;
    const packet = [0x31, this._seq << 4, 0x10, ...common, ...new Array(24).fill(0)];
    const crc = crc32([0xa2, ...packet]);
    this.dev.write([...packet, crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff]);
  }
  applyTriggers(lEff, rEff) { this._sendOutput(buildCommon({ lEff, rEff })); }
  applyLightbar(r, g, b) {
    // Sony initialization uses common bytes 38 (flag) and 41 (fade-out setup),
    // followed by a separate color report. Byte 39 is reserved.
    if(!this._lightbarReady){const setup=new Array(47).fill(0);setup[38]=2;setup[41]=2;this._sendOutput(setup);this._lightbarReady=true;}
    this._sendOutput(buildCommon({ led: [clamp(r | 0, 0, 255), clamp(g | 0, 0, 255), clamp(b | 0, 0, 255)] }));
  }

  // ---- GATED calibration (NVS write — brick risk). Only invoked by the gated tool. ----
  calibrationPreflight() {
    this.open();
    const out = { ok: false, usb: this._mode === 'usb', isEdge: this.isEdge, firmware: null, oldFirmware: false, warnings: [], blocking: null };
    if (this._mode == null) this.readSticksOnce(600);
    out.usb = this._mode === 'usb';
    if (!out.usb) { out.blocking = 'Recalibration requires USB. On macOS a Bluetooth DualSense is not reachable; connect a USB-C data cable.'; return out; }
    const fw = this.readFirmware();
    if (fw) { out.firmware = fw.build; out.oldFirmware = fw.old; if (fw.old) out.warnings.push(`Old firmware (${fw.build}) may block calibration.`); }
    if (this.isEdge) out.warnings.push('DualSense Edge: calibration will not persist without the hardware write-protect mod.');
    out.ok = !out.blocking;
    return out;
  }

  async waitForRest({ needStable = 1500, timeout = 25000, restTol = 22, velTol = 3 } = {}) {
    this.open();
    let last = null, stableSince = null; const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = this._readOnce(60); if (!r?.s) { stableSince = null; last = null; continue; }
      const { lx, ly, rx, ry } = r.s;
      const near = Math.hypot(lx - 128, ly - 128) < restTol && Math.hypot(rx - 128, ry - 128) < restTol;
      const vel = last ? Math.max(Math.abs(lx - last[0]), Math.abs(ly - last[1]), Math.abs(rx - last[2]), Math.abs(ry - last[3])) : 999;
      last = [lx, ly, rx, ry];
      if (near && vel <= velTol) { if (stableSince == null) stableSince = Date.now(); else if (Date.now() - stableSince >= needStable) return true; }
      else stableSince = null;
    }
    return false;
  }

  _expect(send, want, label) {
    this.dev.sendFeatureReport(send);
    const resp = this.dev.getFeatureReport(0x83, 64);
    const got = ((resp[0] << 24) | (resp[1] << 16) | (resp[2] << 8) | resp[3]) >>> 0;
    if (got !== (want >>> 0)) throw new Error(`Calibration step "${label}" rejected (got 0x${got.toString(16)}). Nothing was saved — safe to retry.`);
  }
  _nvsStatus() {
    this.dev.sendFeatureReport([0x80, 3, 3]);
    const d = this.dev.getFeatureReport(0x81, 64);
    const ret = ((d[1] << 24) | (d[2] << 16) | (d[3] << 8) | d[4]) >>> 0;
    return { 0x03030200: 'unlocked(permanent)', 0x03030201: 'locked(temporary)', 0x15010100: 'pending_reboot' }[ret] || `unknown(0x${ret.toString(16)})`;
  }

  async recalibrate({ centerOnly = true, onStep } = {}) {
    const pf = this.calibrationPreflight();
    if (!pf.ok) throw new Error(pf.blocking);
    onStep?.('Waiting for the sticks to be untouched & still…');
    if (!await this.waitForRest()) throw new Error('Sticks never settled (still being touched?). Aborted — nothing was written.');
    onStep?.('Sampling true center…');
    this._expect([0x82, 1, 1, 1], 0x83010101, 'center begin');
    for (let i = 0; i < 6; i++) { this._expect([0x82, 3, 1, 1], 0x83010101, 'center sample'); await sleep(450); }
    this._expect([0x82, 2, 1, 1], 0x83010102, 'center end');
    if (!centerOnly) {
      onStep?.('Sampling range — roll both sticks fully for ~9s…');
      this._expect([0x82, 1, 1, 2], 0x83010201, 'range begin');
      await sleep(9000);
      this._expect([0x82, 2, 1, 2], 0x83010202, 'range end');
    }
    onStep?.('Saving to controller memory — do not unplug…');
    this.dev.sendFeatureReport([0x80, 3, 2, 101, 50, 64, 12]); // NVS unlock
    if (!this.dev.getFeatureReport(0x81, 64)) throw new Error('NVS unlock got no response — aborted.');
    await sleep(150);
    this.dev.sendFeatureReport([0x80, 3, 1]); this.dev.getFeatureReport(0x81, 64); // NVS lock
    await sleep(150);
    const status = this._nvsStatus();
    if (status.startsWith('unknown')) throw new Error(`NVS save left an unexpected state (${status}). Re-run to be safe.`);
    return { ok: true, status, edge: this.isEdge };
  }
}
