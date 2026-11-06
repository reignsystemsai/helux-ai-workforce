'use strict';
const SILENCE_LIMIT_MS=60000;
// Activity means detected customer speech or Daisy audio, never silent RTP packets.
function createSilenceWatchdog({onTimeout,setTimer=setTimeout,clearTimer=clearTimeout,limitMs=SILENCE_LIMIT_MS}){
 let timer=null,stopped=false;
 function stop(){stopped=true;clearTimer(timer);timer=null;}
 function activity(){if(stopped)return;clearTimer(timer);timer=setTimer(()=>{if(stopped)return;stop();return onTimeout();},limitMs);timer?.unref?.();}
 activity();return {activity,stop};
}
module.exports={createSilenceWatchdog,SILENCE_LIMIT_MS};
