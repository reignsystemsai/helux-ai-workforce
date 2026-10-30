'use strict';
const {randomBytes}=require('node:crypto');
const ENDED=new Set(['completed','failed','canceled','busy','no-answer']);
// Listen-only copies of the existing media stream. No microphone, call controls,
// recording changes, provider tokens, or historical audio are exposed.
function registerCallMonitor({app,authenticateHelux,WebSocket,get,ready,publicBaseUrl,now=()=>Date.now()}){
 const wss=new WebSocket.WebSocketServer({noServer:true}),tickets=new Map(),listeners=new Map();
 const allowed=new Set(['https://www.dpahelpcenter.com','https://dpahelpcenter.com']);
 const send=(ws,data)=>{if(ws.readyState===1){if(ws.bufferedAmount>256000){ws.close(1008,'Listener connection too slow');return;}ws.send(JSON.stringify(data));}};
 app.post('/api/v1/manager/calls/:id/listen',authenticateHelux,async(req,res)=>{try{
  await ready();const c=await get(req.params.id),owner=String(req.body?.owner_id||'');
  if(!c||!owner||c.payload?.requested_by!==owner)return res.status(404).json({error:'Call not found'});
  if(ENDED.has(c.status)||now()-Date.parse(c.created_at)>600000)return res.status(409).json({error:'This call is no longer live'});
  for(const [key,t]of tickets)if(t.expires<now())tickets.delete(key);
  if(tickets.size>=200)return res.status(429).json({error:'Too many listener requests'});
  const token=randomBytes(32).toString('hex');tickets.set(token,{id:c.action_id,owner,expires:now()+60000});
  res.set('Cache-Control','no-store').json({ok:true,token,action_id:c.action_id,websocket_url:publicBaseUrl.replace(/^http/,'ws')+'/api/v1/manager/listen'});
 }catch{res.status(503).json({error:'Live listening is temporarily unavailable'});}});
 wss.on('connection',ws=>{let id=null,authorized=false;const authTimer=setTimeout(()=>ws.close(1008,'Listener authorization required'),10000),limit=setTimeout(()=>ws.close(1000,'Listener time limit'),420000);
  ws.on('message',async raw=>{try{
   if(authorized){ws.close(1008,'Listen-only connection');return;}
   const e=JSON.parse(raw),t=tickets.get(e.token);if(e.event!=='authorize'||!t||t.expires<now()||t.id!==e.action_id){ws.close(1008,'Invalid listener ticket');return;}
   tickets.delete(e.token);const c=await get(t.id);if(ws.readyState!==1)return;if(!c||c.payload?.requested_by!==t.owner||ENDED.has(c.status)){ws.close(1008,'Call no longer live');return;}
   authorized=true;id=t.id;clearTimeout(authTimer);if(!listeners.has(id))listeners.set(id,new Set());if(listeners.get(id).size>=3){ws.close(1008,'Listener limit');return;}listeners.get(id).add(ws);send(ws,{event:'ready',action_id:id});
  }catch{ws.close(1008,'Invalid listener message');}});
  const cleanup=()=>{clearTimeout(authTimer);clearTimeout(limit);if(id){listeners.get(id)?.delete(ws);if(!listeners.get(id)?.size)listeners.delete(id);}};ws.on('close',cleanup);ws.on('error',cleanup);
 });
 return {
  publish(id,event){for(const ws of listeners.get(id)||[])send(ws,event);},
  ended(id){for(const ws of listeners.get(id)||[]){send(ws,{event:'ended'});ws.close(1000,'Call ended');}listeners.delete(id);},
  handleUpgrade(req,socket,head){if(new URL(req.url,'http://localhost').pathname!=='/api/v1/manager/listen')return false;if(!allowed.has(req.headers?.origin)){socket.destroy?.();return true;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));return true;}
 };
}
module.exports={registerCallMonitor};
