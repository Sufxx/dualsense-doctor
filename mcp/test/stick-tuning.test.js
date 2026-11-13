import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzePhase, SessionStore } from '../guided.js';
import { assessStickTuning } from '../stick-tuning.js';

const axis=(meanRaw=128,minRaw=meanRaw,maxRaw=meanRaw,stddevRaw=0)=>({meanRaw,minRaw,maxRaw,stddevRaw});
function report() {
  const quiet={valid:true,peakRadiusPercent:3,p99RadiusPercent:2,quietAxes:{x:axis(),y:axis()}};
  const captures=['rest','range','release','buttons','verify'].map((phase,i)=>({number:i+1,phase,calibrationEpoch:0,metrics:{phase,valid:true,mode:'usb',samples:1250,durationMs:5000,maxGapMs:4,left:structuredClone(quiet),right:structuredClone(quiet)}}));
  for(const side of ['left','right']) {
    captures[1].metrics[side]={valid:true,limits:side==='left'?{lx:{min:0,max:255},ly:{min:0,max:255}}:{rx:{min:0,max:255},ry:{min:0,max:255}},circularity:{coveredSectors:48,totalSectors:48,errorPercent:3,sectorRadii:Array(48).fill(1)}};
    captures[2].metrics[side]={valid:true,postReturnPeakPercent:30};
  }
  return {id:'private-session',complete:true,controller:{path:'private-device',serialNumber:'private-serial',productId:3302},captures};
}
function sweep(negativeX=128,positiveX=127,negativeY=128,positiveY=127) {
  return Array.from({length:2400},(_,i)=>{
    const angle=i*Math.PI*4/2400,c=Math.cos(angle),s=Math.sin(angle);
    const x=128+Math.round(c*(c<0?negativeX:positiveX)),y=128+Math.round(s*(s<0?negativeY:positiveY));
    return {t:i*4,lx:x,ly:y,rx:x,ry:y,mode:'usb'};
  });
}

test('current-check tuning returns separate center and observed electrical-axis ranges',()=>{
  assert.equal(typeof assessStickTuning,'function');
  const result=assessStickTuning(report());
  assert.equal(result.available,true);assert.equal(result.scope,'current_check');
  assert.deepEqual(result.sticks.left.center,{available:true,captures:3,x:{meanMinPercent:0,meanMaxPercent:0,peakToPeakPercent:0,maxStddevPercent:0,direction:'neutral'},y:{meanMinPercent:0,meanMaxPercent:0,peakToPeakPercent:0,maxStddevPercent:0,direction:'neutral'}});
  assert.deepEqual(result.sticks.right.range,{available:true,coveredSectors:48,totalSectors:48,leftPercent:100,rightPercent:100,upPercent:100,downPercent:100,horizontalDifferencePp:0,verticalDifferencePp:0});
  assert.equal(result.sticks.left.nextStep,'review_measurements');
});

test('center retains every valid quiet capture and classifies direction using extrema',()=>{
  const r=report();
  r.captures[0].metrics.left.quietAxes.x=axis(130,129,131,1);
  r.captures[3].metrics.left.quietAxes.x=axis(131,129,133,2);
  r.captures[4].metrics.left.quietAxes.x=axis(129,129,129);
  r.captures[0].metrics.left.quietAxes.y=axis(127,126,128,1);
  let s=assessStickTuning(r).sticks.left;
  assert.deepEqual(s.center.x,{meanMinPercent:.79,meanMaxPercent:2.36,peakToPeakPercent:3.15,maxStddevPercent:1.57,direction:'positive'});
  assert.equal(s.center.y.direction,'mixed');assert.equal(s.nextStep,'check_center_repeatability');
  r.captures[4].metrics.left.quietAxes.x=axis(129,127,131,1);
  s=assessStickTuning(r).sticks.left;assert.equal(s.center.x.direction,'mixed');assert.equal(s.nextStep,'review_measurements');
  for(const c of r.captures.filter(c=>['rest','buttons','verify'].includes(c.phase)))c.metrics.left.quietAxes.y=axis(126,125,127,1);
  assert.equal(assessStickTuning(r).sticks.left.center.y.direction,'negative');
});

test('legacy or malformed quiet axes withhold the entire side center while retaining range',()=>{
  for(const corrupt of [q=>delete q.x,q=>q.x.meanRaw=NaN,q=>q.x.stddevRaw=-1,q=>q.x.stddevRaw=128,q=>q.x.minRaw=129,q=>q.y.maxRaw=256,q=>q.y=null,q=>q.x.minRaw=127.5,q=>q.x.maxRaw=128.5,q=>q.x.stddevRaw=10]) {
    const r=report();corrupt(r.captures[0].metrics.left.quietAxes);
    const s=assessStickTuning(r).sticks.left;
    assert.deepEqual(s.center,{available:false,captures:3,x:null,y:null});
    assert.equal(s.range.available,true);assert.equal(s.nextStep,'capture_axis_evidence');
    assert.equal(assessStickTuning(r).sticks.right.center.available,true);
  }
});

