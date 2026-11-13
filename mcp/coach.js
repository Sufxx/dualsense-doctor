// Pure input-responsive coaching. No HID access, controller writes, or timers.
// Speed and motion thresholds are empirical coaching defaults, not manufacturer
// calibration requirements or a diagnosis of mechanical condition.
const PHASES=new Set(['rest','range','release','buttons','verify']);
const AXES={left:['lx','ly'],right:['rx','ry']};
const TAU=2*Math.PI;
const clamp=v=>Math.max(0,Math.min(1,v));
const round=v=>Math.round(v*100)/100;
const point=(frame,[x,y])=>({x:(frame[x]-128)/127,y:(frame[y]-128)/127});
const radius=p=>Math.hypot(p.x,p.y);
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const cue=(cueCode,cueMessage,cueTone='neutral',pace='')=>({cueCode,cueMessage,cueTone,pace});
const sideState=()=>({history:[],angle:null,lastAt:null,netAngle:0,sectors:new Set(),velocity:0,
  speed:0,radius:0,releases:0,releaseDirections:new Set(),unsettledReleases:0,lastReturn:null,cooldownUntil:0,ready:true,armed:null,pending:null,postReturnPeak:0,fastFlicks:0,contaminated:false,cue:cue('waiting_input','Waiting for fresh stick input.')});

export class StickCoach {
  constructor({clock=()=>performance.now(),continuous=false}={}) {
    if(typeof clock!=='function')throw Error('clock must be a function');
    this.clock=clock;this.phase=null;this.continuous=continuous;
  }

  start(phase,{direction='clockwise'}={}) {
    if(!PHASES.has(phase))throw Error('Unknown coaching phase');
    if(!['clockwise','counterclockwise'].includes(direction))throw Error('Unknown range direction');
    const now=this.clock();
    this.phase=phase;this.direction=direction;this.startedAt=now;this.lastAt=null;
    this.latest=null;this.complete=false;this.warning=null;this.message=this.instruction();
    this.sides={left:sideState(),right:sideState()};this.window=[];this.stableSince=null;
    this.presses=0;this.previousButtons=null;this.contaminated=false;this.progress=0;
    this.secondsRemaining=phase==='range'||phase==='release'?null:phase==='buttons'?8:5;
    this.inputInvalid=false;
    return this.state();
  }

  instruction() {
    if(this.phase==='range')return `Roll both sticks ${this.direction} along the outer rim. Aim for one turn every 3–6 seconds.`;
    if(this.phase==='release')return 'Flick both sticks in the four directions. Let go fully and wait at least half a second between flicks.';
    if(this.phase==='buttons')return 'Press face buttons and shoulders at a comfortable pace. Keep your thumbs clear of both sticks.';
    return 'Put the controller down and leave both sticks untouched.';
  }

  feed(frame) {
    if(!this.phase)throw Error('Start a coaching phase first');
    const now=this.clock();
    const valid=Number.isFinite(now)&&Object.values(AXES).flat().every(a=>Number.isInteger(frame?.[a])&&frame[a]>=0&&frame[a]<=255);
    if(!valid) {
      this.inputInvalid=true;this.latest=null;this.stableSince=null;
      this.warning='Invalid stick input. Waiting for fresh controller reports.';return this.state();
    }
    if(this.lastAt!==null&&now<=this.lastAt)throw Error('Coaching clock must increase between reports');
    const gap=this.lastAt!==null&&now-this.lastAt>250;
    this.latest={...frame};this.inputInvalid=false;
    if(this.complete&&!this.continuous) {this.lastAt=now;return this.state();}
    if(gap) {
      this.stableSince=null;this.window=[];
      for(const s of Object.values(this.sides)){s.angle=null;s.lastAt=null;s.history=[];s.velocity=0;s.speed=0;s.armed=null;s.pending=null;}
    }
    this.warning=null;
    const elapsed=now-this.startedAt;
    if(this.phase==='range')this.range(frame,now,elapsed);
    else if(this.phase==='release')this.release(frame,now);
    else if(this.phase==='buttons')this.buttons(frame,now,elapsed);
    else this.rest(frame,now);
    this.lastAt=now;
    if(gap&&!this.warning)this.warning='Input was interrupted. Continue with fresh reports; interrupted settling time was discarded.';
    if(elapsed>=30000&&!this.complete&&!this.warning)this.warning='This step is taking longer than expected. Check the instruction or restart the phase; it has not passed.';
    this.message=this.complete?'Capture evidence complete.':this.warning||this.instruction();
    return this.state();
  }

