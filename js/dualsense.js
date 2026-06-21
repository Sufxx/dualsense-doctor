// dualsense.js — WebHID connection + input report parsing for the Sony DualSense (PS5).
//
// Report layouts (verified against the Linux hid-playstation driver & controllers.fyi):
//   USB  : reportId 0x01, payload[0..3] = LX, LY, RX, RY ; [4]=L2 ; [5]=R2
//   BT   : reportId 0x31, payload[0]=seqtag, [1..4] = LX, LY, RX, RY ; [5]=L2 ; [6]=R2
//   BT(compat): reportId 0x01 (minimal), payload[0..3] = LX, LY, RX, RY  (sent before full mode)
//
// WebHID delivers the report WITHOUT the leading reportId byte — it is exposed
// separately as event.reportId, and event.data is a DataView of everything after it.

export const SONY_VID = 0x054c;
export const DUALSENSE_PIDS = [0x0ce6, 0x0df2]; // DualSense, DualSense Edge

const FACE = { square: 0, cross: 0, circle: 0, triangle: 0 };

export class DualSense extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.mode = null;            // 'usb' | 'bt' | 'bt-compat'
    this.state = freshState();
    this._onInput = this._onInput.bind(this);
  }

  get connected() { return !!(this.device && this.device.opened); }

  async connect() {
    if (!('hid' in navigator)) {
      throw new Error('WebHID not supported. Use Chrome or Edge (not Safari/Firefox).');
    }
    const filters = [{ vendorId: SONY_VID }];
    const [device] = await navigator.hid.requestDevice({ filters });
    if (!device) throw new Error('No device selected.');
    await this._attach(device);
    return device;
  }

  // Reattach a device the browser already remembers (no user gesture needed beyond load).
  async tryReconnect() {
    if (!('hid' in navigator)) return false;
    const devices = await navigator.hid.getDevices();
    const ds = devices.find(d => d.vendorId === SONY_VID);
    if (!ds) return false;
    await this._attach(ds);
    return true;
  }

  async _attach(device) {
    this.device = device;
    if (!device.opened) await device.open();
    device.addEventListener('inputreport', this._onInput);
    navigator.hid.addEventListener('disconnect', (e) => {
      if (e.device === this.device) this._handleDisconnect();
    });
    // Best-effort: read feature report 0x05 to nudge BT into full-report mode and
    // confirm the link. Failure is harmless — diagnostics work in compat mode too.
    try { await device.receiveFeatureReport(0x05); } catch { /* ignore */ }
    this.dispatchEvent(new CustomEvent('connect', { detail: { device } }));
  }

  _handleDisconnect() {
    if (this.device) this.device.removeEventListener('inputreport', this._onInput);
    this.device = null;
    this.mode = null;
    this.dispatchEvent(new CustomEvent('disconnect'));
  }

  async disconnect() {
    if (this.device) {
      try { await this.device.close(); } catch { /* ignore */ }
    }
    this._handleDisconnect();
  }

  _onInput(event) {
    const { reportId, data } = event; // data: DataView, reportId byte stripped
    let lx, ly, rx, ry, l2 = 0, r2 = 0, buttons = 0;

    if (reportId === 0x31) {
      // BT full report — sticks shifted by 1 (seq tag at [0])
      this.mode = 'bt';
      lx = data.getUint8(1); ly = data.getUint8(2);
      rx = data.getUint8(3); ry = data.getUint8(4);
      l2 = data.getUint8(5); r2 = data.getUint8(6);
      buttons = data.getUint8(8);
    } else if (reportId === 0x01) {
      // USB full report (~63 data bytes) OR BT compatibility report (~9 bytes) —
      // both put sticks at [0..3]. byteLength is the reliable discriminator and it
      // drives the USB-only safety gate for on-controller calibration.
      this.mode = data.byteLength >= 40 ? 'usb' : 'bt-compat';
      lx = data.getUint8(0); ly = data.getUint8(1);
      rx = data.getUint8(2); ry = data.getUint8(3);
      if (data.byteLength > 5) { l2 = data.getUint8(4); r2 = data.getUint8(5); }
      if (data.byteLength > 8) buttons = data.getUint8(8);
    } else {
      return; // unknown report id
    }

    const s = this.state;
    s.left.raw = [lx, ly];
    s.right.raw = [rx, ry];
    s.left.norm = [norm(lx), norm(ly)];
    s.right.norm = [norm(rx), norm(ry)];
    s.l2 = l2; s.r2 = r2;
    s.t = performance.now();

    this.dispatchEvent(new CustomEvent('input', { detail: s }));
  }
}

export function norm(v) {
  // 0..255 → -1..1, center at 128. Clamp to guard against 1..255 asymmetry.
  return Math.max(-1, Math.min(1, (v - 128) / 127));
}

function freshState() {
  return {
    left: { raw: [128, 128], norm: [0, 0] },
    right: { raw: [128, 128], norm: [0, 0] },
    l2: 0, r2: 0, buttons: { ...FACE }, t: 0,
  };
}
