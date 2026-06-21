// studio.js — DualSense Studio: triggers + lightbar + live/drift, over USB or Bluetooth.
import { DualSense } from './dualsense.js';
import { StickViz } from './visualizer.js';
import { Recorder } from './diagnostics.js';
import { applyTriggers, applyLightbar, effFeedback, effWeapon, effOff } from './effects.js';
import { calibration } from './calibration.js';

const $ = (s) => document.querySelector(s);
const ds = new DualSense();
let latest = ds.state;

// stick visualizers (both tabs)
const vizs = [];
for (const id of ['leftStick', 'rightStick', 'leftStick2', 'rightStick2']) {
  const el = document.getElementById(id);
  if (el) vizs.push({ el, viz: new StickViz(el), side: id.startsWith('left') ? 'left' : 'right' });
}

// ---------- trigger state ----------
const state = { preset: 'firm', target: 'both', mode: 'feedback', pos: 2, str: 6, start: 3, end: 5 };
const PRESET_STATE = {
  off: { mode: 'feedback', pos: 0, str: 0 },
  light: { mode: 'feedback', pos: 3, str: 4 },
  firm: { mode: 'feedback', pos: 2, str: 6 },
  max: { mode: 'feedback', pos: 1, str: 8 },
  weapon: { mode: 'weapon', start: 3, end: 5, str: 8 },
};

function currentEff() {
  if (state.mode === 'weapon') return effWeapon(state.start, state.end, state.str);
  if (state.str <= 0) return effOff();
  return effFeedback(state.pos, state.str);
}

let applyTimer = null;
function scheduleApply() {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(applyNow, 60);
}
async function applyNow() {
  if (!ds.connected) return;
  const eff = currentEff();
  const l = (state.target === 'both' || state.target === 'left') ? eff : effOff();
  const r = (state.target === 'both' || state.target === 'right') ? eff : effOff();
  try { await applyTriggers(ds, l, r); saveProfile(); } catch (e) { console.warn('apply failed', e); }
}

function saveProfile() {
  localStorage.setItem('ds_studio_profile', JSON.stringify(state));
  localStorage.setItem('ds_studio_auto', $('#autoApply').checked ? '1' : '0');
}
function loadProfile() {
  try {
    const p = JSON.parse(localStorage.getItem('ds_studio_profile') || 'null');
    if (p) Object.assign(state, p);
  } catch {}
  $('#autoApply').checked = localStorage.getItem('ds_studio_auto') === '1';
  syncUI();
}

// ---------- UI wiring ----------
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === t.dataset.tab));
}));

document.querySelectorAll('.preset').forEach(p => p.addEventListener('click', () => {
  state.preset = p.dataset.preset;
  Object.assign(state, PRESET_STATE[p.dataset.preset]);
  syncUI(); applyNow();
}));

$('#targetSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-target]'); if (!b) return;
  state.target = b.dataset.target; syncSeg('#targetSeg', 'target'); applyNow();
});
$('#modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]'); if (!b) return;
  state.mode = b.dataset.mode; syncUI(); applyNow();
});
$('#pos').addEventListener('input', e => { state.pos = +e.target.value; $('#posVal').textContent = state.pos; clearPreset(); scheduleApply(); });
$('#str').addEventListener('input', e => { state.str = +e.target.value; $('#strVal').textContent = state.str; clearPreset(); scheduleApply(); });
$('#start').addEventListener('input', e => { state.start = +e.target.value; $('#startVal').textContent = state.start; clearPreset(); scheduleApply(); });
$('#end').addEventListener('input', e => { state.end = +e.target.value; $('#endVal').textContent = state.end; clearPreset(); scheduleApply(); });
$('#autoApply').addEventListener('change', saveProfile);

function clearPreset() { state.preset = null; document.querySelectorAll('.preset').forEach(p => p.classList.remove('active')); }

function syncSeg(sel, key) {
  document.querySelectorAll(`${sel} button`).forEach(b => b.classList.toggle('active', b.dataset[key] === state[key]));
}
function syncUI() {
  document.querySelectorAll('.preset').forEach(p => p.classList.toggle('active', p.dataset.preset === state.preset));
  syncSeg('#targetSeg', 'target'); syncSeg('#modeSeg', 'mode');
  $('#pos').value = state.pos; $('#posVal').textContent = state.pos;
  $('#str').value = state.str; $('#strVal').textContent = state.str;
  $('#start').value = state.start; $('#startVal').textContent = state.start;
  $('#end').value = state.end; $('#endVal').textContent = state.end;
  document.querySelector('[data-for="feedback"]').style.display = state.mode === 'feedback' ? '' : 'none';
  document.querySelector('[data-for="weapon"]').style.display = state.mode === 'weapon' ? '' : 'none';
}

