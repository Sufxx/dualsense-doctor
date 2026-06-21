// app.js — UI glue: connection, live render loop, test wizard, report, fixes.
import { DualSense } from './dualsense.js';
import { Recorder, buildReport } from './diagnostics.js';
import { StickViz } from './visualizer.js';
import { calibration } from './calibration.js';

const $ = (s) => document.querySelector(s);
const ds = new DualSense();
const vizL = new StickViz($('#leftStick'));
const vizR = new StickViz($('#rightStick'));

let latest = ds.state;
let recorders = [];      // active recorders fed on each input
let lastReport = null;
let busy = false;

// ---------- connection ----------
$('#connectBtn').addEventListener('click', async () => {
  try {
    if (ds.connected) { await ds.disconnect(); return; }
    await ds.connect();
  } catch (e) { setStatus('err', e.message); console.error(e); }
});

ds.addEventListener('connect', () => {
  setStatus('on', 'Connected');
  $('#connectBtn').textContent = 'Disconnect';
  $('#app').classList.remove('disabled');
  enable(['fullDiagBtn', 'exportBtn', 'recenterBtn']);
  document.querySelectorAll('.step-btn').forEach(b => b.disabled = false);
  updateCalibAvailability();
});
ds.addEventListener('disconnect', () => {
  setStatus('idle', 'No controller');
  $('#connectBtn').textContent = 'Connect controller';
  $('#app').classList.add('disabled');
  $('#modeBadge').textContent = '—';
});
ds.addEventListener('input', (e) => {
  latest = e.detail;
  for (const r of recorders) r.feed(latest);
});

window.addEventListener('load', () => { ds.tryReconnect().catch(() => {}); });

// ---------- render loop ----------
function loop() {
  vizL.set(latest.left.norm); vizR.set(latest.right.norm);
  vizL.draw(); vizR.draw();
  writeReadout('#leftReadout', latest.left);
  writeReadout('#rightReadout', latest.right);
  $('#l2bar').style.width = (latest.l2 / 255 * 100) + '%';
  $('#r2bar').style.width = (latest.r2 / 255 * 100) + '%';
  if (ds.mode) $('#modeBadge').textContent = ds.mode.toUpperCase();
  requestAnimationFrame(loop);
}
loop();

function writeReadout(sel, s) {
  const el = $(sel);
  el.querySelector('[data-k="raw"]').textContent = `${s.raw[0]}, ${s.raw[1]}`;
  el.querySelector('[data-k="norm"]').textContent = `${s.norm[0].toFixed(2)}, ${s.norm[1].toFixed(2)}`;
  el.querySelector('[data-k="off"]').textContent = Math.hypot(s.raw[0] - 128, s.raw[1] - 128).toFixed(1);
}

// ---------- test wizard ----------
const TESTS = {
  rest: { dur: 4000, lead: 1500, label: 'Let go of both sticks. Don’t touch them.', live: 'Measuring resting position…' },
  range: { dur: 6500, lead: 1200, label: 'Slowly roll BOTH sticks around the full edge, 2–3 times.', live: 'Mapping range & circularity…' },
  snapback: { dur: 6500, lead: 1200, label: 'Flick each stick to the edge and release. Repeat ~6 times.', live: 'Watching snapback on release…' },
};

$('#fullDiagBtn').addEventListener('click', () => runSequence(['rest', 'range', 'snapback']));
document.querySelectorAll('.step-btn').forEach(b =>
  b.addEventListener('click', () => runSequence([b.dataset.test])));

async function runSequence(types) {
  if (busy || !ds.connected) return;
  busy = true; setBusy(true);
  const made = {};
  try {
    for (const type of types) {
      highlightStep(type);
      const rec = await runTest(type);
      made[type] = rec;
    }
    // merge with any prior recorders from a partial run so the report stays rich
    lastReport = buildReport({
      rest: made.rest || lastReport?._rec?.rest,
      range: made.range || lastReport?._rec?.range,
      snapback: made.snapback || lastReport?._rec?.snapback,
    });
    lastReport._rec = { ...(lastReport?._rec || {}), ...made };
    renderReport(lastReport);
    setWizard('Diagnostic complete. See the report below.', 0, '');
  } finally {
    busy = false; setBusy(false); highlightStep(null); recorders = [];
  }
}

