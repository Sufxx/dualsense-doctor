// Continuous read-only input with responsive coaching. No web server or voice.
import { StickCoach } from './coach.js';
export const RUN_STEPS=[
  {phase:'rest',label:'Hands off both sticks'},
  {phase:'range',direction:'clockwise',label:'Turn both sticks CLOCKWISE along the rim'},
  {phase:'range',direction:'counterclockwise',label:'Now turn COUNTERCLOCKWISE along the rim'},
  {phase:'release',label:'Flick, release fully, and let each stick settle'},
  {phase:'buttons',label:'Press buttons with thumbs clear of the sticks'},
  {phase:'verify',label:'Put the controller down; final hands-off check'},
];
const yieldLoop=()=>new Promise(r=>setImmediate(r));

export async function runGuided(c,store,{onEvent=()=>{},signal,clock=()=>performance.now(),coach=new StickCoach({clock}),prepareMs=3000,steps=RUN_STEPS,existingSession}={}) {
  if(signal?.aborted) throw Error('Guided run cancelled.');
  const session=existingSession?store.get(existingSession):store.start(c.info,'DualSense: data-responsive text coaching; preserve balanced stock-like circularity guidance');
  let rangeFrames=[],rangeStart=null;
  const results=[];
  const emit=async event=>{await onEvent({at:new Date().toISOString(),sessionId:session.id,...event});};
  const checkCancel=()=>{if(signal?.aborted)throw Error('Guided run cancelled; no controller calibration was changed.');};
  async function read() {
    checkCancel();const r=c._readOnce(5);if(r?.s)await yieldLoop();else await new Promise(r=>setTimeout(r,2));return r?.s||null;
  }
  const retried=new Set();
  for(let index=0;index<steps.length;index++) {
    const step=steps[index];
    await emit({type:'instruction',step:index+1,total:steps.length,message:step.label,phase:step.phase,direction:step.direction,countdownSeconds:prepareMs/1000});
    const prepStart=clock();
    while(clock()-prepStart<prepareMs) {
      const f=await read();
      if(f&&rangeStart!==null&&step.phase==='range')rangeFrames.push({t:clock()-rangeStart,...f});
    }
    coach.start(step.phase,{direction:step.direction});
    await emit({type:'phase_start',phase:step.phase,message:step.label});
    const started=clock();let lastInput=started,lastEmit=started,lastWarning='',lastWarningAt=-Infinity;
    let frames=[],lastState;
    if(step.phase==='range'&&rangeStart===null)rangeStart=started;
    let retry=false;
    while(true) {
      const frame=await read(),now=clock();
      if(frame) {
        lastInput=now;const captured={t:now-started,...frame};frames.push(captured);
        if(step.phase==='range')rangeFrames.push({...captured,t:now-rangeStart});
        lastState=coach.feed(captured);
        const warning=lastState.warning||'';
        if(warning&&warning!==lastWarning&&now-lastWarningAt>=1500) {
          await emit({type:'correction',message:warning,phase:step.phase,details:lastState.details,latest:frame});
          lastWarning=warning;lastWarningAt=now;
        }
        if(now-lastEmit>=1000) {
          await emit({type:'progress',phase:step.phase,message:lastState.message,progress:(index+lastState.progress)/steps.length,phaseProgress:lastState.progress,secondsRemaining:lastState.secondsRemaining,latest:frame,details:lastState.details});lastEmit=now;
        }
        if(lastState.complete)break;
        if(lastState.details.contaminated) {
          // Restart the phase once; repeated contamination stops for clarification.
          if(retried.has(index)) return {complete:false,sessionId:session.id,reason:'Button capture repeatedly contaminated',results};
          await emit({type:'correction',message:'Stick movement detected during button presses. Hands off the sticks; restarting this phase in three seconds.',phase:step.phase});
          retried.add(index);retry=true;break;
        }
        if(lastState.details.timedOut) return {complete:false,sessionId:session.id,reason:'Phase did not meet coaching criteria within 30 seconds',lastState,results};
      }
      if(now-lastInput>1000) throw Error('Controller input lost. Capture stopped; reconnect and retry this phase.');
      if(now-started>35000) return {complete:false,sessionId:session.id,reason:'Phase time limit exceeded',lastState,results};
    }
    if(retry){index--;continue;}
    // Range directions form one uninterrupted measurement record.
    if(step.phase!=='range'||step.direction==='counterclockwise') {
      let evidence=step.phase==='range'?rangeFrames:frames;
      if(step.phase==='rest'||step.phase==='verify') {
        const since=evidence.at(-1).t-Math.min(5000,lastState.details.stableMs||5000);
        evidence=evidence.filter(f=>f.t>=since);const base=evidence[0].t;evidence=evidence.map(f=>({...f,t:f.t-base}));
      }
      const record=store.record(session.id,step.phase,evidence,c.info,'Adaptive coaching: criteria met; measurement evidence only.');
      results.push({phase:step.phase,...record});
      if(!record.metrics.valid)return {complete:false,sessionId:session.id,reason:`${step.phase} recording needs a repeat; see logged quality warnings.`,results};
    }
    await emit({type:'phase_complete',message:`${step.label}: evidence captured.`,phase:step.phase,details:lastState?.details});
  }
  const report=store.report(session.id);
  await emit({type:'complete',message:'Measurement sequence finished. No controller calibration or game settings changed.',complete:report.complete,logPath:report.logPath});
  return {complete:report.complete,sessionId:session.id,report,results};
}
