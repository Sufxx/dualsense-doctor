// calibration.js — REAL on-controller stick recalibration over WebHID (USB only).
//
// Protocol verified byte-for-byte against dualshock-tools (MIT):
//   github.com/dualshock-tools/dualshock-tools.github.io  →  js/controllers/ds5-controller.js
// Reverse-engineered by Paolo "the_al" — blog.the.al/2024/04/02/calibrating-dualsense.html
//
// This rewrites the stick CENTER and RANGE baselines into the DualSense's own NVS flash
// (the same data Sony writes at the factory). It persists across reboots and travels back
// to the PS5 — a genuine root-cause fix for electrical/center drift, NOT a deadzone mask.
//
// SAFETY MODEL (mirrors the reference tool):
//   • USB ONLY. Bluetooth does not expose these feature reports — hard-blocked.
//   • Calibration writes go to a temporary RAM "flash-mirror" first; nothing is permanent
//     until save() runs NVS-unlock → NVS-lock. So a failure before save() changes nothing.
//   • The only sensitive step is the flash write inside save(): never unplug during it.
//   • Standard DualSense (PID 0x0ce6) persists (returns OK). DualSense Edge (0x0df2) needs a
//     hardware write-protect mod to persist — we detect and warn.
//   • Too-old firmware (2020/2021 build) blocks the commands — detected and warned.
//   • A soft mis-calibration is fully recoverable by re-running calibration.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const u32be = (dv) => dv.getUint32(0, false);

// Expected 0x83 echo responses (report-id-inclusive, big-endian).
const OK = {
  centerBegin: 0x83010101,
  centerSample: 0x83010101,
  centerEnd: 0x83010102,
  rangeBegin: 0x83010201,
  rangeEnd: 0x83010202,
};

// Block until BOTH sticks are untouched (near rest) and not moving for `needStable` ms,
// so center sampling can never capture a touched/moving stick. Throws on timeout.
function waitForRest(ds, { needStable = 1500, timeout = 25000, restTol = 22, velTol = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let last = null, stableSince = null;
    const t0 = performance.now();
    const onInput = (e) => {
      const s = e.detail;
      const lx = s.left.raw[0], ly = s.left.raw[1], rx = s.right.raw[0], ry = s.right.raw[1];
      const near = Math.hypot(lx - 128, ly - 128) < restTol && Math.hypot(rx - 128, ry - 128) < restTol;
      const vel = last ? Math.max(Math.abs(lx - last[0]), Math.abs(ly - last[1]), Math.abs(rx - last[2]), Math.abs(ry - last[3])) : 999;
      last = [lx, ly, rx, ry];
      if (near && vel <= velTol) {
        if (stableSince == null) stableSince = performance.now();
        else if (performance.now() - stableSince >= needStable) { cleanup(); resolve(true); }
      } else stableSince = null;
      if (performance.now() - t0 > timeout) { cleanup(); reject(new Error('Sticks never settled (still being touched?). Aborted — nothing was written.')); }
    };
    const cleanup = () => ds.removeEventListener('input', onInput);
    ds.addEventListener('input', onInput);
  });
}

