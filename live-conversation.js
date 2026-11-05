'use strict';
// Speech handling reads actual received turns immediately. Durable writes remain
// ordered on the existing mutation queue and are still flushed at call end.
function createLiveConversation(initial=[]){
 const turns=[],seen=new Set();
 function append(role,text,eventId,at=new Date().toISOString()){
  const words=String(text||'').trim().slice(0,12000);
  if(!words||!['client','daisy'].includes(role)||eventId&&seen.has(eventId))return;
  if(eventId)seen.add(eventId);
  turns.push({role,text:words,...(eventId?{event_id:eventId}:{}),at});
  if(turns.length>1000){const removed=turns.shift();if(removed.event_id)seen.delete(removed.event_id);}
 }
 for(const t of initial||[])append(t.role,t.text,t.event_id,t.at);
 return {append,snapshot:()=>turns.map(t=>({...t}))};
}
module.exports={createLiveConversation};
