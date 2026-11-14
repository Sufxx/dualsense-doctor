#!/usr/bin/env node
// server.js — DualSense Doctor MCP server (stdio). Lets a Claude Code session read &
// control a PS5 DualSense over HID. Local-only: no network, stdio transport.
//
// SAFETY: the brick-risk NVS recalibration tool is NOT registered unless the human sets
// DUALSENSE_MCP_ALLOW_CALIBRATION=1, and even then it requires an explicit confirm token,
// is USB-only, and waits for the sticks to be at rest. Every other tool is read-only or
// reversible (trigger/lightbar effects reset on power-cycle). All inputs are validated/clamped.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { withController } from './hid/controller-session.js';
import { SessionStore, PHASES, DEFAULT_SECONDS, resolveSessionController } from './guided.js';
import { runGuided } from './coach-runner.js';
import { coachingNotifications } from './coaching-notifications.js';
import { compareSessionReports } from './session-comparison.js';
import {
  listControllers, Controller, diagnoseFromFrames,
  TRIGGER_PRESETS, effFeedback, effWeapon, effOff,
} from './hid/dualsense.js';

const ALLOW_CALIB = process.env.DUALSENSE_MCP_ALLOW_CALIBRATION === '1';

const GUIDE = "Use responsive, read-only DualSense coaching after the user begins one session. run_guided_session monitors speed, direction, rim contact, settling and button contamination, then advances only when movement criteria pass. Relay MCP progress and logging notifications; their delivery latency depends on the client, so do not promise an instant live display. Targeted capture_phase remains available for repeat measurements. Circularity, resting drift and game deadzones are different metrics. Preserve balanced range rather than chasing a zero circularity score; the referenced DualShock Tools guidance is 7–9%, with symmetry taking priority. These are measurements and unapplied setting candidates, not controller calibration. Existing opt-in firmware calibration is separate and is not qualified by the coaching tests. Return concise logs and distinguish observations from actual changes.";
const server = new McpServer({ name: 'dualsense-doctor', version: '1.1.0' }, { instructions: GUIDE, capabilities: { logging: {} } });
const sessions = new SessionStore();

// open a fresh handle per call (node-hid handles are blocking) and always close it.
const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const PATH = { path: z.string().optional().describe('Specific controller path from list_controllers; omit to use the first found') };

let controllerBusy=false;
server.registerTool('run_guided_session',{
  description:'Read input continuously and coach movement criteria. Emits logging/progress notifications; client delivery latency varies. No controller calibration writes.',
  inputSchema:{...PATH,start:z.literal(true).describe('The user is beginning this measurement sequence now')},
},async({path},extra)=>{
  if(controllerBusy)throw Error('Another guided run already owns the controller.');
  controllerBusy=true;
  try {
    return await withController(path,async c=>ok(await runGuided(c,sessions,{signal:extra.signal,onEvent:coachingNotifications(server,extra)})));
  } finally {controllerBusy=false;}
});

server.registerPrompt('calibrate_sticks_best', { description: 'Guided stick measurement, concise logs, and iterative tuning with readiness between phases.' }, async () => ({messages:[{role:'user',content:{type:'text',text:GUIDE}}]}));
server.registerTool('start_session', {
  description: 'Start a logged guided stick tuning session. Returns the first instruction. Wait for user readiness before capture_phase. Does not change calibration.',
  inputSchema: {...PATH,goal:z.string().max(300).optional()},
},async({path,goal})=>withController(path,c=>ok(sessions.start(c.info,goal))));
server.registerTool('list_sessions', {description:'List saved sessions to resume after a restart.',inputSchema:{}},async()=>ok({sessions:sessions.list()}));
server.registerTool('session_report', {description:'Read session history, concise log location, quality, rest comparison and unapplied tuning candidates.',inputSchema:{session_id:z.string().uuid()}},async({session_id})=>ok(sessions.report(session_id)));
server.registerTool('compare_sessions', {description:'Compare up to ten saved measurement rounds for the same controller, transport and calibration history. Reports a conservative observed-peak deadzone starting point and circularity consistency. No settings applied or zero-drift guarantee.',inputSchema:{session_ids:z.array(z.string().uuid()).min(1).max(10)}},async({session_ids})=>ok(compareSessionReports([...new Set(session_ids)].map(id=>sessions.report(id)))));
server.registerTool('capture_phase', {
  description: 'Capture ONE instructed phase only after the user says ready. Read-only HID input; persists raw samples and concise log. Returns quality and the next instruction. Never capture movement while user reads instructions.',
  inputSchema:{session_id:z.string().uuid(),phase:z.enum(Object.keys(PHASES)),ready:z.literal(true).describe('Set only after user confirmed readiness'),seconds:z.number().min(3).max(15).optional(),note:z.string().max(500).default('')},
},async({session_id,phase,seconds,note})=>{
  const s=sessions.get(session_id);
  return withController(resolveSessionController(s.controller).path,c=>{
    const expectedMs=Math.round((seconds??DEFAULT_SECONDS[phase])*1000);
    const sample=c.sampleSticks(expectedMs);
    return ok(sessions.record(session_id,phase,sample.frames,c.info,note,expectedMs));
  });
});

// ---------------- read-only / safe tools ----------------
server.registerTool('list_controllers',
  { title: 'List controllers', description: 'List connected DualSense controllers (path, transport, model).', inputSchema: {} },
  async () => ok({ controllers: listControllers() }));

