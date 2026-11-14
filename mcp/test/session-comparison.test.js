import test from 'node:test';
import assert from 'node:assert/strict';
import {compareSessionReports} from '../session-comparison.js';
import {circularityFromFrames} from '../guided.js';

function report(index=0,peak=3,options={}) {
  const mode=options.mode||'usb',epoch=options.actions?.length||0;
  const side={valid:true,peakRadiusPercent:peak,p99RadiusPercent:Math.max(0,peak-.5)};
  const captures=['rest','range','release','buttons','verify'].map((phase,i)=>({
    number:i+1,phase,calibrationEpoch:epoch,
    metrics:{phase,valid:true,mode,samples:1251,durationMs:5000,maxGapMs:4,
      left:structuredClone(side),right:structuredClone(side),
      ...(phase==='buttons'?{contaminated:false}:{}),
    },
  }));
  for(const s of ['left','right']) {
    captures[1].metrics[s]={valid:true,circularity:{coveredSectors:48,totalSectors:48,errorPercent:7+index/10,maxOppositeDifferencePercent:2+index/10}};
    captures[2].metrics[s]={valid:true,postReturnPeakPercent:65,directions:[0,1,2,3]};
  }
  return {id:`synthetic-round-${index}`,complete:true,controller:{productId:3302,path:'synthetic-controller'},captures,...(options.actions?{calibrationActions:options.actions}:{}),...options.overrides};
}

test('five complete rounds use the worst clean peak, not the best or release overshoot',()=>{
  const result=compareSessionReports([2.1,3.2,4.1,2.8,3.5].map((p,i)=>report(i,p)));
  assert.equal(result.comparable,true);assert.equal(result.acceptedRounds,5);assert.equal(result.excludedRounds,0);
  assert.equal(result.left.suggestedDeadzonePercent,6);
  assert.equal(result.left.observedPeakPercent,4.1);assert.equal(result.left.worstP99Percent,3.6);
  assert.equal(result.left.roundSpreadPercent,2);assert.equal(result.left.releasePostReturnPeakPercent,65);
  assert.deepEqual(result.left.circularity,{min:7,max:7.4,latest:7.4,rounds:5,maxOppositeDifferencePercent:2.4});
  assert.equal(result.applied,false);assert.match(result.note,/not a guarantee/i);
});

test('invalid or incomplete rounds cannot lower or inflate the complete-round candidate',()=>{
  const incomplete=report(1,.1,{overrides:{complete:false}});
  const invalid=report(2,50);invalid.captures.at(-1).metrics.valid=false;
  const result=compareSessionReports([report(0,3),incomplete,invalid]);
  assert.equal(result.acceptedRounds,1);assert.equal(result.excludedRounds,2);assert.equal(result.left.suggestedDeadzonePercent,4);
});

test('button peaks are included but contaminated button rounds are rejected',()=>{
  const clean=report(0,2);clean.captures[3].metrics.left.peakRadiusPercent=6.2;
  const contaminated=report(1,3);contaminated.captures[3].metrics.contaminated=true;
  const result=compareSessionReports([clean,contaminated]);
  assert.equal(result.left.suggestedDeadzonePercent,8);assert.equal(result.excludedRounds,1);
});

test('mixed controller identity or transport fails closed without leaking identifiers',()=>{
  for(const change of [r=>r.controller.path='another-private-path',r=>r.controller.productId=3570,r=>r.captures.forEach(c=>c.metrics.mode='bt')]) {
    const other=report(1);change(other);
    const result=compareSessionReports([report(),other]);
    assert.equal(result.comparable,false);assert.equal(result.left,null);assert.equal(result.acceptedRounds,0);
    assert.doesNotMatch(JSON.stringify(result),/private-path|synthetic-controller|synthetic-round/);
  }
});

test('same known serial can survive path changes but a newly missing identity is rejected',()=>{
  const a=report(),b=report(1);a.controller.serialNumber=b.controller.serialNumber='synthetic-serial';b.controller.path='new-path';
  assert.equal(compareSessionReports([a,b]).acceptedRounds,2);
  delete b.controller.serialNumber;assert.equal(compareSessionReports([a,b]).comparable,false);
  const missing=report(2);delete missing.controller.path;
  const result=compareSessionReports([missing]);assert.equal(result.comparable,false);assert.equal(result.left,null);
});

test('calibration history and current-epoch verification must match',()=>{
  const action={kind:'center',status:'applied',at:'synthetic-time'};
  const changed=report(1,2,{actions:[action]});
  assert.equal(compareSessionReports([report(),changed]).comparable,false);
  const different=report(2,2,{actions:[{...action,at:'later-time'}]});
  assert.equal(compareSessionReports([changed,different]).comparable,false);
  changed.captures.at(-1).calibrationEpoch=0;
  assert.equal(compareSessionReports([changed]).comparable,false);
});

test('old-epoch captures cannot contaminate current unchanged evidence',()=>{
  const r=report(0,3,{actions:[{kind:'center',status:'applied',at:'synthetic-time'}]});
  const old=structuredClone(r.captures[0]);old.number=0;old.calibrationEpoch=0;old.metrics.left.peakRadiusPercent=90;
  r.captures.unshift(old);
  assert.equal(compareSessionReports([r]).left.suggestedDeadzonePercent,4);
});