test('a repeat cannot erase earlier missing or unfavorable current-epoch axis evidence',()=>{
  const r=report(),old=structuredClone(r.captures[0]);
  old.number=6;delete r.captures[0].metrics.left.quietAxes;
  r.captures.push(old,{...structuredClone(r.captures[4]),number:7});
  assert.equal(assessStickTuning(r).sticks.left.center.available,false);
  r.captures[0].metrics.valid=false;
  assert.equal(assessStickTuning(r).sticks.left.center.available,true);
});

test('only current-epoch evidence contributes and latest invalid phases cannot revive older data',()=>{
  const r=report();r.calibrationActions=[{at:'private-action'}];r.captures.forEach(c=>c.calibrationEpoch=1);
  const old=structuredClone(r.captures[0]);old.calibrationEpoch=0;delete old.metrics.left.quietAxes;r.captures.unshift(old);
  assert.equal(assessStickTuning(r).sticks.left.center.available,true);
  const invalid=structuredClone(r.captures.at(-1));invalid.number=6;invalid.metrics.valid=false;r.captures.push(invalid);
  assert.equal(assessStickTuning(r).available,false);
  r.captures.pop();r.captures.at(-1).calibrationEpoch=0;
  assert.equal(assessStickTuning(r).available,false);
});

test('range normalizes asymmetric electrical halves without using radial error as a target',()=>{
  const r=report();r.captures[1].metrics=analyzePhase('range',sweep(110,127,128,112));
  const m=r.captures[1].metrics.left;m.circularity.errorPercent=null;
  const range=assessStickTuning(r).sticks.left.range;
  assert.equal(range.leftPercent,85.94);assert.equal(range.rightPercent,100);assert.equal(range.upPercent,100);assert.equal(range.downPercent,88.19);
  assert.equal(range.horizontalDifferencePp,14.06);assert.equal(range.verticalDifferencePp,11.81);
});

test('quiet summaries reject variance impossible for the reported mean and extrema',()=>{
  for(const mean of [128,130]) {
    const r=report();r.captures[0].metrics.left.quietAxes.x=axis(mean,128,130,1);
    const center=assessStickTuning(r).sticks.left.center;
    assert.equal(center.available,false);assert.equal(center.x,null);
  }
});

test('mean and deviation rounding preserve genuine quantized quiet-frame summaries',()=>{
  for(const highCount of [1,2,3,125,249,250,251,498,499]) {
    const frames=Array.from({length:500},(_,i)=>({t:i*4,lx:i<highCount?130:128,ly:i<highCount?126:128,rx:128,ry:128,buttons:i%2,mode:'usb'}));
    const r=report();
    for(const capture of r.captures.filter(c=>['rest','buttons','verify'].includes(c.phase)))capture.metrics=analyzePhase(capture.phase,frames);
    assert.equal(assessStickTuning(r).sticks.left.center.available,true,`genuine quiet distribution with ${highCount} high samples`);
  }
});

test('full angular bins cannot invent range beyond the corresponding raw-axis extrema',()=>{
  for(const limits of [
    {lx:{min:128,max:128},ly:{min:128,max:128}},
    {lx:{min:64,max:255},ly:{min:0,max:255}},
    {lx:{min:0,max:192},ly:{min:0,max:255}},
    {lx:{min:0,max:255},ly:{min:64,max:255}},
    {lx:{min:0,max:255},ly:{min:0,max:192}},
  ]) {
    const r=report();r.captures[1].metrics.left.limits=limits;
    const range=assessStickTuning(r).sticks.left.range;
    assert.equal(range.available,false);assert.equal(range.coveredSectors,48);assert.equal(range.leftPercent,null);
  }
});

test('normal, elliptic and asymmetric quantized frame sweeps retain measured full-range evidence',()=>{
  for(const radii of [[128,127,128,127],[100,100,120,120],[110,127,128,112],[100,110,120,105]]) {
    const r=report();r.captures[1].metrics=analyzePhase('range',sweep(...radii));
    assert.equal(r.captures[1].metrics.valid,true);
    for(const side of ['left','right'])assert.equal(assessStickTuning(r).sticks[side].range.available,true,`quantized sweep ${radii}`);
  }
});

