// Pure comparison of saved measurement evidence. No device access or settings writes.
const PHASES=['rest','range','release','buttons','verify'];
const QUIET_PHASES=new Set(['rest','buttons','verify']);
const MODES=new Set(['usb','bt','bt-compat']);
const SIDES=['left','right'];
const round=value=>Math.round(value*100)/100;
const percent=value=>Number.isFinite(value)&&value>=0&&value<=150;
const NOTE='Suggested starting radial deadzone = worst observed clean rest/button/verification peak + 1 percentage point, rounded up. It is not a guaranteed minimum or a guarantee against future drift. Game scales differ; verify in play. Repeatability assumes unchanged controller calibration and setup. Repeating measurements does not tune firmware.';

function identity(controller) {
  if(!controller||!Number.isInteger(controller.productId))return null;
  const serial=typeof controller.serialNumber==='string'&&controller.serialNumber.trim();
  const path=typeof controller.path==='string'&&controller.path.trim();
  return serial?{productId:controller.productId,kind:'serial',value:serial}:path?{productId:controller.productId,kind:'path',value:path}:null;
}
function quality(metrics) {
  return metrics?.valid===true&&MODES.has(metrics.mode)&&Number.isInteger(metrics.samples)&&metrics.samples>=50
    &&Number.isFinite(metrics.durationMs)&&metrics.durationMs>=1000&&Number.isFinite(metrics.maxGapMs)&&metrics.maxGapMs>=0&&metrics.maxGapMs<=250;
}
function inspect(report) {
  if(!report||report.complete!==true||!Array.isArray(report.captures))return {reason:'Round is incomplete. Finish every phase and final verification.'};
  if(typeof report.id!=='string'||!report.id.trim())return {reason:'Round identifier is missing. Reload a saved session before comparing.'};
  const controller=identity(report.controller);
  if(!controller)return {reason:'Controller identity is missing. Start a fresh identified session.'};
  const actions=report.calibrationActions??[];
  if(!Array.isArray(actions)||actions.some(a=>!a||typeof a.at!=='string'||!a.at))return {reason:'Calibration history is unclear. Start a fresh comparison.'};
  const epoch=actions.length;
  const captures=report.captures.filter(c=>c&&(c.calibrationEpoch??0)===epoch&&PHASES.includes(c.phase));
  if(captures.some(c=>!Number.isInteger(c.number)||c.number<1)||new Set(captures.map(c=>c.number)).size!==captures.length)return {reason:'Capture order is invalid. Repeat this round.'};
  const latest=Object.fromEntries(PHASES.map(phase=>[phase,captures.filter(c=>c.phase===phase).sort((a,b)=>a.number-b.number).at(-1)]));
  if(PHASES.some(phase=>!quality(latest[phase]?.metrics)))return {reason:'A required phase is missing, invalid or from an earlier calibration state. Repeat this round.'};
  if(PHASES.some(phase=>phase!=='verify'&&latest[phase].number>=latest.verify.number))return {reason:'Final verification must follow every measured phase.'};
  const mode=latest.verify.metrics.mode;
  if(PHASES.some(phase=>latest[phase].metrics.mode!==mode))return {reason:'Transport changed within this round. Repeat using one connection type.'};
  if(['rest','range','release','verify'].some(phase=>SIDES.some(side=>latest[phase].metrics[side]?.valid!==true)))return {reason:'A stick phase did not pass its evidence checks. Repeat this round.'};
  // Retain all valid quiet evidence in this epoch, not only the most favorable repeat.
  const quiet=captures.filter(c=>QUIET_PHASES.has(c.phase)&&c.number<=latest.verify.number&&c.metrics?.valid===true);
  for(const capture of quiet) {
    const m=capture.metrics;
    if(!quality(m)||m.mode!==mode)return {reason:'Quiet captures have inconsistent input quality or transport. Repeat this round.'};
    if(capture.phase==='buttons'&&m.contaminated===true)return {reason:'Button capture contains stick movement. Repeat with thumbs clear.'};
    for(const side of SIDES) {
      const value=m[side];
      if(!value||!percent(value.peakRadiusPercent)||!percent(value.p99RadiusPercent)||value.p99RadiusPercent>value.peakRadiusPercent
        ||(capture.phase!=='buttons'&&value.valid!==true))return {reason:'Quiet displacement evidence is missing or invalid. Repeat this round.'};
      if(capture.phase==='buttons'&&value.peakRadiusPercent>12)return {reason:'Button capture contains stick movement. Repeat with thumbs clear.'};
    }
  }
  // Comparing full histories is deliberately conservative; equal action counts do
  // not establish equal calibration. This internal signature is never returned.
  let calibration;
  try{calibration=JSON.stringify(actions);}catch{return {reason:'Calibration history is invalid. Start a fresh comparison.'};}
  return {controller,mode,calibration,quiet,range:latest.range.metrics,release:latest.release.metrics};
}
function summarizeSide(rounds,side) {
  const peaks=rounds.map(r=>Math.max(...r.quiet.map(c=>c.metrics[side].peakRadiusPercent)));
  const observedPeakPercent=round(Math.max(...peaks));
  // This conservative review ceiling is an empirical guard, not a hardware limit.
  const suggested=Math.ceil(observedPeakPercent+1),reliable=suggested<=20;
  const circularities=rounds.map(r=>{
    const c=r.range[side]?.circularity;
    return c?.coveredSectors===48&&c.totalSectors===48&&percent(c.errorPercent)?c:null;
  });
  const full=circularities.filter(Boolean),symmetry=full.map(c=>c.maxOppositeDifferencePercent).filter(percent);
  const releasePeaks=rounds.map(r=>r.release[side]?.postReturnPeakPercent).filter(percent);
  return {
    suggestedDeadzonePercent:reliable?suggested:null,observedPeakPercent,
    worstP99Percent:round(Math.max(...rounds.flatMap(r=>r.quiet.map(c=>c.metrics[side].p99RadiusPercent)))),
    roundSpreadPercent:round(Math.max(...peaks)-Math.min(...peaks)),reliable,
    reason:reliable?null:'Observed quiet movement needs a clean repeat or inspection before suggesting a deadzone above 20%.',
    circularity:full.length?{min:Math.min(...full.map(c=>c.errorPercent)),max:Math.max(...full.map(c=>c.errorPercent)),latest:circularities.at(-1)?.errorPercent??null,rounds:full.length,maxOppositeDifferencePercent:symmetry.length?Math.max(...symmetry):null}:null,
    releasePostReturnPeakPercent:releasePeaks.length?round(Math.max(...releasePeaks)):null,
  };
}

