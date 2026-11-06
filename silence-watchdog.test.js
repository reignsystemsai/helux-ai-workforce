'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const {createSilenceWatchdog}=require('./silence-watchdog');
function fixture(){const timers=[];let ends=0;const watchdog=createSilenceWatchdog({onTimeout:()=>{ends++;},setTimer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimer:t=>{if(t)t.cancelled=true;}});return {watchdog,timers,ends:()=>ends};}
test('one minute of silence ends once; subsequent timers cannot end or redial repeatedly',()=>{const f=fixture();assert.equal(f.timers[0].ms,60000);f.timers[0].fn();f.timers[0].fn();assert.equal(f.ends(),1);f.watchdog.activity();assert.equal(f.timers.length,1);});
test('speech restarts the minute, but incoming silent media does not count as speech',()=>{const f=fixture();f.watchdog.activity();assert.equal(f.timers[0].cancelled,true);assert.equal(f.timers[1].ms,60000);f.timers[1].fn();assert.equal(f.ends(),1);});
test('normal disconnect clears the watchdog',()=>{const f=fixture();f.watchdog.stop();f.timers[0].fn();assert.equal(f.ends(),0);});
