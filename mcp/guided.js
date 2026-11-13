// Local, read-only measurement sessions. No HID feature/output reports here.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { listControllers } from './hid/dualsense.js';
export { withController } from './hid/controller-session.js';
import { StickCoach } from './coach.js';

export const PHASES = {
  rest: 'Put the controller down. Leave BOTH sticks completely untouched for 5 seconds.',
  range: 'Slowly roll BOTH sticks against the outside rim, clockwise and counterclockwise. Reach every direction for 10 seconds.',
  release: 'Flick BOTH sticks in the four cardinal directions and release completely each time. Pause at center for half a second. Repeat for 10 seconds.',
  buttons: 'Leave sticks untouched. Repeatedly press face buttons and shoulders/triggers for 8 seconds. Avoid the PS button.',
  verify: 'Put the controller down again. Leave BOTH sticks untouched for 5 seconds.',
};
export const DEFAULT_SECONDS = { rest:5, range:10, release:10, buttons:8, verify:5 };
export function resolveSessionController(saved, available=listControllers()) {
  const matches=available.filter(c=>c.productId===saved.productId && (saved.serialNumber?c.serialNumber===saved.serialNumber:c.path===saved.path));
  const found=matches.find(c=>c.path===saved.path)|| (matches.length===1?matches[0]:null);
  if(!found) throw Error('Session controller not connected or ambiguous; list controllers and reconnect the original device.');
  return found;
}
const AXES = {left:['lx','ly'],right:['rx','ry']};
const round = v => Math.round(v*100)/100;
const percentile = (values,p) => { const a=[...values].sort((x,y)=>x-y); return a[Math.min(a.length-1,Math.floor(a.length*p))]; };
const radius = (f,x,y) => Math.hypot(f[x]-128,f[y]-128)/127;
// Match DualShock Tools' axis rounding, 48-bin maxima, and RMS radial error.
// See controller-manager.js, core.js, stick-renderer.js in that MIT project.
export function circularityFromFrames(frames,x,y) {
  const bins=Array(48).fill(0);
  for(const f of frames) {
    const nx=Math.round((f[x]-127.5)/128*100)/100,ny=Math.round((f[y]-127.5)/128*100)/100;
    const sector=(Math.round(Math.atan2(ny,nx)*48/(2*Math.PI))+48)%48;
    bins[sector]=Math.max(bins[sector],Math.hypot(nx,ny));
  }
  const covered=bins.filter(r=>r>.2),full=covered.length===48;
  const error=covered.length?round(100*Math.sqrt(covered.reduce((sum,r)=>sum+(r-1)**2,0)/covered.length)):null;
  return {coveredSectors:covered.length,totalSectors:48,errorPercent:full?error:null,partialErrorPercent:full?null:error,
    maxOppositeDifferencePercent:full?round(Math.max(...bins.slice(0,24).map((r,i)=>Math.abs(r-bins[i+24])))*100):null,
    referenceTargetPercent:[7,9],note:'RMS error of angular maximum radii; require all 48 sectors. Target is guidance, not a reason to reduce good range.',sectorRadii:bins.map(round)};
}

