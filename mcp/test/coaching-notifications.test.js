import test from 'node:test';
import assert from 'node:assert/strict';
import {coachingNotifications} from '../coaching-notifications.js';
test('logging-only clients receive bounded progress and warning resolution with per-stick detail',async()=>{
  let now=0;const logs=[];
  const notify=coachingNotifications({sendLoggingMessage:async e=>logs.push(e)},{},{clock:()=>now});
  await notify({type:'correction',message:'Slow down',warning:'Slow down'});
  for(now=0;now<=2000;now+=100)await notify({type:'progress',progress:now/2000,message:now?'Good pace':'Slow down',warning:now?null:'Slow down',details:{left:{cueCode:now?'keep_going':'too_fast'}}});
  assert.equal(logs.length,4);assert.equal(logs.at(-1).data.warning,null);assert.equal(logs.at(-1).data.details.left.cueCode,'keep_going');
});
test('progress-token clients receive frequent monotonic progress without frequent logs',async()=>{
  let now=0;const logs=[],notifications=[];
  const notify=coachingNotifications({sendLoggingMessage:async e=>logs.push(e)},{_meta:{progressToken:0},sendNotification:async e=>notifications.push(e)},{clock:()=>now});
  for(const value of [.2,.3,.1]){await notify({type:'progress',progress:value,message:'Continue'});now+=100;}
  assert.deepEqual(notifications.map(n=>n.params.progress),[20,30,30]);assert.equal(notifications[0].params.progressToken,0);assert.equal(logs.length,1);
});
