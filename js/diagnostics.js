// diagnostics.js — drift metrics, test recorders, scoring & report builder.
// All raw thresholds are in 0..255 units (center = 128). Tunable in THRESHOLDS.
//
// Metric definitions:
//   center offset = | mean(rest) - 128 |           → a worn pot/Hall sensor rests off-center
//   jitter        = stddev of rest samples         → noisy wiper / dirty track
//   deadzone(rec) = offset + 3.5·jitter + margin    → smallest zone that hides the noise
//   range         = min/max reached during a sweep  → can the stick still hit the extremes
//   circularity   = min/max sector radius (0..1)    → does it reach all directions evenly
//   snapback      = overshoot past center on release → spring/mechanical overshoot

// Raw 0..255 units (center 128). Boundaries match the researched pass/fail rubric:
//   offset: PASS <6 (0.05n) · WARN 6-19 · FAIL >19 (0.15n)
//   jitter: PASS <1.3 (0.005n) · WARN 1.3-2.5 · FAIL >2.5 (0.010n)
export const THRESHOLDS = {
  offset: [3, 6, 12, 19],     // none < negligible < mild < moderate < severe
  jitter: [1.3, 2.5],         // clean < elevated < noisy
  circularity: [0.92, 0.85, 0.75],
  snapback: [0.05, 0.10, 0.18],
};

// ---- running stats (Welford) per axis ----
class Axis {
  constructor() { this.n = 0; this.mean = 0; this.m2 = 0; this.min = 255; this.max = 0; }
  push(v) {
    this.n++;
    const d = v - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (v - this.mean);
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
  }
  get std() { return this.n > 1 ? Math.sqrt(this.m2 / (this.n - 1)) : 0; }
}

// ---- a single test recorder ----
export class Recorder {
  constructor(type) {
    this.type = type;            // 'rest' | 'range' | 'snapback'
    this.left = { x: new Axis(), y: new Axis() };
    this.right = { x: new Axis(), y: new Axis() };
    // circularity sectors (16) per stick, holding max radius seen
    this.sectors = { left: new Array(16).fill(0), right: new Array(16).fill(0) };
    // snapback tracking
    this._snap = { left: null, right: null };
    this.overshoot = { left: 0, right: 0 };
  }

  feed(state) {
    this._axis('left', state.left);
    this._axis('right', state.right);
    if (this.type === 'range') { this._sector('left', state.left.norm); this._sector('right', state.right.norm); }
    if (this.type === 'snapback') { this._snapback('left', state.left.norm); this._snapback('right', state.right.norm); }
  }

  _axis(side, s) {
    const a = this[side];
    if (this.type === 'rest') { a.x.push(s.raw[0]); a.y.push(s.raw[1]); }
    else { a.x.push(s.raw[0]); a.y.push(s.raw[1]); }
  }

  _sector(side, n) {
    const mag = Math.hypot(n[0], n[1]);
    if (mag < 0.4) return;
    let ang = Math.atan2(n[1], n[0]); // -pi..pi
    let idx = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 16) % 16;
    if (mag > this.sectors[side][idx]) this.sectors[side][idx] = mag;
  }

  _snapback(side, n) {
    const mag = Math.hypot(n[0], n[1]);
    const st = this._snap;
    if (mag > 0.7) { st[side] = { dir: [n[0], n[1]], armed: true }; }     // pushed out → arm
    else if (st[side]?.armed && mag < 0.25) {                              // crossed back to center
      st[side].armed = false; st[side].watch = 1;
    } else if (st[side]?.watch && st[side].watch > 0) {
      // within the watch window, look for overshoot opposite the original push
      const dot = n[0] * st[side].dir[0] + n[1] * st[side].dir[1];
      if (dot < 0 && mag > this.overshoot[side]) this.overshoot[side] = mag;
      st[side].watch = mag < 0.05 ? 0 : st[side].watch; // settle ends watch
    }
  }

  // summarize this recorder into per-stick numbers
  summary() {
    const stick = (side) => {
      const a = this[side];
      const offX = a.x.mean - 128, offY = a.y.mean - 128;
      const offMag = Math.hypot(offX, offY);
      const std = Math.max(a.x.std, a.y.std);
      const sectors = this.sectors[side].filter(v => v > 0);
      const circ = sectors.length >= 8 ? Math.min(...sectors) / Math.max(...sectors) : null;
      return {
        offset: { x: offX, y: offY, mag: offMag },
        jitter: std,
        range: { xmin: a.x.min, xmax: a.x.max, ymin: a.y.min, ymax: a.y.max },
        circularity: circ,
        overshoot: this.overshoot[side],
      };
    };
    return { left: stick('left'), right: stick('right') };
  }
}