export function analyzePhase(phase, frames, expectedMs) {
  if (!Object.hasOwn(PHASES,phase)) throw Error('Unknown phase');
  const durationMs=frames.length>1 ? frames.at(-1).t-frames[0].t : 0;
  const maxGapMs=frames.reduce((m,f,i)=>i?Math.max(m,f.t-frames[i-1].t):0,0);
  const modes=[...new Set(frames.map(f=>f.mode).filter(Boolean))];
  const validData=frames.every((f,i)=>Number.isFinite(f.t) && (!i || f.t>frames[i-1].t) && Object.values(AXES).flat().every(a=>Number.isInteger(f[a]) && f[a]>=0 && f[a]<=255));
  const covered=!expectedMs || (frames.length && frames[0].t<=250 && frames.at(-1).t>=expectedMs-250);
  const quality=frames.length>=50 && durationMs>=1000 && maxGapMs<=250 && modes.length<=1 && validData && covered;
  const result={phase,samples:frames.length,durationMs,maxGapMs,mode:modes[0]||null,valid:quality,warnings:[]};
  if (!quality) { result.warnings.push('Insufficient, interrupted, or invalid input. Repeat this phase.'); return result; }
  let releaseEvidence;
  if(phase==='release') {
    let at=frames[0].t;const coach=new StickCoach({clock:()=>at,continuous:true});coach.start('release');
    for(const f of frames){at=f.t;coach.feed(f);}releaseEvidence=coach.state().details;
  }
  for (const [side,[x,y]] of Object.entries(AXES)) {
    const radii=frames.map(f=>radius(f,x,y));
    const meanX=frames.reduce((n,f)=>n+f[x],0)/frames.length;
    const meanY=frames.reduce((n,f)=>n+f[y],0)/frames.length;
    const jitter=Math.max(...[x,y].map(a=>{const mean=frames.reduce((n,f)=>n+f[a],0)/frames.length;return Math.sqrt(frames.reduce((n,f)=>n+(f[a]-mean)**2,0)/frames.length);}));
    const base={offsetRaw:round(Math.hypot(meanX-128,meanY-128)),jitterRaw:round(jitter),p99RadiusPercent:round(percentile(radii,.99)*100),peakRadiusPercent:round(Math.max(...radii)*100)};
    if (phase==='rest' || phase==='verify') {
      const stable=percentile(radii,.99)<.35 && jitter<6;
      result[side]={...base,valid:stable,deadzonePercent:stable ? Math.ceil(percentile(radii,.99)*100+1) : null};
      if(!stable) {result.valid=false;result.warnings.push(`${side}: movement or severe drift; repeat hands-off before choosing settings.`);}
    } else if (phase==='range') {
      const sectors=new Set(frames.filter(f=>radius(f,x,y)>=.75).map(f=>Math.floor(((Math.atan2(f[y]-128,f[x]-128)+Math.PI)/(2*Math.PI))*16)%16));
      const limits=Object.fromEntries([x,y].map(a=>[a,{min:Math.min(...frames.map(f=>f[a])),max:Math.max(...frames.map(f=>f[a]))}]));
      result[side]={sectors:sectors.size,totalSectors:16,limits,valid:sectors.size>=14,medianRimRadiusPercent:round(percentile(radii.filter(r=>r>=.75),.5)*100)||null,circularity:circularityFromFrames(frames,x,y)};
      if(sectors.size<14){result.valid=false;result.warnings.push(`${side}: incomplete rim coverage; repeat slow full circles.`);}
    } else if (phase==='release') {
      const evidence=releaseEvidence[side],unsettledReleases=evidence.unsettledReleases;
      result[side]={...evidence,valid:evidence.directions.length===4};
      if(unsettledReleases) result.warnings.push(`${side}: ${unsettledReleases} releases moved beyond 35% after return; inspect technique or snapback before keeping settings.`);
      if(!result[side].valid){result.valid=false;result.warnings.push(`${side}: need clear flick-and-release events in all four directions.`);}
    } else result[side]=base;
  }
  if(phase==='buttons') {
    result.contaminated=frames.some(f=>Object.values(AXES).some(([x,y])=>radius(f,x,y)>.12));
    if(result.contaminated){result.valid=false;result.warnings.push('Stick movement detected. Repeat this button phase with thumbs clear of both sticks.');}
    result.triggers=Object.fromEntries(['l2','r2'].map(axis=>{
      const values=frames.map(f=>f[axis]).filter(Number.isFinite);
      return [axis,values.length?{min:Math.min(...values),max:Math.max(...values)}:null];
    }));
    let presses=0;let previous=frames[0].buttons||0;const seen=new Set();
    for(const f of frames.slice(1)) { const current=f.buttons||0;let rising=current & ~previous;for(let b=0;b<15;b++) if(rising & (1<<b)){presses++;seen.add(b);}previous=current; }
    result.presses=presses;result.distinctButtons=seen.size;
    if(presses<8){result.valid=false;result.warnings.push('Need at least eight button presses. Held buttons do not count.');}
  }
  return result;
}

