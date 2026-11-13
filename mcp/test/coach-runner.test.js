import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuided, RUN_STEPS } from '../coach-runner.js';
test('runner streams prompts and readings, merges both range directions, and never writes HID',async()=>{
  const records=[],events=[];let tick=0;
  const c={info:{path:'fixture'},_readOnce(){return {s:{lx:128,ly:128,rx:128,ry:128,mode:'usb',buttons:0}};}};
  const store={start(){return {id:'fixture'};},record(id,phase,frames){records.push({phase,frames});return {metrics:{valid:true}};},dir(){return 'unused';},report(){return {complete:true};}};
  const coach={start(){},feed(frame){return {complete:true,message:'done',warning:null,progress:1,latest:frame,details:{}};}};
  const r=await runGuided(c,store,{onEvent:e=>events.push(e),coach,clock:()=>++tick,prepareMs:0});
  assert.equal(r.complete,true);assert.deepEqual(records.map(r=>r.phase),['rest','range','release','buttons','verify']);
  assert.equal(records.find(r=>r.phase==='range').frames.length,2);
  assert.equal(events.filter(e=>e.type==='instruction').length,RUN_STEPS.length);
});
test('runner honors cancellation before reading any input',async()=>{
  const signal=AbortSignal.abort();let read=false;
  const c={info:{},_readOnce(){read=true;}};const store={start(){return {id:'fixture'};}};
  await assert.rejects(runGuided(c,store,{signal,prepareMs:0}),/cancel/i);assert.equal(read,false);
});
test('runner sends fresh cue state every100ms while keeping correction logs bounded',async()=>{
  let now=0;const events=[];
  const c={info:{},_readOnce(){now+=20;return {s:{lx:128,ly:128,rx:128,ry:128}};}};
  const store={start(){return {id:'fixture'};},record(){return {metrics:{valid:true}};},report(){return {complete:true};}};
  const coach={start(){},feed(){const warning=now>=60&&now<160?'Slow down.':null;return {complete:now>=400,warning,message:warning||'Good pace.',progress:now/400,details:{left:{cueCode:warning?'too_fast':'keep_going'}}};}};
  await runGuided(c,store,{steps:[{phase:'range',direction:'counterclockwise',label:'turn'}],prepareMs:0,clock:()=>now,coach,onEvent:e=>events.push({...e,observedAt:now})});
  const progress=events.filter(e=>e.type==='progress');
  assert.equal(progress.length,4);
  assert.equal(progress[0].observedAt,100);assert.equal(progress[0].warning,'Slow down.');
  assert.equal(progress[1].observedAt,200);assert.equal(progress[1].warning,null);
  assert.ok(events.filter(e=>e.type==='correction').length<=1);
});
test('settling records only the final continuous stable interval',async()=>{
  let now=0;const recorded=[];let count=0;
  const c={info:{},_readOnce(){return {s:{lx:++count<30?200:128,ly:128,rx:128,ry:128}};}};
  const store={start(){return {id:'fixture'};},record(id,phase,frames){recorded.push(frames);return {metrics:{valid:true}};},report(){return {complete:true};}};
  const coach={start(){},feed(){return {complete:now>7000,details:{stableMs:5000},progress:.5,message:'settling'};}};
  await runGuided(c,store,{steps:[{phase:'rest',label:'rest'}],prepareMs:0,clock:()=>now+=50,coach});
  assert.ok(recorded[0].every(f=>f.lx===128));assert.equal(recorded[0][0].t,0);
});