// ---- classifiers → {label, tag} where tag ∈ good|warn|bad ----
const band = (v, t, labels) => {
  for (let i = 0; i < t.length; i++) if (v < t[i]) return labels[i];
  return labels[labels.length - 1];
};
export const classify = {
  offset: (v) => band(v, THRESHOLDS.offset,
    [tg('None', 'good'), tg('Negligible', 'good'), tg('Mild', 'warn'), tg('Moderate', 'warn'), tg('Severe', 'bad')]),
  jitter: (v) => band(v, THRESHOLDS.jitter,
    [tg('Clean', 'good'), tg('Elevated', 'warn'), tg('Noisy', 'bad')]),
  circularity: (v) => v == null ? tg('—', 'good') : band(-v, THRESHOLDS.circularity.map(x => -x),
    [tg('Full', 'good'), tg('Good', 'good'), tg('Reduced', 'warn'), tg('Poor', 'bad')]),
  snapback: (v) => band(v, THRESHOLDS.snapback,
    [tg('Tight', 'good'), tg('Slight', 'warn'), tg('Loose', 'warn'), tg('Bad', 'bad')]),
};
function tg(label, tag) { return { label, tag }; }

// ---- build the full report from up to 3 recorders ----
export function buildReport({ rest, range, snapback }) {
  const r = rest?.summary();
  const rg = range?.summary();
  const sb = snapback?.summary();
  const metrics = [];
  let score = 100;

  const worst = (sel) => Math.max(sel('left'), sel('right'));

  if (r) {
    metrics.push(row('Center offset', fmt1(r.left.offset.mag), fmt1(r.right.offset.mag),
      classify.offset(Math.max(r.left.offset.mag, r.right.offset.mag))));
    metrics.push(row('Jitter (σ)', fmt2(r.left.jitter), fmt2(r.right.jitter),
      classify.jitter(Math.max(r.left.jitter, r.right.jitter))));
    score -= clamp((worst(s => r[s].offset.mag) - 2) * 3, 0, 42);
    score -= clamp((worst(s => r[s].jitter) - 1) * 4, 0, 15);
  }
  if (rg) {
    const reach = (s) => `${rg[s].range.xmin}-${rg[s].range.xmax} / ${rg[s].range.ymin}-${rg[s].range.ymax}`;
    metrics.push(row('Range (X / Y)', reach('left'), reach('right'),
      rangeTag(Math.min(reachPct(rg.left.range), reachPct(rg.right.range)))));
    metrics.push(row('Circularity', pct(rg.left.circularity), pct(rg.right.circularity),
      classify.circularity(minDef(rg.left.circularity, rg.right.circularity))));
    score -= clamp((1 - minDef(rg.left.circularity, rg.right.circularity, 1)) * 60, 0, 14);
    score -= clamp((1 - Math.min(reachPct(rg.left.range), reachPct(rg.right.range))) * 40, 0, 10);
  }
  if (sb) {
    metrics.push(row('Snapback', fmt2(sb.left.overshoot), fmt2(sb.right.overshoot),
      classify.snapback(Math.max(sb.left.overshoot, sb.right.overshoot))));
    score -= clamp((Math.max(sb.left.overshoot, sb.right.overshoot) - 0.05) * 90, 0, 12);
  }

  score = Math.max(0, Math.round(score));
  const verdict = verdictFor(score);
  const deadzone = r ? recDeadzone(r) : null;
  const fixes = buildFixes({ r, rg, sb, score, deadzone });

  return { score, verdict, metrics, deadzone, fixes, raw: { rest: r, range: rg, snapback: sb } };
}

