import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../guided.js';
import { runGuided } from '../coach-runner.js';

test('actual coach and recorder complete a synthetic six-stage session with valid stored evidence',async()=>{
  const root=mkdtempSync(join(tmpdir(),'controller-e2e-'));let now=0,phase='rest',direction='clockwise',phaseAt=0,angle=0;
  const events=[];
  const c={info:{path:'synthetic',productId:0x0ce6},_readOnce(){
    now+=4;const f={lx:128,ly:128,rx:128,ry:128,l2:0,r2:0,buttons:0,mode:'usb'};
    const elapsed=now-phaseAt;
    if(phase==='range') {angle+=(direction==='clockwise'?1:-1)*1.5*.004;f.lx=f.rx=128+Math.round(126*Math.cos(angle));f.ly=f.ry=128+Math.round(126*Math.sin(angle));}
    else if(phase==='release') {const cycle=Math.floor(elapsed/1200)%4;if(elapsed%1200<200){if(cycle===0)f.lx=f.rx=255;if(cycle===1)f.ly=f.ry=255;if(cycle===2)f.lx=f.rx=0;if(cycle===3)f.ly=f.ry=0;}}
    else if(phase==='buttons')f.buttons=Math.floor(elapsed/160)%2;
    return {s:f};
  }};
  try {
    const store=new SessionStore(root);
    const result=await runGuided(c,store,{clock:()=>now,prepareMs:0,onEvent:e=>{
      events.push(e);if(e.type==='instruction'){phase=e.phase;direction=e.direction;phaseAt=now;}
    }});
    assert.equal(result.complete,true);assert.equal(result.report.captures.length,5);
    assert.ok(result.report.captures.every(c=>c.metrics.valid));
    assert.equal(events.filter(e=>e.type==='phase_complete').length,6);
    assert.ok(events.some(e=>e.type==='progress'&&e.latest));
    assert.equal(result.report.recommendation.applied,false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