server.registerTool('get_status',
  { title: 'Get controller status', description: 'Connection mode, live stick positions, battery, and firmware for a DualSense.', inputSchema: { ...PATH } },
  async ({ path }) => withController(path, (c) => {
    const sticks = c.readSticksOnce(800);
    if (!sticks) return ok({ connected: true, mode: c.mode, note: 'No input reports — on macOS grant Input Monitoring or press the PS button; Bluetooth is not reachable on macOS (use USB).' });
    return ok({ connected: true, mode: sticks.mode, sticks, battery: c.getBattery(600), firmware: c.readFirmware(), isEdge: c.isEdge });
  }));

server.registerTool('diagnose_drift',
  { title: 'Diagnose stick drift', description: 'Sample the sticks at rest and report per-stick center offset, jitter, score (0-100), verdict, and recommended deadzone. Ask the user to NOT touch the sticks during the sample.', inputSchema: { seconds: z.number().min(0.5).max(10).default(3).describe('rest-sample duration (s)'), ...PATH } },
  async ({ seconds, path }) => withController(path, (c) => {
    const s = c.sampleSticks(Math.round((seconds ?? 3) * 1000));
    if (!s.n) return ok({ error: 'No input received. On macOS grant Input Monitoring / use USB; press the PS button.' });
    return ok(diagnoseFromFrames(s.frames, { mode: s.mode, seconds }));
  }));

server.registerTool('read_sticks',
  { title: 'Read sticks once', description: 'One immediate stick reading (raw 0-255 and normalized -1..1) plus trigger pressures.', inputSchema: { ...PATH } },
  async ({ path }) => withController(path, (c) => ok(c.readSticksOnce(800) || { error: 'no input report' })));

server.registerTool('get_battery',
  { title: 'Get battery', description: 'Battery level (0-100%) and charging status.', inputSchema: { ...PATH } },
  async ({ path }) => withController(path, (c) => ok(c.getBattery(800) || { error: 'no input report' })));

// ---------------- reversible (ephemeral) control tools ----------------
server.registerTool('set_trigger_effect',
  {
    title: 'Set adaptive trigger effect',
    description: 'Set the L2/R2 adaptive-trigger resistance. Ephemeral (resets on power-cycle; a PS5 game overrides it). Use a preset, or mode=feedback (a resistance wall from `position`) / mode=weapon (resist then click between start..end).',
    inputSchema: {
      preset: z.enum(['off', 'light', 'firm', 'max', 'weapon']).optional().describe('quick preset; overrides mode/params'),
      mode: z.enum(['feedback', 'weapon']).optional(),
      target: z.enum(['both', 'left', 'right']).default('both'),
      position: z.number().int().min(0).max(9).optional().describe('feedback wall start (0=early/short pull, 9=deep)'),
      strength: z.number().int().min(1).max(8).optional(),
      start: z.number().int().min(2).max(7).optional().describe('weapon click start'),
      end: z.number().int().min(3).max(8).optional().describe('weapon click end'),
      ...PATH,
    },
  },
  async ({ preset, mode, target = 'both', position, strength, start, end, path }) => withController(path, (c) => {
    let eff;
    if (preset) eff = TRIGGER_PRESETS[preset]();
    else if (mode === 'weapon') eff = effWeapon(start ?? 3, end ?? 5, strength ?? 8);
    else eff = effFeedback(position ?? 2, strength ?? 6);
    const l = (target === 'both' || target === 'left') ? eff : effOff();
    const r = (target === 'both' || target === 'right') ? eff : effOff();
    c.applyTriggers(l, r);
    return ok({ applied: true, preset: preset || mode || 'feedback', target, mode: c.mode, note: 'Ephemeral — resets on power-cycle; PS5 games override it.' });
  }));

server.registerTool('set_lightbar',
  { title: 'Set lightbar color', description: 'Set the DualSense light bar RGB color (0-255 each). Ephemeral.', inputSchema: { r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255), ...PATH } },
  async ({ r, g, b, path }) => withController(path, (c) => { c.applyLightbar(r, g, b); return ok({ applied: true, color: { r, g, b } }); }));

// ---------------- GATED dangerous tool (NVS write — brick risk) ----------------
if (ALLOW_CALIB) {
  server.registerTool('recalibrate_center',
    {
      title: 'Recalibrate stick center (writes to controller memory)',
      description: 'DANGER: rewrites stick center into the controller NVS flash (permanent, USB-only). Brick risk. Requires confirm="RECALIBRATE". Tell the user to let go of both sticks first; it waits for rest and refuses if touched.',
      inputSchema: { confirm: z.literal('RECALIBRATE').describe('must be exactly "RECALIBRATE"'), ...PATH },
    },
    async ({ confirm, path }) => {
      if (confirm !== 'RECALIBRATE') return ok({ error: 'confirm must equal "RECALIBRATE"' });
      const steps = [];
      try {
        const res = await withController(path, (c) => c.recalibrate({ centerOnly: true, onStep: (m) => steps.push(m) }));
        return ok({ ...res, steps });
      } catch (e) { return ok({ error: e.message, steps }); }
    });
}

// ---------------- resource: live status ----------------
server.registerResource('status', 'dualsense://status',
  { title: 'DualSense status', description: 'Live status of the first connected DualSense.', mimeType: 'application/json' },
  async (uri) => {
    let body;
    try { body = await withController(null, (c) => ({ sticks: c.readSticksOnce(800), mode: c.mode, battery: c.getBattery(600), firmware: c.readFirmware() })); }
    catch (e) { body = { error: e.message }; }
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(body, null, 2) }] };
  });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`dualsense-doctor MCP ready. Calibration tool ${ALLOW_CALIB ? 'ENABLED' : 'disabled (set DUALSENSE_MCP_ALLOW_CALIBRATION=1 to enable)'}.`);