export function compareSessionReports(reports) {
  if(!Array.isArray(reports))throw new TypeError('Session reports must be an array.');
  if(reports.length>10)throw new RangeError('Compare at most ten session reports at once.');
  const result={acceptedRounds:0,excludedRounds:reports.length,comparable:false,reason:null,left:null,right:null,applied:false,note:NOTE,exclusions:[]};
  const seen=new Set(),accepted=[];
  reports.forEach((report,index)=>{
    const key=typeof report?.id==='string'&&report.id?report.id:report;
    if(seen.has(key)){result.exclusions.push({round:index+1,reason:'Duplicate round was not counted again.'});return;}
    seen.add(key);
    const evidence=inspect(report);
    if(evidence.reason)result.exclusions.push({round:index+1,reason:evidence.reason});
    else accepted.push(evidence);
  });
  if(!accepted.length){result.reason='No complete, valid round is available. Finish a clean check before comparing.';return result;}
  const first=accepted[0];
  if(accepted.some(r=>JSON.stringify(r.controller)!==JSON.stringify(first.controller))){result.reason='Select rounds from the same identifiable controller; these identities cannot be matched.';return result;}
  if(accepted.some(r=>r.mode!==first.mode)){result.reason='Select rounds using the same transport. USB and Bluetooth results are not pooled.';return result;}
  if(accepted.some(r=>r.calibration!==first.calibration)){result.reason='Calibration history differs. Start a new series after changing calibration.';return result;}
  result.acceptedRounds=accepted.length;result.excludedRounds=reports.length-accepted.length;result.comparable=true;
  for(const side of SIDES)result[side]=summarizeSide(accepted,side);
  result.reason=SIDES.some(side=>!result[side].reliable)?'Some quiet movement is too large for a reliable starting recommendation. Repeat the affected checks.':result.excludedRounds?'Only complete, valid rounds were compared; excluded rounds need a repeat.':null;
  return result;
}