  range(frame,now,elapsed) {
    const direction=this.direction==='clockwise'?1:-1;
    const warnings=[];
    for(const [side,axes] of Object.entries(AXES)) {
      const s=this.sides[side],p=point(frame,axes),r=radius(p),a=Math.atan2(p.y,p.x);
      s.radius=r;
      s.cue=cue('keep_going',`Trace the full outer edge ${this.direction}.`,'neutral','Start turning');
      if(r<.85) {
        s.angle=null;s.lastAt=null;s.history=[];s.velocity=0;s.speed=0;
        s.cue=cue('reach_rim',`Push to the outer edge, then turn ${this.direction}.`,'warning','Reach the edge');
        warnings.push(`${side}: reach the outer rim.`);continue;
      }
      if(s.angle!==null) {
        const dt=now-s.lastAt,delta=wrap(a-s.angle);
        s.history.push({at:now,delta,dt});s.history=s.history.filter(v=>v.at>=now-1000);
        const seconds=s.history.reduce((sum,v)=>sum+v.dt,0)/1000;
        s.velocity=seconds?s.history.reduce((sum,v)=>sum+v.delta,0)/seconds:0;
        const speed=seconds?s.history.reduce((sum,v)=>sum+Math.abs(v.delta),0)/seconds:0;
        s.speed=speed;
        // Count net travel, so back-and-forth arcs cannot manufacture circles.
        // Both endpoints must be on the rim, the interval fresh, and motion at
        // an observable pace. A wrong-way move subtracts earned net travel.
        if(dt<=250&&speed<=3&&Math.abs(s.velocity)>=.35) {
          s.netAngle=Math.max(0,s.netAngle+direction*delta);
          if(direction*delta>0)s.sectors.add((Math.floor((a+Math.PI)/TAU*16)+16)%16);
        }
        if(speed>3)s.cue=cue('too_fast','Slow down. Aim for one full turn every 3–6 seconds.','warning','Too fast');
        else if(direction*s.velocity<-.2)s.cue=cue('wrong_direction',`Change direction: turn ${this.direction} along the full outer edge.`,'warning','Wrong direction');
        else if(elapsed>1000&&Math.abs(s.velocity)<.35)s.cue=cue('too_slow','Turn a little faster and keep moving around the full outer edge.','warning','Too slow');
        else if(Math.abs(s.velocity)<.35)s.cue=cue('keep_going',`Start turning ${this.direction} along the full outer edge.`,'neutral','Start turning');
        else if(s.netAngle>=2*TAU&&s.sectors.size>=14)s.cue=cue('complete','Coverage captured. Keep a gentle circle while the other stick finishes.','good','Coverage captured');
        else s.cue=cue('keep_going',`Good pace. Keep tracing the full outer edge ${this.direction}.`,'good','Good pace');
        if(s.cue.cueTone==='warning')warnings.push(`${side}: ${s.cue.cueMessage}`);
      }
      s.angle=a;s.lastAt=now;
    }
    const progress=Object.values(this.sides).map(s=>Math.min(clamp(s.netAngle/(2*TAU)),clamp(s.sectors.size/14)));
    this.progress=Math.min(...progress,clamp(elapsed/6000));
    this.complete=elapsed>=6000&&Object.values(this.sides).every(s=>s.netAngle>=2*TAU&&s.sectors.size>=14);
    this.secondsRemaining=null;this.warning=warnings.length?warnings.join(' '):null;
    if(!warnings.length&&!this.complete) {
      const missing=Object.entries(this.sides).filter(([,s])=>s.netAngle>=2*TAU&&s.sectors.size<14);
      if(missing.length)this.warning=`${missing[0][0]}: cover the missing directions around the rim.`;
    }
  }