test('missing, nonfinite or inconsistent rest evidence yields no recommendation',()=>{
  for(const corrupt of [r=>delete r.captures[0].metrics.left.peakRadiusPercent,r=>r.captures[4].metrics.right.p99RadiusPercent=NaN,r=>r.captures[0].metrics.left.p99RadiusPercent=9,r=>r.captures[4].metrics.maxGapMs=900,r=>r.captures[0].metrics.left.valid=false]) {
    const r=report();corrupt(r);const result=compareSessionReports([r]);
    assert.equal(result.comparable,false);assert.equal(result.left,null);
  }
});

test('candidate above twenty percent is withheld while observed evidence stays visible',()=>{
  const r=report(0,21);for(const side of ['left','right'])Object.assign(r.captures[3].metrics[side],{peakRadiusPercent:3,p99RadiusPercent:2.5});
  const result=compareSessionReports([r]);
  assert.equal(result.comparable,true);assert.equal(result.left.suggestedDeadzonePercent,null);
  assert.equal(result.left.reliable,false);assert.equal(result.left.observedPeakPercent,21);assert.match(result.left.reason,/repeat/i);
});

test('partial circularity never becomes a full-circle result or latest measurement',()=>{
  const a=report(),b=report(1);b.captures[1].metrics.left.circularity={coveredSectors:30,totalSectors:48,errorPercent:0,partialErrorPercent:0};
  const result=compareSessionReports([a,b]);
  assert.deepEqual(result.left.circularity,{min:7,max:7,latest:null,rounds:1,maxOppositeDifferencePercent:2});
  a.captures[1].metrics.left.circularity=b.captures[1].metrics.left.circularity;
  assert.equal(compareSessionReports([a,b]).left.circularity,null);
});

test('contradictory measured circularity bins are unavailable without hiding quiet evidence',()=>{
  for(const corrupt of [c=>c.sectorRadii=Array(48).fill(0),c=>c.sectorRadii=Array(47).fill(1),c=>c.sectorRadii[2]=NaN,c=>c.sectorRadii[0]=1.51,c=>c.errorPercent=80,c=>c.maxOppositeDifferencePercent=90]) {
    const r=report(),circle={coveredSectors:48,totalSectors:48,errorPercent:0,maxOppositeDifferencePercent:0,sectorRadii:Array(48).fill(1)};
    corrupt(circle);r.captures[1].metrics.left.circularity=circle;
    const result=compareSessionReports([r]);assert.equal(result.comparable,true);
    assert.equal(result.left.circularity,null);assert.equal(result.left.suggestedDeadzonePercent,4);
  }
});

test('circularity validation accepts analyzer rounding across symmetric and asymmetric sweeps',()=>{
  for(const verticalScale of [.87,.94,1]){
    const frames=Array.from({length:2400},(_,i)=>{const a=i*Math.PI*4/2400;return {lx:Math.round(127.5+127*Math.cos(a)),ly:Math.round(127.5+127*verticalScale*Math.sin(a))};});
    const circle=circularityFromFrames(frames,'lx','ly'),r=report();
    r.captures[1].metrics.left.circularity=circle;
    assert.equal(circle.coveredSectors,48);assert.equal(compareSessionReports([r]).left.circularity.latest,circle.errorPercent);
  }
  // A true radius just above .2 can round to .20 without losing observed coverage.
  const frames=Array.from({length:2400},(_,i)=>{const a=i*Math.PI*4/2400;return {lx:Math.round(127.5+127*Math.cos(a)),ly:Math.round(127.5+127*Math.sin(a))};}).filter(f=>{
    const x=Math.round(((f.lx-127.5)/128)*100)/100,y=Math.round(((f.ly-127.5)/128)*100)/100;
    return (Math.round(Math.atan2(y,x)*48/(2*Math.PI))+48)%48!==0;
  });
  frames.push({lx:153,ly:129});
  const rounded=circularityFromFrames(frames,'lx','ly'),edge=report();
  assert.equal(rounded.coveredSectors,48);assert.ok(rounded.sectorRadii.includes(.2));
  edge.captures[1].metrics.left.circularity=rounded;
  assert.equal(compareSessionReports([edge]).left.circularity.latest,rounded.errorPercent);
  const legacy=report();assert.equal(compareSessionReports([legacy]).left.circularity.latest,7);
});

test('duplicate sessions are excluded and empty input never fabricates zero drift',()=>{
  const a=report();assert.equal(compareSessionReports([a,structuredClone(a)]).acceptedRounds,1);
  assert.equal(compareSessionReports([]).left,null);
  assert.throws(()=>compareSessionReports(Array(11).fill(a)),/ten/i);
  assert.throws(()=>compareSessionReports(null),/array/i);
});

test('missing saved-session identity cannot manufacture repeated rounds',()=>{
  const a=report();delete a.id;
  assert.equal(compareSessionReports([a,structuredClone(a)]).acceptedRounds,0);
});

test('a quiet phase repeated later cannot erase an earlier valid peak in that round',()=>{
  const a=report(0,2),earlier=structuredClone(a.captures[0]);
  earlier.number=1;earlier.metrics.left.peakRadiusPercent=6;
  a.captures.forEach(c=>c.number++);a.captures.unshift(earlier);
  const result=compareSessionReports([a]);assert.equal(result.left.suggestedDeadzonePercent,7);
  earlier.metrics.valid=false;
  assert.equal(compareSessionReports([a]).left.suggestedDeadzonePercent,3);
});

test('latest required phase must be valid and final verification must come last',()=>{
  const a=report();a.captures.push({...structuredClone(a.captures[3]),number:6});
  assert.equal(compareSessionReports([a]).comparable,false);
  const b=report();b.captures.push({...structuredClone(b.captures[0]),number:6,metrics:{...b.captures[0].metrics,valid:false}});
  assert.equal(compareSessionReports([b]).comparable,false);
});