export const calibration = {
  supported: true,
  statusText: 'Recalibration rewrites the stick center into the controller’s own memory (USB only). Verified against the open-source dualshock-tools protocol.',

  // ---- preflight: gather state & decide if we can safely proceed ----
  async preflight(ds) {
    const out = { ok: false, usb: false, isEdge: false, firmware: null, oldFirmware: false, warnings: [], blocking: null };
    if (!ds?.connected) { out.blocking = 'Controller is not connected.'; return out; }

    out.isEdge = ds.device.productId === 0x0df2;
    out.usb = ds.mode === 'usb';

    if (!out.usb) {
      out.blocking = 'On-controller recalibration requires a USB DATA cable. Your controller is on ' +
        (ds.mode === 'bt' || ds.mode === 'bt-compat' ? 'Bluetooth' : 'an unknown link') +
        '. Plug it into the computer with a USB-C data cable (not charge-only), then click Connect again and pick the controller.';
      return out;
    }

    // read firmware build date (report 0x20)
    try {
      const v = await ds.device.receiveFeatureReport(0x20);
      if (v && v.getUint8(0) === 0x20 && v.buffer.byteLength === 64) {
        const build = new TextDecoder().decode(v.buffer.slice(1, 12)).replace(/\0+$/, '').trim();
        out.firmware = build;
        if (/ ?20(20|21)/.test(build)) { out.oldFirmware = true; out.warnings.push(`Firmware build "${build}" is old (2020/2021). Update via a PS5 or Sony’s Windows updater first — old firmware blocks calibration.`); }
      }
    } catch { out.warnings.push('Could not read firmware info (continuing).'); }

    if (out.isEdge) {
      out.warnings.push('This is a DualSense Edge. Calibration will apply but will NOT persist after reboot unless the stick-module write-protect has been hardware-modded. Standard DualSense persists fine.');
    }

    out.ok = !out.blocking;
    return out;
  },

  // ---- full guided flow: center → range → save permanently ----
  // onStep(title, instruction, progress|null) drives the UI.
  async run(ds, { onStep, includeRange = true } = {}) {
    const pf = await this.preflight(ds);
    if (!pf.ok) throw new Error(pf.blocking || 'Preflight failed.');
    const dev = ds.device;

    // ---- 1. CENTER ----
    // SAFETY: never sample the center while a stick is touched or moving — that would
    // write a WRONG center into NVS (and it persists). Block until both sticks are
    // genuinely at rest, exactly like the Python CLI's wait_for_rest. Throws (no write)
    // if they never settle.
    onStep?.('Recalibrating center', 'Let go of BOTH sticks completely — waiting for them to settle…', 0);
    await waitForRest(ds);
    onStep?.('Recalibrating center', 'Sticks at rest — sampling true center (keep hands off).', 0.05);
    await cmd(dev, 0x82, [1, 1, 1], OK.centerBegin, 'center begin');
    const SAMPLES = 6;
    for (let i = 0; i < SAMPLES; i++) {
      await cmd(dev, 0x82, [3, 1, 1], OK.centerSample, 'center sample');
      onStep?.('Recalibrating center', 'Keep both sticks centered — sampling resting position…', (i + 1) / SAMPLES * 0.45);
      await sleep(450);
    }
    await cmd(dev, 0x82, [2, 1, 1], OK.centerEnd, 'center end');
    onStep?.('Center captured', 'New center stored (temporarily). Next: range.', 0.5);
    await sleep(700);

    // ---- 2. RANGE (optional but recommended) ----
    if (includeRange) {
      await cmd(dev, 0x82, [1, 1, 2], OK.rangeBegin, 'range begin');
      const RANGE_MS = 9000, t0 = performance.now();
      while (true) {
        const p = Math.min(1, (performance.now() - t0) / RANGE_MS);
        onStep?.('Recalibrating range', 'Slowly roll BOTH sticks around the full outer edge, 3–4 times.', 0.5 + p * 0.4);
        if (p >= 1) break;
        await sleep(120);
      }
      await cmd(dev, 0x82, [2, 1, 2], OK.rangeEnd, 'range end');
      onStep?.('Range captured', 'New range stored (temporarily). Saving permanently…', 0.92);
      await sleep(500);
    }

    // ---- 3. SAVE PERMANENTLY (NVS unlock → lock) — the only sensitive step ----
    onStep?.('Saving to controller', 'Writing to the controller’s memory — do NOT unplug.', null);
    const status = await this.save(dev); // verifies the echo + ends in a known-good NVS state, else throws

    onStep?.('Recalibration complete', 'Saved to controller memory. Re-run the diagnostic to confirm the drift is gone.', 1);
    return { ok: true, status, edge: pf.isEdge };
  },

  // center-only fast path (the core drift fix, lowest risk)
  async runCenterOnly(ds, opts = {}) { return this.run(ds, { ...opts, includeRange: false }); },

  async save(dev) {
    // nvsUnlock (password 0x65 0x32 0x40 0x0c) then nvsLock — commits the mirror to flash.
    // This is the ONLY irreversible step, so verify the controller answers each command
    // and ends in a known NVS state before reporting success (don't claim a save we
    // can't confirm). Returns the final NVS status string; throws on a bad state.
    await dev.sendFeatureReport(0x80, new Uint8Array([3, 2, 101, 50, 64, 12]));
    const unlockEcho = await dev.receiveFeatureReport(0x81);
    if (!unlockEcho || unlockEcho.byteLength < 2) {
      throw new Error('NVS unlock got no response — aborted, nothing was committed.');
    }
    await sleep(150);
    await dev.sendFeatureReport(0x80, new Uint8Array([3, 1]));
    await dev.receiveFeatureReport(0x81);
    await sleep(150);
    const status = await this.queryNvStatus(dev);
    if (status.startsWith('unknown')) {
      throw new Error(`NVS save left an unexpected state (${status}). Re-run calibration to be safe.`);
    }
    return status;
  },

  async queryNvStatus(dev) {
    try {
      await dev.sendFeatureReport(0x80, new Uint8Array([3, 3]));
      const d = await dev.receiveFeatureReport(0x81);
      const ret = d.getUint32(1, false);
      if (ret === 0x03030200) return 'unlocked(permanent)';
      if (ret === 0x03030201) return 'locked(temporary)';
      if (ret === 0x15010100) return 'pending_reboot';
      return 'unknown(0x' + ret.toString(16) + ')';
    } catch { return 'unknown'; }
  },

  // restore: re-running calibration is the recovery path; expose a soft reset too.
  async softReset(dev) { try { await dev.sendFeatureReport(0x80, new Uint8Array([1, 1])); } catch {} },
};

// send a 0x82 calibration command and verify the 0x83 echo; throw (abort, no save) on mismatch.
async function cmd(dev, reportId, data, expect, label) {
  await dev.sendFeatureReport(reportId, new Uint8Array(data));
  const resp = await dev.receiveFeatureReport(0x83);
  const got = u32be(resp);
  if (got !== expect) {
    throw new Error(`Calibration step "${label}" rejected by controller (got 0x${got.toString(16)}, expected 0x${expect.toString(16)}). Nothing was saved — safe to retry.`);
  }
}