  rest(frame,now) {
    this.window.push({at:now,frame});this.window=this.window.filter(v=>v.at>=now-250);
    let moving=false;
    for(const [side,axes] of Object.entries(AXES)) {
      const s=this.sides[side];s.radius=radius(point(frame,axes));
      const sideMoving=s.radius>.35||axes.some(a=>{const values=this.window.map(v=>v.frame[a]);return Math.max(...values)-Math.min(...values)>5;});
      moving||=sideMoving;
      s.cue=sideMoving?cue('hands_off','Let go completely. Waiting for this stick to settle.','warning'):cue('hold_still','Keep this stick untouched.','good');
    }
    if(moving){this.stableSince=null;this.warning='Hands off both sticks. Waiting for them to settle.';}
    else if(this.stableSince===null)this.stableSince=now;
    const stable=this.stableSince===null?0:now-this.stableSince;
    this.progress=clamp(stable/5000);this.secondsRemaining=Math.max(0,(5000-stable)/1000);this.complete=stable>=5000;
  }

  buttons(frame,now,elapsed) {
    const current=Number.isInteger(frame.buttons)?frame.buttons&0x7fff:0;
    if(this.previousButtons!==null) {
      const rising=current&~this.previousButtons;
      for(let bit=0;bit<15;bit++)if(rising&(1<<bit))this.presses++;
    }
    this.previousButtons=current;
    for(const [side,axes] of Object.entries(AXES)) {
      const s=this.sides[side];s.radius=radius(point(frame,axes));s.contaminated||=s.radius>.12;
      s.cue=s.contaminated?cue('hands_off','Stick movement detected. Keep your thumb clear for the repeat.','warning'):cue('press_buttons','Press and release buttons; keep this stick untouched.');
    }
    if(Object.values(this.sides).some(s=>s.contaminated))this.contaminated=true;
    this.progress=Math.min(clamp(elapsed/8000),clamp(this.presses/8));
    this.secondsRemaining=Math.max(0,(8000-elapsed)/1000);
    this.complete=elapsed>=8000&&this.presses>=8&&!this.contaminated;
    if(this.contaminated)this.warning='Stick movement detected. Keep thumbs clear; restart this button phase for a clean capture.';
    else if(elapsed>=8000&&this.presses<8)this.warning='Press and release more buttons. Held buttons do not count as repeated presses.';
  }

