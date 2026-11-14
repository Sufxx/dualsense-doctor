// Fast protocol progress plus bounded, structured text-client logging.
export function coachingNotifications(server,extra,{clock=()=>performance.now()}={}) {
  let lastLog=-Infinity,progress=0;
  return async event=>{
    const token=extra._meta?.progressToken;
    if(token!==undefined&&Number.isFinite(event.progress)) {
      progress=Math.max(progress,Math.round(event.progress*100));
      await extra.sendNotification({method:'notifications/progress',params:{progressToken:token,progress,total:100,message:event.message}});
    }
    const now=clock();
    if(event.type!=='progress'||now-lastLog>=1000) {
      if(event.type==='progress')lastLog=now;
      await server.sendLoggingMessage({level:event.type==='correction'?'warning':'info',logger:'dualsense-coach',data:event});
    }
  };
}
