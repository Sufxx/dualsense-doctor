import test from 'node:test';
import assert from 'node:assert/strict';
import { StickCoach } from '../coach.js';

const neutral = { lx:128, ly:128, rx:128, ry:128, buttons:0 };
function setup(phase='range', options={}) {
  let now=0;
  const coach=new StickCoach({clock:()=>now});coach.start(phase,options);
  return {coach,feed(frame,ms=40){now+=ms;return coach.feed({...neutral,...frame});},advance(ms){now+=ms;return coach.state();}};
}
function circleFrame(angle,radius=1) {
  const x=Math.round(128+126*radius*Math.cos(angle));
  const y=Math.round(128+126*radius*Math.sin(angle));
  return {lx:x,ly:y,rx:x,ry:y};
}
function circle(run,seconds,speed) {
  let state;for(let i=0;i<seconds*25;i++)state=run.feed(circleFrame(speed*i*.04));return state;
}

test('range completes two controlled circles in the requested direction',()=>{
  const run=setup();const result=circle(run,9,Math.PI/2);
  assert.equal(result.complete,true);assert.equal(result.progress,1);
  assert.ok(result.details.left.turns>=2);assert.ok(result.details.left.coveredSectors>=14);
});
test('counterclockwise range accepts the opposite requested direction',()=>{
  const run=setup('range',{direction:'counterclockwise'});
  assert.equal(circle(run,9,-Math.PI/2).complete,true);
});
test('overspeed warns and does not accumulate a passing range',()=>{
  const run=setup();const result=circle(run,9,Math.PI*2);
  assert.equal(result.complete,false);assert.match(result.warning,/slow down/i);
  assert.ok(result.details.left.turns<1);
});
test('wrong direction warns and cannot complete clockwise coverage',()=>{
  const run=setup();const result=circle(run,9,-Math.PI/2);
  assert.equal(result.complete,false);assert.match(result.warning,/clockwise/i);
  assert.equal(result.details.left.turns,0);
});
test('slow movement and incomplete rim contact receive distinct feedback',()=>{
  const slow=setup();assert.match(circle(slow,2,.1).warning,/little faster/i);
  const inner=setup();let result;for(let i=0;i<200;i++)result=inner.feed(circleFrame(i*.06,.5));
  assert.equal(result.complete,false);assert.match(result.warning,/outer rim/i);
});
test('partial arcs do not pass despite repeated movement',()=>{
  const run=setup();let result;for(let i=0;i<500;i++)result=run.feed(circleFrame(Math.sin(i*.04)*.6));
  assert.equal(result.complete,false);assert.ok(result.details.left.coveredSectors<14);
});
test('rest requires five continuous stable seconds after movement',()=>{
  const run=setup('rest');for(let i=0;i<100;i++)run.feed(neutral);
  assert.equal(run.coach.state().complete,false);
  assert.match(run.feed({lx:200}).warning,/hands off/i);
  for(let i=0;i<124;i++)run.feed(neutral);
  assert.equal(run.coach.state().complete,false);
  for(let i=0;i<12;i++)run.feed(neutral);
  assert.equal(run.coach.state().complete,true);
});
test('input interruption resets rest continuity instead of passing on elapsed wall time',()=>{
  const run=setup('verify');for(let i=0;i<100;i++)run.feed(neutral);
  assert.match(run.advance(2000).warning,/input/i);
  assert.equal(run.feed(neutral).complete,false);
});
test('invalid reports cannot carry a previous live position forward',()=>{
  const run=setup('rest');run.feed(neutral);
  const result=run.feed({lx:NaN});
  assert.equal(result.latest,null);assert.equal(result.details.inputFresh,false);assert.equal(result.complete,false);
});
test('button presses count edges and contamination remains until phase restart',()=>{
  const run=setup('buttons');for(let i=0;i<225;i++)run.feed({buttons:i%2});
  assert.equal(run.coach.state().complete,true);
  run.coach.start('buttons');let result;
  for(let i=0;i<225;i++) result=run.feed({buttons:i%2,...(i===50?{lx:200}:{})});
  assert.equal(result.complete,false);assert.equal(result.details.contaminated,true);assert.match(result.warning,/thumbs clear/i);
});
test('spring-back excursion cannot count as a second release',()=>{
  const run=setup('release');run.feed({lx:255,rx:255});run.feed(neutral);
  run.feed({lx:0,rx:0},12);run.feed(neutral,12);
  assert.equal(run.coach.state().details.left.releases,1);
  assert.equal(run.coach.state().details.left.unsettledReleases,1);
  assert.equal(run.coach.state().complete,false);
});
test('four distinct cardinal releases are sufficient evidence without declaring them healthy',()=>{
  const run=setup('release');let result;
  for(let n=0;n<4;n++) {
    const cardinal=[{lx:255,rx:255},{ly:255,ry:255},{lx:0,rx:0},{ly:0,ry:0}][n];
    run.feed(neutral,600);run.feed(cardinal);run.feed(neutral);
    run.feed({lx:70,rx:70},12);run.feed(neutral,12);
  }
  result=run.feed(neutral,320);
  assert.equal(result.complete,true);assert.equal(result.details.left.releases,4);
  assert.equal(result.details.left.unsettledReleases,4);
});
test('repeating one direction cannot satisfy four-direction release coverage',()=>{
  const run=setup('release');for(let n=0;n<5;n++){run.feed(neutral,600);run.feed({lx:255,rx:255});run.feed(neutral);}
  const state=run.feed(neutral,320);assert.equal(state.complete,false);assert.equal(state.progress,.25);
});
test('long phase timeout warns but never supplies missing evidence',()=>{
  const run=setup('range');let result;
  for(let i=0;i<800;i++)result=run.feed(neutral);
  assert.equal(result.complete,false);assert.equal(result.details.timedOut,true);
});