// ---------- lightbar ----------
const SWATCHES = ['#2e6be6', '#7c5cff', '#ff5470', '#2fd57e', '#ffb13c', '#ffffff', '#00e5ff', '#ff00aa'];
const swWrap = $('#swatches');
SWATCHES.forEach(hex => {
  const d = document.createElement('div'); d.className = 'swatch'; d.style.background = hex;
  d.addEventListener('click', () => { $('#ledColor').value = hex; setLed(hex); });
  swWrap.appendChild(d);
});
$('#ledColor').addEventListener('input', e => setLed(e.target.value));
async function setLed(hex) {
  if (!ds.connected) return;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  try { await applyLightbar(ds, r, g, b); } catch (e) { console.warn(e); }
}

// ---------- connection ----------
$('#connectBtn').addEventListener('click', async () => {
  try { ds.connected ? await ds.disconnect() : await ds.connect(); }
  catch (e) { setStatus('err', e.message); }
});
ds.addEventListener('connect', async () => {
  setStatus('on', 'Connected'); $('#connectBtn').textContent = 'Disconnect';
  $('#restTestBtn').disabled = false; $('#recalibBtn').disabled = false;
  if (localStorage.getItem('ds_studio_auto') === '1') { await new Promise(r => setTimeout(r, 300)); applyNow(); }
});
ds.addEventListener('disconnect', () => {
  setStatus('idle', 'No controller'); $('#connectBtn').textContent = 'Connect controller';
  $('#modeBadge').textContent = '—'; $('#restTestBtn').disabled = true; $('#recalibBtn').disabled = true;
});
ds.addEventListener('input', e => { latest = e.detail; if (recording) recording.feed(latest); });
window.addEventListener('load', () => { loadProfile(); ds.tryReconnect().catch(() => {}); });

// ---------- render loop ----------
function loop() {
  for (const v of vizs) { v.viz.set(latest[v.side].norm); v.viz.draw(); }
  $('#l2bar').style.width = (latest.l2 / 255 * 100) + '%';
  $('#r2bar').style.width = (latest.r2 / 255 * 100) + '%';
  if (ds.mode) $('#modeBadge').textContent = ds.mode.toUpperCase();
  requestAnimationFrame(loop);
}
loop();

// ---------- quick rest test ----------
let recording = null;
$('#restTestBtn').addEventListener('click', async () => {
  if (!ds.connected) return;
  $('#restResult').textContent = 'Hold still — don’t touch the sticks…';
  recording = new Recorder('rest');
  await new Promise(r => setTimeout(r, 3000));
  const sum = recording.summary(); recording = null;
  const fmt = (s) => `offset ${s.offset.mag.toFixed(1)}/255, jitter ${s.jitter.toFixed(2)}`;
  const tag = (m) => m < 6 ? 'healthy' : m < 19 ? 'mild' : 'drifting';
  $('#restResult').innerHTML =
    `<b>Left:</b> ${fmt(sum.left)} — ${tag(sum.left.offset.mag)}<br><b>Right:</b> ${fmt(sum.right)} — ${tag(sum.right.offset.mag)}`;
});

// ---------- recalibrate center (USB only, NVS write) ----------
let calibrating = false;
$('#recalibBtn').addEventListener('click', async () => {
  if (!ds.connected || calibrating) return;
  const pf = await calibration.preflight(ds);
  if (!pf.ok) { $('#calibStatus').textContent = '⚠ ' + pf.blocking; return; }
  const warn = pf.warnings.length ? '\n\n' + pf.warnings.join('\n') : '';
  if (!confirm('Recalibrate the stick CENTER into the controller’s memory (permanent).\n\nLet go of BOTH sticks and don’t touch them during calibration. A bad result is fixable by re-running.' + warn)) return;
  calibrating = true; $('#recalibBtn').disabled = true;
  try {
    const res = await calibration.runCenterOnly(ds, {
      onStep: (title, instr, p) => { $('#calibStatus').textContent = `${title} — ${instr}`; },
    });
    $('#calibStatus').textContent = `✓ Recalibrated & saved to controller memory (NVS: ${res.status}). Run a rest test to confirm.`;
  } catch (e) {
    $('#calibStatus').textContent = '⚠ ' + e.message;
  } finally { calibrating = false; $('#recalibBtn').disabled = !ds.connected; }
});

function setStatus(kind, text) {
  $('#statusPill').className = 'pill pill-' + (kind === 'on' ? 'on' : kind === 'err' ? 'err' : 'idle');
  $('#statusText').textContent = text;
}
