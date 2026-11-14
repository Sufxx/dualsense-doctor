// Read-only protocol handshake. No HID discovery, controller access or service launch.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const sessionRoot=mkdtempSync(join(tmpdir(),'dualsense-handshake-'));
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.js',import.meta.url))],env:{...process.env,DUALSENSE_MCP_ALLOW_CALIBRATION:'0',DUALSENSE_SESSION_DIR:sessionRoot}});
const client=new Client({name:'readonly-handshake',version:'1.0.0'});
try {
  await client.connect(transport);
  const tools=await client.listTools();
  for(const name of ["start_session", "capture_phase", "session_report", "compare_sessions", "list_sessions", "run_guided_session"])assert.ok(tools.tools.some(t=>t.name===name),name);
  assert.ok(!tools.tools.some(t=>t.name==='recalibrate_center'));
  assert.ok(!tools.tools.some(t=>t.name==='temporary_center'));
  const resources=await client.listResources();assert.ok(resources.resources.some(r=>r.uri==='dualsense://status'));
  const prompt=await client.getPrompt({name:'calibrate_sticks_best'});assert.ok(prompt.messages.length);
  const sessions=await client.callTool({name:'list_sessions',arguments:{}});assert.ok(!sessions.isError);
  assert.deepEqual(JSON.parse(sessions.content[0].text).sessions,[]);
  console.log(JSON.stringify({passed:true,toolCount:tools.tools.length,hardwareAccess:'none',permanentCalibrationEnabled:false}));
} finally {await client.close();rmSync(sessionRoot,{recursive:true});}