export class SessionStore {
  constructor(root = process.env.DUALSENSE_SESSION_DIR || fileURLToPath(new URL('../sessions',import.meta.url))) { this.root=resolve(root);mkdirSync(this.root,{recursive:true}); }
  dir(id) {if(!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid session id'); return join(this.root,id);}
  get(id) {return JSON.parse(readFileSync(join(this.dir(id),'session.json'),'utf8'));}
  save(s) {const dest=join(this.dir(s.id),'session.json');const temp=dest+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(s,null,2));renameSync(temp,dest);}
  list() {return readdirSync(this.root).filter(id=>/^[0-9a-f-]{36}$/.test(id)).map(id=>{const s=this.get(id);return {id,created:s.created,captures:s.captures.length,goal:s.goal};}).sort((a,b)=>b.created.localeCompare(a.created));}
  start(controller,goal='Best measured stick center, range and smallest practical radial deadzone') {
    const s={id:randomUUID(),created:new Date().toISOString(),controller,goal,captures:[]};mkdirSync(this.dir(s.id));this.save(s);this.log(s);
    return {...s,logPath:join(this.dir(s.id),'summary.md'),next:{phase:'rest',instruction:PHASES.rest,seconds:5,waitForReady:true}};
  }
  record(id,phase,frames,controller,note='',expectedMs) {
    const lock=join(this.dir(id),'.lock');mkdirSync(lock);
    try {
      const s=this.get(id);
      const same=s.controller.productId===controller.productId && (s.controller.serialNumber ? s.controller.serialNumber===controller.serialNumber : s.controller.path===controller.path);
      if(!same) throw Error('Different controller: start a new session.');
      const metrics=analyzePhase(phase,frames,expectedMs);
      const capture={number:s.captures.length+1,at:new Date().toISOString(),phase,note,metrics};
      writeFileSync(join(this.dir(id),`capture-${capture.number}.json`),JSON.stringify({controller,...capture,frames}));
      s.captures.push(capture);this.save(s);this.log(s);
      const order=Object.keys(PHASES);const nextPhase=metrics.valid?order[order.indexOf(phase)+1]:phase;
      return {id,...capture,logPath:join(this.dir(id),'summary.md'),next:nextPhase?{phase:nextPhase,instruction:PHASES[nextPhase],seconds:DEFAULT_SECONDS[nextPhase],waitForReady:true}:null};
    } finally {rmSync(lock,{recursive:true});}
  }
  report(id) {
    const s=this.get(id);const rests=s.captures.filter(c=>(c.phase==='rest'||c.phase==='verify')&&c.metrics.valid);
    const first=rests[0],last=rests.at(-1);const sameMode=first?.metrics.mode===last?.metrics.mode;
    const latest=Object.fromEntries(Object.keys(PHASES).map(p=>[p,s.captures.filter(c=>c.phase===p).at(-1)]));
    const complete=Object.values(latest).every(c=>c?.metrics.valid) && Object.entries(latest).every(([p,c])=>p==='verify'||c.number<latest.verify.number) && new Set(Object.values(latest).map(c=>c?.metrics.mode)).size===1;
    const finalRest=s.captures.filter(c=>c.phase==='rest'||c.phase==='verify').at(-1);
    const deadzones=finalRest?.metrics.valid?{left:finalRest.metrics.left.deadzonePercent,right:finalRest.metrics.right.deadzonePercent}:null;
    return {...s,complete,logPath:join(this.dir(id),'summary.md'),recommendation:{radialDeadzonePercent:deadzones,applied:false,note:`Measured p99 rest radius + 1 percentage point. Candidate for game settings; verify in play. No controller calibration has been written.`,nextAction:!complete?'Repeat missing/invalid phases before deciding.':'Review measured center and circularity; game deadzones are separate settings. On-controller changes need verified before/after measurements.'},comparison:rests.length>1&&sameMode?{leftOffsetDeltaRaw:round(last.metrics.left.offsetRaw-first.metrics.left.offsetRaw),rightOffsetDeltaRaw:round(last.metrics.right.offsetRaw-first.metrics.right.offsetRaw),leftJitterDeltaRaw:round(last.metrics.left.jitterRaw-first.metrics.left.jitterRaw),rightJitterDeltaRaw:round(last.metrics.right.jitterRaw-first.metrics.right.jitterRaw),note:'Last valid rest minus first valid rest; negative is less measured offset/noise. No causal improvement claim.'}:null};
  }
  log(s) {
    const lines=[`# Stick session ${s.id}`,s.goal,`Started ${s.created}`,'Controller writes: none. Settings applied: none.',''];
    for(const c of s.captures){const m=c.metrics;lines.push(`${c.number}. ${c.phase}: ${m.valid?'valid':'REPEAT'}; ${m.samples} samples, ${(m.durationMs/1000).toFixed(1)}s${c.note?`; ${c.note.replace(/[\r\n]/g,' ')}`:''}`);if(m.left)lines.push(`   Left ${JSON.stringify(m.left)}; right ${JSON.stringify(m.right)}`);for(const w of m.warnings)lines.push(`   ${w}`);}
    writeFileSync(join(this.dir(s.id),'summary.md'),lines.join('\n')+'\n');
  }
}