function runTest(type) {
  return new Promise((resolve) => {
    const cfg = TESTS[type];
    const rec = new Recorder(type);
    vizL.clearTrail(); vizR.clearTrail();
    setWizard(cfg.label, 0, 'Get ready…');
    // lead-in (don't record yet)
    setTimeout(() => {
      recorders = [rec];
      $('#wizInstruction').classList.add('live');
      const start = performance.now();
      const tick = () => {
        const p = Math.min(1, (performance.now() - start) / cfg.dur);
        $('#wizBar').style.width = (p * 100) + '%';
        $('#wizInstruction').textContent = cfg.live;
        $('#wizCount').textContent = `${Math.ceil((1 - p) * cfg.dur / 1000)}s`;
        if (p < 1) requestAnimationFrame(tick);
        else {
          recorders = [];
          $('#wizInstruction').classList.remove('live');
          resolve(rec);
        }
      };
      requestAnimationFrame(tick);
    }, cfg.lead);
  });
}

function setWizard(text, progress, count) {
  $('#wizInstruction').textContent = text;
  $('#wizInstruction').classList.remove('live');
  $('#wizBar').style.width = (progress * 100) + '%';
  $('#wizCount').textContent = count;
}
function highlightStep(type) {
  document.querySelectorAll('.step-btn').forEach(b => b.classList.toggle('active', b.dataset.test === type));
}
function setBusy(b) {
  $('#fullDiagBtn').disabled = b;
  document.querySelectorAll('.step-btn').forEach(x => x.disabled = b || !ds.connected);
}

// ---------- report ----------
function renderReport(rep) {
  // gauge
  const arc = $('#gaugeArc'), C = 2 * Math.PI * 84;
  arc.style.strokeDashoffset = C * (1 - rep.score / 100);
  arc.style.stroke = colorFor(rep.verdict.tag);
  $('#scoreVal').textContent = rep.score;
  const v = $('#verdict');
  v.textContent = rep.verdict.label;
  v.className = 'verdict verdict-' + rep.verdict.tag;
  $('#verdictDetail').textContent = detailFor(rep);

  // metrics table
  const body = $('#metricsBody');
  body.innerHTML = '';
  for (const m of rep.metrics) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${m.name}</td><td>${m.left}</td><td>${m.right}</td>
      <td><span class="tag tag-${m.verdict.tag}">${m.verdict.label}</span></td>`;
    body.appendChild(tr);
  }

  // fixes
  const list = $('#fixList'); list.innerHTML = '';
  for (const f of rep.fixes) {
    const div = document.createElement('div');
    div.className = 'fix-item';
    div.innerHTML = `<span class="ico" style="color:${colorFor(f.tag)}">●</span><span>${f.text}</span>`;
    list.appendChild(div);
  }

  // deadzone ring on viz + enable fix actions
  if (rep.deadzone) {
    vizL.deadzone = rep.deadzone.left; vizR.deadzone = rep.deadzone.right;
    enable(['deadzoneBtn']);
  }
  enable(['exportBtn', 'recenterBtn']);
  updateCalibAvailability();
}

function detailFor(rep) {
  const r = rep.raw.rest;
  if (!r) return '';
  const o = Math.max(r.left.offset.mag, r.right.offset.mag);
  if (rep.score >= 90) return 'Resting dead-on center with a clean signal.';
  return `Worst-case resting offset ${o.toFixed(1)}/255. Recommended deadzone ${Math.round(Math.max(rep.deadzone.left, rep.deadzone.right) * 100)}%.`;
}

// ---------- fix actions ----------
$('#exportBtn').addEventListener('click', () => {
  if (!lastReport) return;
  const clean = { ...lastReport }; delete clean._rec;
  const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dualsense-drift-report.json`;
  a.click();
});

$('#recenterBtn').addEventListener('click', () => {
  // capture current resting position as a visual marker on each plot
  vizL.restCenter = { x: latest.left.norm[0], y: latest.left.norm[1] };
  vizR.restCenter = { x: latest.right.norm[0], y: latest.right.norm[1] };
  $('#fixNote').textContent = 'Captured current resting center (green marker). Use it as the reference when applying deadzone/anti-deadzone.';
});