function recDeadzone(r) {
  // researched rule: deadzone ≈ max resting magnitude × 1.8, floor 0.05.
  // resting magnitude = center offset + ~2.5σ jitter, normalized to 0..1.
  const dz = (s) => {
    const restMag = (s.offset.mag + 2.5 * s.jitter) / 127;
    return Math.min(0.30, Math.max(0.05, Math.round(restMag * 1.8 * 100) / 100));
  };
  return { left: dz(r.left), right: dz(r.right) };
}

function buildFixes({ r, rg, sb, score, deadzone }) {
  const fixes = [];
  const offMag = r ? Math.max(r.left.offset.mag, r.right.offset.mag) : 0;
  const jit = r ? Math.max(r.left.jitter, r.right.jitter) : 0;

  if (score >= 90) {
    fixes.push({ tag: 'good', text: 'Sticks are healthy — no drift detected. No action needed.' });
    return fixes;
  }
  if (offMag >= 2) {
    fixes.push({ tag: 'warn', text: `Resting center is off by ~${offMag.toFixed(1)}/255. Apply a deadzone of ${deadzone ? Math.round(Math.max(deadzone.left, deadzone.right) * 100) : '~'}% in Steam (Controller Settings → Deadzone) or per-game to mask it.` });
  }
  if (jit >= 2) {
    fixes.push({ tag: 'warn', text: 'Noisy signal at rest (dirty/worn carbon track). A shot of electrical-contact cleaner under the stick cap, worked in by rotating the stick, often clears this.' });
  }
  if (rg && Math.min(reachPct(rg.left.range), reachPct(rg.right.range)) < 0.93) {
    fixes.push({ tag: 'warn', text: 'Stick is not reaching full range in all directions — outer deadzone/anti-deadzone may help, but this usually signals mechanical wear.' });
  }
  if (sb && Math.max(sb.left.overshoot, sb.right.overshoot) >= 0.10) {
    fixes.push({ tag: 'warn', text: 'Noticeable snapback/overshoot on release. Mostly cosmetic; a small deadzone helps, full fix is module replacement.' });
  }
  if (score < 55) {
    fixes.push({ tag: 'bad', text: 'Drift is significant. Software masking buys time, but the durable fix is a contactless Hall-effect / TMR replacement module (e.g. Gulikit) — it cannot drift because there is no wiper to wear.' });
  }
  fixes.push({ tag: 'good', text: 'On-controller recalibration (⚠ button below) re-centers the stick in the controller’s own memory so the fix applies system-wide, not just in one game.' });
  return fixes;
}

// ---- helpers ----
function reachPct(rng) {
  const low = Math.min(rng.xmin, rng.ymin), high = Math.max(rng.xmax, rng.ymax);
  const lowOk = Math.max(0, (16 - low) / 16);   // wants <= ~8
  const highOk = Math.max(0, (high - 239) / 16); // wants >= ~247
  return Math.min(1, (lowOk + highOk) / 2 + 0.5);
}
function rangeTag(p) { return p >= 0.93 ? tg('Full', 'good') : p >= 0.85 ? tg('Reduced', 'warn') : tg('Limited', 'bad'); }
function minDef(a, b, d = 1) { const xs = [a, b].filter(v => v != null); return xs.length ? Math.min(...xs) : d; }
function verdictFor(s) {
  if (s >= 90) return { label: 'Excellent — no drift', tag: 'good' };
  if (s >= 75) return { label: 'Good — minor wear', tag: 'good' };
  if (s >= 55) return { label: 'Mild drift', tag: 'warn' };
  if (s >= 35) return { label: 'Moderate drift', tag: 'warn' };
  return { label: 'Severe drift', tag: 'bad' };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt1 = (v) => v.toFixed(1);
const fmt2 = (v) => v.toFixed(2);
const pct = (v) => v == null ? '—' : Math.round(v * 100) + '%';
const row = (name, left, right, verdict) => ({ name, left, right, verdict });
