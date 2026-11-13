import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, parseSticks } from '../hid/dualsense.js';
import { analyzePhase, SessionStore, withController, resolveSessionController, circularityFromFrames } from '../guided.js';

const frames = (n=250, values={}) => Array.from({length:n}, (_,i)=>({t:i*20,lx:128,ly:128,rx:128,ry:128,buttons:0,...values}));
test('default constructor can discover a controller',()=>assert.deepEqual(new Controller().info, {}));
test('async work retains handle until completion and closes on error',async()=>{
  let closed=false;
  const factory=()=>({open(){},close(){closed=true;}});
  await assert.rejects(withController(null,async()=>{await Promise.resolve();assert.equal(closed,false);throw Error('test');},factory),/test/);
  assert.equal(closed,true);
});
test('USB and full BT button bytes map identically; compat buttons do not become triggers',()=>{
  const usb=Array(64).fill(0);usb[0]=1;usb[8]=0x28;usb[9]=1;usb[10]=2;
  const bt=Array(78).fill(0);bt[0]=0x31;bt[9]=0x28;bt[10]=1;bt[11]=2;
  assert.equal(parseSticks(usb).buttons,parseSticks(bt).buttons);
  const short=[1,128,128,128,128,0x28,1,2,0,0];
  assert.equal(parseSticks(short).l2,0);
  const padded=Array(78).fill(0);padded.splice(0,10,...short);padded[8]=100;padded[9]=200;
  assert.equal(parseSticks(padded).mode,'bt-compat');assert.equal(parseSticks(padded).l2,100);assert.equal(parseSticks(padded).r2,200);
  assert.equal(parseSticks([1,128,128,128,128]),null);
});
test('empty and touched rest never produce a deadzone recommendation',()=>{
  assert.equal(analyzePhase('rest',[]).valid,false);
  const result=analyzePhase('rest',frames(250,{lx:200}));
  assert.equal(result.valid,false); assert.equal(result.left.deadzonePercent,null);
});
test('quiet centered data recommends a small measured radial deadzone',()=>{
  const result=analyzePhase('rest',frames());
  assert.equal(result.valid,true);assert.ok(result.left.deadzonePercent<5);
  assert.equal(result.left.offsetRaw,0);
});
test('partial sweep fails coverage even when endpoints are reached',()=>{
  const f=frames().map((v,i)=>({...v,lx:i%2?255:0,rx:i%2?255:0}));
  assert.equal(analyzePhase('range',f).valid,false);
});
test('complete circles pass coverage and report observed radius',()=>{
  const f=frames().map((v,i)=>{const a=i/250*Math.PI*4;return {...v,lx:128+Math.round(120*Math.cos(a)),ly:128+Math.round(120*Math.sin(a)),rx:128+Math.round(120*Math.cos(a)),ry:128+Math.round(120*Math.sin(a))};});
  const result=analyzePhase('range',f);assert.equal(result.valid,true);assert.equal(result.left.sectors,16);
});
test('GUI-compatible circularity uses 48 angular maxima and declines partial coverage',()=>{
  const f=Array.from({length:480},(_,i)=>{const a=i*Math.PI*2/480;return {lx:Math.round(127.5+127*Math.cos(a)),ly:Math.round(127.5+127*Math.sin(a))};});
  const r=circularityFromFrames(f,'lx','ly');assert.equal(r.coveredSectors,48);assert.ok(r.errorPercent<1);
  assert.equal(circularityFromFrames(f.slice(0,30),'lx','ly').errorPercent,null);
});
test('button spam counts presses, not held frames',()=>{
  assert.equal(analyzePhase('buttons',frames(250,{buttons:1})).presses,0);
  const f=frames().map((v,i)=>({...v,buttons:i%2}));
  assert.equal(analyzePhase('buttons',f).presses,125);
});
test('button phase reports observed trigger endpoints',()=>{
  const f=frames().map((v,i)=>({...v,buttons:i%2,l2:i%2?255:0,r2:i%2?200:5}));
  const r=analyzePhase('buttons',f);assert.deepEqual(r.triggers,{l2:{min:0,max:255},r2:{min:5,max:200}});
});
test('button captures reject held or transient stick contamination',()=>{
  const clean=frames(400).map((f,i)=>({...f,buttons:i%2,mode:'usb'}));
  assert.equal(analyzePhase('buttons',clean,8000).valid,true);
  for(const samples of [clean.map(f=>({...f,lx:255,rx:255})),clean.map((f,i)=>i===200?{...f,ry:160}:f)]) {
    const result=analyzePhase('buttons',samples,8000);
    assert.equal(result.valid,false);assert.equal(result.contaminated,true);
    assert.ok(result.warnings.some(w=>/stick movement/i.test(w)));
  }
});
test('resume finds the same serial after USB path changes',()=>{
  const saved={path:'old',serialNumber:'same',productId:3302};
  assert.equal(resolveSessionController(saved,[{...saved,path:'new'}]).path,'new');
  assert.throws(()=>resolveSessionController(saved,[{...saved,serialNumber:'other'}]),/not connected/);
});
test('flick evidence needs actual releases',()=>assert.equal(analyzePhase('release',frames()).valid,false));
test('stored release metrics do not count strong spring-back as another physical flick',()=>{
  const samples=[];let t=0;
  const push=(values,ms)=>{for(let i=0;i<ms/4;i++)samples.push({t:t+=4,lx:128,ly:128,rx:128,ry:128,...values});};
  const directions=[{lx:255,rx:255},{ly:255,ry:255},{lx:0,rx:0},{ly:0,ry:0}];
  for(const d of directions){push({},600);push(d,200);push({},4);push(Object.fromEntries(Object.keys(d).map(k=>[k,d[k]>128?20:236])),8);push({},600);}
  const r=analyzePhase('release',samples);
  assert.equal(r.left.releases,4);assert.equal(r.right.releases,4);assert.equal(r.valid,true);
});
test('a stored recording counts physical releases after the first four directions',()=>{
  const samples=[];let t=0;
  const push=(values,ms)=>{for(let i=0;i<ms/4;i++)samples.push({t:t+=4,lx:128,ly:128,rx:128,ry:128,...values});};
  for(let n=0;n<8;n++){const d=[{lx:255,rx:255},{ly:255,ry:255},{lx:0,rx:0},{ly:0,ry:0}][n%4];push({},600);push(d,100);push({},600);}
  const r=analyzePhase('release',samples);assert.equal(r.left.releases,8);assert.equal(r.right.releases,8);
});
test('trailing report loss invalidates a requested five-second capture',()=>assert.equal(analyzePhase('rest',frames(60),5000).valid,false));
test('release overshoot is retained rather than silently dropped',()=>{
  const f=frames(350).map((v,i)=>({...v,lx:i%60<10?250:128,rx:i%60<10?250:128}));
  f[72].lx=200;f[72].rx=200;
  const r=analyzePhase('release',f);
  assert.ok(r.left.unsettledReleases>=1);assert.ok(r.left.postReturnPeakPercent>50);
});
test('a new measurement invalidates old final verification',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ds-guided-'));
  try{
    const store=new SessionStore(dir),c={path:'one',productId:3302},s=store.start(c);
    const saved=store.get(s.id);
    saved.captures=['rest','range','release','buttons','verify'].map((phase,i)=>({phase,number:i+1,metrics:{...analyzePhase('rest',frames()),valid:true,mode:'usb'}}));
    store.save(saved);assert.equal(store.report(s.id).complete,true);
    saved.captures.push({phase:'range',number:6,metrics:{valid:true,mode:'usb'}});
    store.save(saved);assert.equal(store.report(s.id).complete,false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('output reports have standard lengths and Bluetooth common block offset',()=>{
  for(const mode of ['usb','bt']) {
    let packet;const c=new Controller({path:'fixture'});
    c.dev={write(p){packet=p;}};c._mode=mode;c.applyLightbar(10,20,30);
    assert.equal(packet.length,mode==='usb'?63:78);
    if(mode==='bt'){assert.equal(packet[2],0x10);assert.deepEqual(packet.slice(47,50),[10,20,30]);}
  }
});
test('first lightbar update performs Sony LED setup before writing RGB',()=>{
  const packets=[];const c=new Controller({path:'fixture'});c.dev={write(p){packets.push(p);}};c._mode='usb';
  c.applyLightbar(10,20,30);assert.equal(packets.length,2);
  assert.equal(packets[0][1+38],2);assert.equal(packets[0][1+41],2);
  assert.equal(packets[1][1+39],0);assert.deepEqual(packets[1].slice(1+44,1+47),[10,20,30]);
});
test('sessions survive restart, reject traversal and controller swaps, retain repeated rounds',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ds-guided-'));
  try {
    let store=new SessionStore(dir);const s=store.start({path:'one',productId:3302});
    assert.throws(()=>store.get('../bad'),/session/);
    assert.throws(()=>store.record(s.id,'rest',frames(),{path:'two',productId:3302}),/controller/i);
    store.record(s.id,'rest',frames(),{path:'one',productId:3302});
    store=new SessionStore(dir);store.record(s.id,'rest',frames(),{path:'one',productId:3302},'changed game deadzone');
    const result=store.report(s.id);assert.equal(result.captures.length,2);assert.equal(result.comparison.leftOffsetDeltaRaw,0);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
