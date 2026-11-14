// Bounded, read-only observations from one saved check. No HID or settings writes.
import { compareSessionReports } from './session-comparison.js';

const SIDES=['left','right'];
const QUIET=new Set(['rest','buttons','verify']);
const AXES={left:['lx','ly'],right:['rx','ry']};
const round=value=>Math.round(value*100)/100;
const NOTE='Read-only observations for the current check; settings are not applied. Center percentages use signed (raw - 128) / 127 * 100. Range percentages describe observed axis extrema during a full rim sweep, using 128 negative steps and 127 positive steps to the electrical endpoints. They do not establish cardinal holds, clipping health, physical travel, or an optimum circularity. Confirm repeatability and compare in game before choosing settings.';

function emptyCenter(captures=0) {return {available:false,captures,x:null,y:null};}
function emptyRange(coveredSectors=null) {
  return {available:false,coveredSectors,totalSectors:48,leftPercent:null,rightPercent:null,upPercent:null,downPercent:null,horizontalDifferencePp:null,verticalDifferencePp:null};
}
function emptyResult() {
  return {available:false,scope:'current_check',sticks:Object.fromEntries(SIDES.map(side=>[side,{center:emptyCenter(),range:emptyRange(),nextStep:'repeat_check'}])),note:NOTE};
}
function validAxis(axis) {
  if(!(axis && ['meanRaw','minRaw','maxRaw'].every(key=>Number.isFinite(axis[key])&&axis[key]>=0&&axis[key]<=255)
    &&Number.isInteger(axis.minRaw)&&Number.isInteger(axis.maxRaw)
    &&axis.minRaw<=axis.meanRaw&&axis.meanRaw<=axis.maxRaw
    &&Number.isFinite(axis.stddevRaw)&&axis.stddevRaw>=0&&axis.stddevRaw<=127.5))return false;
  // Bhatia-Davis: variance <= (max - mean) * (mean - min). The analyzer
  // rounds mean and deviation to .01, so use the most permissive actual mean
  // and smallest actual deviation within their half-step rounding intervals.
  const meanLow=Math.max(axis.minRaw,axis.meanRaw-.005),meanHigh=Math.min(axis.maxRaw,axis.meanRaw+.005);
  const mean=Math.max(meanLow,Math.min(meanHigh,(axis.minRaw+axis.maxRaw)/2));
  const minDeviation=Math.max(0,axis.stddevRaw-.005);
  return minDeviation**2<=(axis.maxRaw-mean)*(mean-axis.minRaw)+1e-9;
}
function summarizeAxis(axes) {
  const min=Math.min(...axes.map(a=>a.minRaw)),max=Math.max(...axes.map(a=>a.maxRaw));
  const direction=min>128?'positive':max<128?'negative':min===128&&max===128?'neutral':'mixed';
  return {meanMinPercent:round((Math.min(...axes.map(a=>a.meanRaw))-128)/127*100),
    meanMaxPercent:round((Math.max(...axes.map(a=>a.meanRaw))-128)/127*100),
    peakToPeakPercent:round((max-min)/127*100),maxStddevPercent:round(Math.max(...axes.map(a=>a.stddevRaw))/127*100),direction};
}
function centerEvidence(quiet,side) {
  if(!quiet.length||quiet.some(c=>!validAxis(c.metrics[side]?.quietAxes?.x)||!validAxis(c.metrics[side]?.quietAxes?.y)))return emptyCenter(quiet.length);
  return {available:true,captures:quiet.length,x:summarizeAxis(quiet.map(c=>c.metrics[side].quietAxes.x)),y:summarizeAxis(quiet.map(c=>c.metrics[side].quietAxes.y))};
}
function rangeEvidence(metrics,side) {
  const value=metrics?.[side],circle=value?.circularity,bins=circle?.sectorRadii;
  const validBins=Array.isArray(bins)&&bins.length===48&&bins.every(r=>Number.isFinite(r)&&r>=0&&r<=1.5);
  const coverage=validBins?bins.filter(r=>r>.2).length:null;
  const missing=emptyRange(coverage);
  if(value?.valid!==true||coverage!==48||circle.coveredSectors!==48||circle.totalSectors!==48)return missing;
  const [x,y]=AXES[side],limits=value.limits;
  const validLimits=axis=>axis&&Number.isInteger(axis.min)&&Number.isInteger(axis.max)&&axis.min>=0&&axis.min<=128&&axis.max>=128&&axis.max<=255;
  if(!validLimits(limits?.[x])||!validLimits(limits?.[y]))return missing;
  // A maximum within a cardinal sector must have at least this component.
  // Match circularityFromFrames' normalized-axis rounding, angular half-bin
  // width, and saved radius rounding. This is a necessary consistency check;
  // it does not establish a straight cardinal hold or universal geometry proof.
  const normalized=raw=>round((raw-127.5)/128);
  const extrema=[normalized(limits[x].max),normalized(limits[y].max),-normalized(limits[x].min),-normalized(limits[y].min)];
  if([0,12,24,36].some((sector,i)=>Math.max(0,bins[sector]-.005)*Math.cos(Math.PI/48)>extrema[i]+1e-9))return missing;
  const left=(128-limits[x].min)/128*100,right=(limits[x].max-128)/127*100;
  const up=(128-limits[y].min)/128*100,down=(limits[y].max-128)/127*100;
  return {available:true,coveredSectors:coverage,totalSectors:48,leftPercent:round(left),rightPercent:round(right),upPercent:round(up),downPercent:round(down),horizontalDifferencePp:round(Math.abs(left-right)),verticalDifferencePp:round(Math.abs(up-down))};
}

export function assessStickTuning(report) {
  const result=emptyResult();
  try {
    // Check the bounds before comparison traverses capture and action histories.
    if(!Array.isArray(report?.captures)||report.captures.length>2048
      ||(report.calibrationActions!=null&&(!Array.isArray(report.calibrationActions)||report.calibrationActions.length>128)))return result;
    if(!compareSessionReports([report]).comparable)return result;
    const epoch=report.calibrationActions?.length||0;
    const current=report.captures.filter(c=>c&&(c.calibrationEpoch??0)===epoch);
    const latest=phase=>current.filter(c=>c.phase===phase).sort((a,b)=>a.number-b.number).at(-1);
    const verify=latest('verify'),range=latest('range');
    const quiet=current.filter(c=>QUIET.has(c.phase)&&c.number<=verify.number&&c.metrics?.valid===true);
    const sticks=Object.fromEntries(SIDES.map(side=>{
      const center=centerEvidence(quiet,side),rangeResult=rangeEvidence(range.metrics,side);
      const persistent=center.available&&[center.x,center.y].some(axis=>axis.direction==='positive'||axis.direction==='negative');
      const nextStep=!center.available?'capture_axis_evidence':!rangeResult.available?'repeat_full_range':persistent?'check_center_repeatability':'review_measurements';
      return [side,{center,range:rangeResult,nextStep}];
    }));
    return {...result,available:true,sticks};
  } catch {
    // Malformed legacy evidence never leaks identifiers or partial conclusions.
    return result;
  }
}
