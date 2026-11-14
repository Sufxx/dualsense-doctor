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
function arc(run,start,sweep) {
  const steps=Math.abs(sweep)/3;
  for(let i=0;i<=steps;i++)run.feed(circleFrame((start+sweep*i/steps)*Math.PI/180));
  // Let the final aggregate qualify before inspecting earned angle. Holding
  // the endpoint adds timing evidence, never additional angular motion.
  return run.feed(circleFrame((start+sweep)*Math.PI/180),100);
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
test('range cues identify each stick and prioritize rim contact before pace',()=>{
  const run=setup();let result;
  for(let i=0;i<60;i++)result=run.feed({...circleFrame(-i*.06),lx:160,ly:128});
  assert.equal(result.details.left.cueCode,'reach_rim');
  assert.equal(result.details.right.cueCode,'wrong_direction');
  assert.match(result.details.right.cueMessage,/clockwise/);
  assert.equal(result.details.left.cueTone,'warning');
  assert.equal(result.complete,false);
});
test('range cues expose too-fast, too-slow and accepted pace without inventing completion',()=>{
  for(const [speed,code] of [[Math.PI*2,'too_fast'],[.1,'too_slow'],[Math.PI/2,'keep_going']]) {
    const result=circle(setup(),2,speed);
    assert.equal(result.details.left.cueCode,code);
    assert.ok(result.details.left.speedRadPerSec>=0);
    assert.equal(result.complete,false);
  }
});
test('holding the rim at startup is not described as good pace',()=>{
  const run=setup();run.feed(circleFrame(0));const result=run.feed(circleFrame(0));
  assert.equal(result.details.left.cueTone,'neutral');
  assert.equal(result.details.left.pace,'Start turning');assert.equal(result.complete,false);
});
test('stale and invalid input replace directional cues until fresh evidence returns',()=>{
  const run=setup();circle(run,1,Math.PI/2);
  assert.equal(run.advance(300).details.left.cueCode,'stale');
  assert.equal(run.feed(circleFrame(1.5)).details.left.cueCode,'keep_going');
  assert.equal(run.feed({lx:NaN}).details.left.cueCode,'waiting_input');
});
test('rest and release cues tell each stick what to do next',()=>{
  const resting=setup('rest'),rest=resting.feed({lx:200});
  assert.equal(rest.details.left.cueCode,'hands_off');assert.equal(rest.details.right.cueCode,'hold_still');
  const releasing=setup('release');
  assert.equal(releasing.feed({lx:255,rx:255}).details.left.cueCode,'release_now');
  assert.equal(releasing.feed(neutral).details.left.cueCode,'settle');
  const next=releasing.feed(neutral,600);
  assert.equal(next.details.left.cueCode,'flick_next');assert.match(next.details.left.cueMessage,/down/);
});
test('partial arcs do not pass despite repeated movement',()=>{
  const run=setup();let result;for(let i=0;i<500;i++)result=run.feed(circleFrame(Math.sin(i*.04)*.6));
  assert.equal(result.complete,false);assert.ok(result.details.left.coveredSectors<14);
});
for(const [name,interrupt,restartOffset=0] of [
  ['center dip',run=>run.feed(neutral)],
  ['report gap',(run,angle)=>run.feed(circleFrame(angle),300)],
  ['invalid report',run=>run.feed({lx:NaN})],
  ['undersampled jump',(run,angle)=>run.feed(circleFrame(angle+150*Math.PI/180)),150],
]) {
  test(`range discards an unfinished turn after ${name}`,()=>{
    const run=setup();
    for(let n=0;n<3;n++) {
      const start=n*90;
      const partial=arc(run,start,300);
      assert.equal(partial.complete,false);
      assert.ok(partial.details.left.turns<1);
      const broken=interrupt(run,(start+300)*Math.PI/180);
      assert.equal(broken.complete,false);
      assert.equal(broken.details.left.turns,0);
      assert.equal(broken.details.right.turns,0);
      assert.equal(broken.details.left.coveredSectors,0);
    }
  });
  test(`range keeps completed turns but discards the next partial turn after ${name}`,()=>{
    const run=setup();
    assert.equal(arc(run,11,420).details.left.turns,1.17);
    const broken=interrupt(run,431*Math.PI/180);
    assert.equal(broken.details.left.turns,1);
    assert.equal(broken.details.right.turns,1);
    assert.equal(broken.complete,false);
    assert.equal(arc(run,431+restartOffset,360).complete,true);
  });
}
test('an unobservable jump after a rim pause cannot hide behind smoothed pace',()=>{
  const run=setup();arc(run,0,300);
  for(let i=0;i<30;i++)run.feed(circleFrame(300*Math.PI/180));
  const jumped=run.feed(circleFrame(420*Math.PI/180),4);
  assert.equal(jumped.complete,false);
  assert.equal(jumped.details.left.turns,0);
  assert.equal(jumped.details.left.coveredSectors,0);
  assert.equal(jumped.details.left.cueCode,'unobservable_motion');
  assert.equal(jumped.details.left.speedRadPerSec,0);
});
test('range accepts byte-quantized controlled circles at 250 reports per second',()=>{
  const run=setup();let result;
  for(let i=0;i<2250;i++)result=run.feed(circleFrame(.37+Math.PI/2*i*.004),4);
  assert.equal(result.complete,true);
  assert.equal(result.details.left.turns,2);
});
test('burst-delivered reports retain controlled circles without instantaneous speed claims',()=>{
  for(const [direction,sign] of [['clockwise',1],['counterclockwise',-1]]) {
    const run=setup('range',{direction});let result;
    // Four physical samples per 16 ms, delivered in alternating delayed/burst
    // order. These are synthetic arrivals, not sensor acquisition timestamps.
    for(let i=0;i<2250;i++) {
      const delay=[15.91,.03,.03,.03][i%4];
      result=run.feed(circleFrame(.37+sign*Math.PI/2*i*.004),delay);
      assert.notEqual(result.details.left.cueCode,'too_fast');
    }
    assert.equal(result.complete,true);
    assert.ok(result.details.left.turns>=2);
  }
});
test('observable quadrant pace variation uses a sustained pace window',()=>{
  const run=setup();let result;
  // A 3.3-second turn with smooth quadrant variation peaks locally above the
  // coaching pace, but its sustained motion remains controlled and observable.
  for(let i=0;i<2250;i++) {
    const t=i*.004,angle=1.9*t+.18*Math.sin(4*1.9*t);
    result=run.feed(circleFrame(angle),[15.91,.03,.03,.03][i%4]);
  }
  assert.equal(result.complete,true);
});
test('preceding idle and a tiny advance followed by a stationary hold cannot subsidize a fast lap',()=>{
  for(const initialAdvance of [0,.01]) {
    const run=setup();run.feed(circleFrame(0));
    if(initialAdvance)run.feed(circleFrame(initialAdvance));
    for(let i=0;i<125;i++)run.feed(circleFrame(initialAdvance));
    let result;
    for(let i=1;i<=25;i++)result=run.feed(circleFrame(initialAdvance+2*Math.PI*i/25));
    assert.equal(result.complete,false);
    assert.equal(result.details.left.turns,0);
    assert.equal(result.details.right.turns,0);
  }
});
test('a completed slow lap does not subsidize the next fast lap',()=>{
  const run=setup();assert.equal(arc(run,0,360).details.left.turns,1);
  let result;
  for(let i=1;i<=25;i++)result=run.feed(circleFrame(2*Math.PI*i/25));
  assert.equal(result.complete,false);
  assert.equal(result.details.left.turns,1);
  assert.equal(arc(run,0,360).complete,true);
});
test('lap pace counts absolute travel so reversal time cannot hide fast motion',()=>{
  const run=setup();run.feed(circleFrame(0));let result;
  for(const [start,steps,sign] of [[0,90,1],[270,60,-1],[90,90,1]]) {
    for(let i=1;i<=steps;i++)result=run.feed(circleFrame((start+sign*i*3)*Math.PI/180),10.5);
  }
  assert.equal(result.complete,false);
  assert.equal(result.details.left.turns,0);
});
test('a report burst immediately after resetting a segment waits for measurable elapsed time',()=>{
  const run=setup();arc(run,0,300);run.feed(neutral);
  run.feed(circleFrame(0));
  let result;
  for(let i=1;i<=3;i++) {
    result=run.feed(circleFrame(i*.0063),.03);
    assert.notEqual(result.details.left.cueCode,'too_fast');
    assert.equal(result.details.left.speedRadPerSec,0);
    assert.equal(result.details.left.turns,0);
  }
  for(let i=4;i<=2250;i++)result=run.feed(circleFrame(i*.0063),[15.91,.03,.03,.03][i%4]);
  assert.equal(result.complete,true);
});
test('leaving the rim resets only the affected stick partial turn',()=>{
  const run=setup();arc(run,0,300);
  const result=run.feed({...circleFrame(300*Math.PI/180),lx:128,ly:128});
  assert.equal(result.details.left.turns,0);
  assert.equal(result.details.right.turns,.83);
  assert.equal(result.complete,false);
});
test('two full turns still require six seconds and enough observed rim sectors',()=>{
  const fast=setup();const beforeSixSeconds=circle(fast,5,2.8);
  assert.ok(beforeSixSeconds.details.left.turns>=2);
  assert.equal(beforeSixSeconds.complete,false);
  assert.equal(fast.feed(circleFrame(2.8*124*.04),40).complete,false);

  const sparse=setup();let result;
  // Nine equally spaced reports per turn meet the pace limit, but do not
  // provide the required fourteen distinct observed rim sectors.
  for(let i=0;i<=36;i++)result=sparse.feed(circleFrame(i*40*Math.PI/180),250);
  assert.ok(result.details.left.turns>=2);
  assert.ok(result.details.left.coveredSectors<14);
  assert.equal(result.complete,false);
});
test('completed full turns survive a center dip from arbitrary starting angles',()=>{
  for(const [direction,sign] of [['clockwise',1],['counterclockwise',-1]]) {
    const run=setup('range',{direction});
    assert.equal(arc(run,37,360*sign).details.left.turns,1);
    const centered=run.feed(neutral);
    assert.equal(centered.details.left.turns,1);
    assert.equal(centered.complete,false);
    const result=arc(run,123,360*sign);
    assert.equal(result.complete,true);
    assert.equal(result.details.left.turns,2);
    assert.equal(result.details.right.turns,2);
  }
});
test('an on-rim pause preserves the partial turn without earning motion',()=>{
  const run=setup();
  const partial=arc(run,17,240);
  let paused;
  for(let i=0;i<50;i++)paused=run.feed(circleFrame(257*Math.PI/180));
  assert.equal(paused.details.left.turns,partial.details.left.turns);
  assert.equal(paused.details.left.cueCode,'too_slow');
  const resumed=arc(run,257,540);
  assert.equal(resumed.complete,true);
});
test('small wrong-way motion subtracts from the current turn without resetting it',()=>{
  const run=setup();
  assert.equal(arc(run,0,240).details.left.turns,.67);
  run.feed(circleFrame(237*Math.PI/180),40);
  assert.equal(run.feed(circleFrame(237*Math.PI/180),60).details.left.turns,.66);
  run.feed(circleFrame(240*Math.PI/180),40);
  const resumed=run.feed(circleFrame(240*Math.PI/180),60);
  assert.equal(resumed.details.left.turns,.67);
  assert.equal(resumed.complete,false);
});
test('wrong-way movement below the pace threshold cannot manufacture a full turn',()=>{
  const run=setup();
  arc(run,0,300);
  // Pause until the pace history is empty of forward motion, then backtrack
  // slowly enough to stay below the accepted pace before moving forward again.
  for(let i=0;i<30;i++)run.feed(circleFrame(300*Math.PI/180));
  for(let i=1;i<=500;i++)run.feed(circleFrame((300-i*.6)*Math.PI/180));
  assert.equal(run.coach.state().details.left.turns,0);
  const repeated=arc(run,0,300);
  assert.equal(repeated.complete,false);
  assert.ok(repeated.details.left.turns<1);
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
test('a rebound before the first sampled center return retains the outward flick direction',()=>{
  const cardinals=[{lx:255,rx:255},{ly:255,ry:255},{lx:0,rx:0},{ly:0,ry:0}];
  const run=setup('release');
  for(let direction=0;direction<4;direction++) {
    run.feed(neutral,600);
    run.feed(cardinals[direction]);
    run.feed(cardinals[(direction+2)%4],12);
    const returning=run.feed(neutral,12);
    assert.deepEqual(returning.details.left.directions,Array.from({length:direction+1},(_,i)=>i));
    assert.deepEqual(returning.details.right.directions,Array.from({length:direction+1},(_,i)=>i));
    assert.equal(returning.details.left.releases,direction+1);
    assert.equal(returning.details.left.unsettledReleases,0);
    assert.equal(returning.complete,false);
  }
  assert.equal(run.feed(neutral,200).complete,false);
  const finished=run.feed(neutral,101);
  assert.equal(finished.complete,true);
  assert.equal(finished.details.evidenceOnly,true);
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