test('partial or contradictory bins withhold axis numbers and retain validated coverage',()=>{
  for(const corrupt of [c=>c.sectorRadii[0]=.2,c=>c.coveredSectors=47,c=>c.totalSectors=16,c=>c.sectorRadii[0]=NaN,c=>c.sectorRadii[0]=1.51,c=>delete c.sectorRadii,c=>c.sectorRadii.push(1)]) {
    const r=report();corrupt(r.captures[1].metrics.left.circularity);
    const s=assessStickTuning(r).sticks.left;
    assert.equal(s.range.available,false);assert.equal(s.range.leftPercent,null);assert.equal(s.range.horizontalDifferencePp,null);assert.equal(s.nextStep,'repeat_full_range');
    assert.equal(s.center.available,true);
  }
  const r=report();r.captures[1].metrics.left.circularity.sectorRadii[0]=.2;
  assert.equal(assessStickTuning(r).sticks.left.range.coveredSectors,47);
});

test('latest range only is used and malformed axis limits cannot become measurements',()=>{
  for(const corrupt of [m=>m.limits.lx.min=129,m=>m.limits.ly.max=127,m=>m.limits.lx.max=255.5,m=>m.limits.lx.min=-1,m=>delete m.limits.ly]) {
    const r=report();corrupt(r.captures[1].metrics.left);
    assert.equal(assessStickTuning(r).sticks.left.range.available,false);
  }
  const r=report(),range=structuredClone(r.captures[1]);range.number=6;range.metrics.left.circularity.sectorRadii[0]=0;
  r.captures.push(range,{...structuredClone(r.captures[4]),number:7});
  assert.equal(assessStickTuning(r).sticks.left.range.available,false);
});

test('comparison quality, identity, transport, contamination and completion gates fail closed',()=>{
  for(const corrupt of [r=>r.complete=false,r=>delete r.controller,r=>delete r.id,r=>r.captures[4].metrics.mode='bt',r=>r.captures[0].metrics.maxGapMs=251,r=>r.captures[0].metrics.left.valid=false,r=>r.captures[3].metrics.contaminated=true,r=>r.captures[3].metrics.right.peakRadiusPercent=13,r=>r.captures[1].metrics.valid=false]) {
    const r=report();corrupt(r);const result=assessStickTuning(r);
    assert.equal(result.available,false);
    for(const s of Object.values(result.sticks)){assert.equal(s.nextStep,'repeat_check');assert.deepEqual(s.center,{available:false,captures:0,x:null,y:null});assert.equal(s.range.available,false);}
  }
});

test('malformed and bounded inputs return fixed private-safe unavailable evidence without mutation',()=>{
  const circular=report();circular.calibrationActions=[{at:'private-action'}];circular.calibrationActions[0].self=circular;
  for(const r of [null,undefined,{},[],{...report(),captures:Array(2049).fill(null)},{...report(),calibrationActions:Array(129).fill({at:'private-action'})},circular]) {
    const result=assessStickTuning(r);assert.equal(result.available,false);assert.doesNotMatch(JSON.stringify(result),/private-/);
  }
  const r=report(),before=structuredClone(r);const result=assessStickTuning(r);
  assert.deepEqual(r,before);assert.doesNotMatch(JSON.stringify(result),/private-/);
  assert.match(result.note,/observed axis extrema/i);assert.match(result.note,/not applied/i);
});

test('quiet phases retain per-axis mean, extrema and population deviation without changing validity',()=>{
  const frames=Array.from({length:250},(_,i)=>({t:i*20,lx:i%2?130:128,ly:127,rx:128,ry:128,buttons:i%2,mode:'usb'}));
  for(const phase of ['rest','buttons','verify']) {
    const m=analyzePhase(phase,frames);
    assert.equal(m.valid,true);
    assert.deepEqual(m.left.quietAxes,{x:{meanRaw:129,minRaw:128,maxRaw:130,stddevRaw:1},y:{meanRaw:127,minRaw:127,maxRaw:127,stddevRaw:0}});
    assert.deepEqual(m.right.quietAxes.x,{meanRaw:128,minRaw:128,maxRaw:128,stddevRaw:0});
  }
  assert.equal(analyzePhase('rest',[]).left,undefined);
});

test('saved session reports include tuning without mutating stored evidence or recursive assessment',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ds-tuning-'));
  try {
    const store=new SessionStore(dir),session=store.start(report().controller),saved={...report(),id:session.id};
    store.save(saved);
    const result=store.report(session.id);
    assert.deepEqual(result.tuning,assessStickTuning(result));
    assert.equal(result.tuning.available,true);
    assert.deepEqual(store.get(session.id),saved);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