  release(frame,now) {
    const warnings=[];
    for(const [side,axes] of Object.entries(AXES)) {
      const s=this.sides[side],p=point(frame,axes),r=radius(p);s.radius=r;
      if(s.pending&&now-s.pending.at<=300) {
        s.postReturnPeak=Math.max(s.postReturnPeak,r);
        if(r>=.35&&!s.pending.unsettled){s.unsettledReleases++;s.pending.unsettled=true;}
      }
      if(now>=s.cooldownUntil&&r<.15)s.ready=true;
      if(s.ready&&now>=s.cooldownUntil&&r>.75) {
        if(!s.armed&&s.lastReturn!==null&&now-s.lastReturn<500)s.fastFlicks++;
        s.armed={x:p.x,y:p.y};
      }
      if(s.armed&&r<.15) {
        s.releaseDirections.add((Math.round(Math.atan2(s.armed.y,s.armed.x)/(Math.PI/2))+4)%4);
        s.releases++;s.lastReturn=now;s.cooldownUntil=now+350;s.ready=false;
        s.pending={at:now,unsettled:false};s.armed=null;
      }
      if(s.pending?.unsettled&&now-s.pending.at<=300)warnings.push(`${side}: movement after return. Let go fully and allow the stick to settle; this may include snapback.`);
      else if(s.lastReturn!==null&&now-s.lastReturn<500&&s.fastFlicks)warnings.push(`${side}: leave at least half a second between flicks.`);
      if(s.pending?.unsettled&&now-s.pending.at<=300)s.cue=cue('settle','Movement after return. Let go fully and allow this stick to settle.','warning');
      else if(s.lastReturn!==null&&now-s.lastReturn<500)s.cue=cue('settle','Wait at center for half a second before the next flick.');
      else if(s.armed)s.cue=cue('release_now','Let go completely so the stick returns on its own.');
      else if(s.releaseDirections.size===4)s.cue=cue('complete','All four directions captured. Keep this stick untouched.','good');
      else {const next=[0,1,2,3].find(d=>!s.releaseDirections.has(d));s.cue=cue('flick_next',`Flick ${['right','down','left','up'][next]}, then let go completely.`);}
    }
    this.progress=Math.min(...Object.values(this.sides).map(s=>clamp(s.releaseDirections.size/4)));
    // Keep observing the last return rather than ending before a rebound can arrive.
    this.complete=Object.values(this.sides).every(s=>s.releaseDirections.size===4&&now-s.lastReturn>300);
    if(!warnings.length&&Object.values(this.sides).some(s=>s.releases>=4&&s.releaseDirections.size<4))warnings.push('Include all four directions: up, down, left and right.');
    this.secondsRemaining=null;this.warning=warnings.length?warnings.join(' '):null;
  }

  state() {
    if(!this.phase)return {phase:null,complete:false,message:'Start a coaching phase.',warning:null,progress:0,secondsRemaining:null,latest:null,details:{}};
    const elapsed=Math.max(0,this.clock()-this.startedAt);
    const stale=!this.complete&&this.lastAt!==null&&this.clock()-this.lastAt>250;
    const warning=stale?'Controller input is stale. Waiting for fresh reports.':this.warning;
    const details={elapsedMs:elapsed,timedOut:elapsed>=30000&&!this.complete,inputFresh:this.lastAt!==null&&!stale&&!this.inputInvalid};
    if(this.phase==='range') {
      details.direction=this.direction;details.coachingDefaults={minRimRadius:.85,minRadiansPerSecond:.35,maxRadiansPerSecond:3,targetSecondsPerTurn:[3,6],targetTurns:2,minSectors:14};
      for(const [side,s] of Object.entries(this.sides))details[side]={radius:round(s.radius),angularVelocity:round(s.velocity),speedRadPerSec:round(s.speed),turns:round(s.netAngle/TAU),coveredSectors:s.sectors.size};
    } else if(this.phase==='release') {
      details.evidenceOnly=true;
      for(const [side,s] of Object.entries(this.sides))details[side]={releases:s.releases,directions:[...s.releaseDirections],unsettledReleases:s.unsettledReleases,postReturnPeakPercent:round(s.postReturnPeak*100),fastFlicks:s.fastFlicks};
    } else if(this.phase==='buttons')Object.assign(details,{presses:this.presses,contaminated:this.contaminated,restExcursionLimit:.12});
    else details.stableMs=stale||this.inputInvalid||this.stableSince===null?0:Math.max(0,this.clock()-this.stableSince);
    for(const [side,s] of Object.entries(this.sides)) {
      const guidance=stale?cue('stale','Waiting for fresh controller reports.','warning'):this.inputInvalid||this.lastAt===null?cue('waiting_input','Waiting for fresh stick input.'):this.complete?cue('complete','Evidence captured for this step.','good'):s.cue;
      details[side]={radius:round(s.radius),...details[side],...guidance};
    }
    return {phase:this.phase,complete:this.complete,message:this.complete?'Capture evidence complete.':warning||this.message,warning,
      progress:this.complete?1:stale?0:this.progress,secondsRemaining:this.secondsRemaining===null?null:round(this.secondsRemaining),
      latest:stale||this.inputInvalid?null:this.latest?{...this.latest}:null,details};
  }
}