$('#deadzoneBtn').addEventListener('click', async () => {
  if (!lastReport?.deadzone) return;
  const dz = lastReport.deadzone;
  const profile = [
    `DualSense deadzone profile (from DualSense Doctor)`,
    `Left stick deadzone : ${Math.round(dz.left * 100)}%`,
    `Right stick deadzone: ${Math.round(dz.right * 100)}%`,
    `Apply in: Steam → Settings → Controller → DualSense → Deadzone,`,
    `or per game. These values hide the measured rest noise + offset.`,
  ].join('\n');
  try { await navigator.clipboard.writeText(profile); $('#fixNote').textContent = 'Deadzone profile copied to clipboard.'; }
  catch { $('#fixNote').textContent = profile; }
});

// ---------- on-controller recalibration (real, USB only) ----------
$('#writeCalibBtn').addEventListener('click', async () => {
  if (!ds.connected || busy) return;
  let pf;
  try { pf = await calibration.preflight(ds); }
  catch (e) { showOverlay('Recalibration', 'Preflight failed: ' + e.message, null); return; }

  if (!pf.ok) {
    // blocked (almost always: needs USB)
    showOverlay('Plug in via USB to recalibrate', pf.blocking, null);
    return;
  }

  const warnLines = pf.warnings.length ? '\n\n⚠ ' + pf.warnings.join('\n⚠ ') : '';
  showOverlay('Recalibrate controller memory',
    'This rewrites the stick CENTER (and range) into the DualSense’s own memory, so the fix works system-wide and even back on a PS5 — not just one game. It uses the open-source dualshock-tools protocol.\n\n' +
    'Before you confirm: make sure the battery is above ~30% and DON’T unplug while it saves. A bad result is recoverable by simply running it again.' +
    warnLines + '\n\nYou’ll be guided to hold the sticks centered, then roll them around the edge.',
    async () => { await doRecalibration(); });
});

async function doRecalibration() {
  if (busy) return;
  busy = true; setBusy(true);
  $('#writeCalibBtn').disabled = true;
  try {
    const res = await calibration.run(ds, {
      onStep: (title, instruction, progress) => {
        $('#wizInstruction').textContent = `${title} — ${instruction}`;
        $('#wizInstruction').classList.toggle('live', progress !== 1);
        $('#wizBar').style.width = ((progress ?? 0.5) * 100) + '%';
        $('#wizCount').textContent = progress === 1 ? 'done' : '';
        $('#fixNote').textContent = `${title}: ${instruction}`;
      },
    });
    $('#fixNote').textContent = `✓ Recalibrated and saved to controller memory (NVS: ${res.status}). ` +
      (res.edge ? 'Note: on DualSense Edge this won’t persist after reboot without the hardware mod. ' : '') +
      'Re-run the full diagnostic to confirm the drift is gone.';
  } catch (e) {
    $('#wizInstruction').textContent = 'Recalibration stopped';
    $('#wizInstruction').classList.remove('live');
    $('#fixNote').textContent = '⚠ ' + e.message;
    console.error(e);
  } finally {
    busy = false; setBusy(false);
    $('#writeCalibBtn').disabled = !ds.connected;
  }
}

function updateCalibAvailability() {
  const btn = $('#writeCalibBtn');
  btn.disabled = !ds.connected || busy;
  btn.title = ds.mode === 'usb'
    ? 'Rewrite stick calibration to the controller’s memory (dualshock-tools protocol)'
    : 'Recalibration needs a USB data cable — click for details';
}

// ---------- overlay ----------
function showOverlay(title, body, onConfirm) {
  $('#ovTitle').textContent = title;
  $('#ovBody').textContent = body;
  $('#overlay').classList.remove('hidden');
  $('#ovConfirm').style.display = onConfirm ? '' : 'none';
  const close = () => $('#overlay').classList.add('hidden');
  $('#ovCancel').onclick = close;
  $('#ovConfirm').onclick = async () => { close(); if (onConfirm) await onConfirm(); };
}

// ---------- small utils ----------
function setStatus(kind, text) {
  const pill = $('#statusPill');
  pill.className = 'pill pill-' + (kind === 'on' ? 'on' : kind === 'err' ? 'err' : 'idle');
  $('#statusText').textContent = text;
}
function enable(ids) { ids.forEach(id => { const el = $('#' + id); if (el) el.disabled = false; }); }
function colorFor(tag) { return tag === 'good' ? '#2fd57e' : tag === 'warn' ? '#ffb13c' : tag === 'bad' ? '#ff5470' : '#8b97b3'; }
