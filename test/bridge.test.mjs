import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { createBridge } from '../bridge.mjs';

async function setup(t,timeoutMs=500) {
  const token='test-token';const bridge=await createBridge({port:0,token,timeoutMs});
  t.after(()=>bridge.close());
  const base=`http://127.0.0.1:${bridge.port}`;
  const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
  async function connect(tokenValue=token,documentId='test-document'){
    const ws=new WebSocket(`ws://127.0.0.1:${bridge.port}/plugin`,{origin:'https://www.figma.com'});
    await once(ws,'open');ws.send(JSON.stringify({type:'hello',token:tokenValue,documentId,name:'Test file',page:'Page 1'}));return ws;
  }
  const command=()=>fetch(`${base}/command`,{method:'POST',headers,body:JSON.stringify({action:'document',targetDocumentId:'test-document'})});
  return {base,headers,connect,command};
}
test('rejects unauthenticated HTTP and browser-origin requests',async t=>{
  const {base,headers}=await setup(t);
  assert.equal((await fetch(`${base}/status`)).status,401);
  assert.equal((await fetch(`${base}/status`,{headers:{...headers,Origin:'https://evil.example'}})).status,401);
  assert.equal((await fetch(`${base}/status`,{headers})).status,200);
});
test('requires a connected plugin and rejects wrong pairing token',async t=>{
  const {command,connect}=await setup(t);
  assert.equal((await command()).status,409);
  const ws=await connect('incorrect');const [code]=await once(ws,'close');assert.equal(code,1008);
});
test('round-trips commands and rejects overlapping writes',async t=>{
  const {base,connect,command}=await setup(t);const ws=await connect();await once(ws,'message');
  const message=once(ws,'message');const response=command();const [raw]=await message;
  const sent=JSON.parse(raw.toString());assert.equal(sent.action,'document');assert.equal(sent.targetDocumentId,'test-document');
  assert.equal((await command()).status,409);
  assert.equal((await fetch(`${base}/shutdown`,{method:'POST'})).status,401);
  ws.send(JSON.stringify({id:sent.id,result:{createdNodeIds:['1:2']}}));
  assert.deepEqual(await (await response).json(),{createdNodeIds:['1:2']});
});
test('a slow overlapping request cannot unlock another active command',async t=>{
  const {base,headers,connect,command}=await setup(t,3000);
  const ws=await connect();await once(ws,'message');
  let complete;
  const slowResponse=new Promise(resolve=>{complete=resolve;});
  const slow=request(`${base}/command`,{method:'POST',headers:{...headers,Expect:'100-continue','Transfer-Encoding':'chunked'}},complete);
  slow.on('error',()=>{});t.after(()=>slow.destroy());
  slow.flushHeaders();await once(slow,'continue');
  const message=once(ws,'message');const active=command();const [raw]=await message;
  slow.end(JSON.stringify({action:'document',targetDocumentId:'test-document'}));
  const rejected=await slowResponse;assert.equal(rejected.statusCode,409);rejected.resume();
  assert.equal((await command()).status,409);
  assert.equal((await fetch(`${base}/shutdown`,{method:'POST',headers})).status,409);
  ws.send(JSON.stringify({id:JSON.parse(raw.toString()).id,result:{ok:true}}));
  assert.equal((await active).status,200);
});
test('an upload finishing after disconnect cannot timeout the replacement plugin',{timeout:5000},async t=>{
  const timeoutMs=300;
  const {base,headers,connect}=await setup(t,timeoutMs);
  const first=await connect();await once(first,'message');
  let complete;
  const slowResponse=new Promise(resolve=>{complete=resolve;});
  const slow=request(`${base}/command`,{method:'POST',headers:{...headers,Expect:'100-continue','Transfer-Encoding':'chunked'}},complete);
  slow.on('error',()=>{});
  try {
    slow.flushHeaders();await once(slow,'continue');
    const closed=once(first,'close');first.close();await closed;
    let connected=true;
    for(let i=0;i<20&&connected;i++){
      connected=(await (await fetch(`${base}/status`,{headers})).json()).connected;
      if(connected)await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(connected,false,'the original plugin has disconnected before upload completion');
    slow.end(JSON.stringify({action:'document',targetDocumentId:'test-document'}));
    const rejected=await slowResponse;rejected.resume();
    const replacement=await connect(undefined,'replacement-document');await once(replacement,'message');
    await new Promise(resolve=>setTimeout(resolve,timeoutMs+100));
    assert.deepEqual({status:rejected.statusCode,readyState:replacement.readyState},{status:409,readyState:WebSocket.OPEN},
      'reject the stale upload without a timer disconnecting the replacement plugin');
    const message=once(replacement,'message');
    const response=fetch(`${base}/command`,{method:'POST',headers,body:JSON.stringify({action:'document',targetDocumentId:'replacement-document'})});
    const [raw]=await message;const sent=JSON.parse(raw.toString());
    assert.equal(sent.targetDocumentId,'replacement-document');
    replacement.send(JSON.stringify({id:sent.id,result:{documentId:'replacement-document'}}));
    assert.deepEqual(await (await response).json(),{documentId:'replacement-document'});
  } finally {slow.destroy();}
});
for(const failure of ['synchronous throw','asynchronous callback error']){
  test(`a send ${failure} releases the command without a delayed disconnect`,{timeout:5000},async t=>{
    const timeoutMs=1000;
    const {base,headers,connect,command}=await setup(t,timeoutMs);
    const ws=await connect();await once(ws,'message');
    const originalSend=WebSocket.prototype.send;
    let failNext=true;
    t.mock.method(WebSocket.prototype,'send',function(data,options,callback){
      if(failNext&&JSON.parse(data).action==='document'){
        failNext=false;
        const error=new Error('Synthetic WebSocket send failure');
        if(failure==='synchronous throw')throw error;
        const done=typeof options==='function'?options:callback;
        setImmediate(()=>done(error));return;
      }
      return originalSend.apply(this,arguments);
    });
    const rejected=await fetch(`${base}/command`,{
      method:'POST',headers,body:JSON.stringify({action:'document',targetDocumentId:'test-document'}),
      signal:AbortSignal.timeout(timeoutMs/2)
    });
    assert.equal(rejected.status,500);
    assert.match((await rejected.json()).error,/Synthetic WebSocket send failure/);
    const status=await (await fetch(`${base}/status`,{headers})).json();
    assert.equal(status.busy,false);assert.equal(status.connected,true);
    await new Promise(resolve=>setTimeout(resolve,timeoutMs+100));
    assert.equal(ws.readyState,WebSocket.OPEN,'a failed send must not leave a timeout that closes the plugin');
    const message=once(ws,'message');const response=command();
    const [raw]=await message;const sent=JSON.parse(raw.toString());
    ws.send(JSON.stringify({id:sent.id,result:{documentId:'test-document'}}));
    assert.deepEqual(await (await response).json(),{documentId:'test-document'});
  });
}
test('authenticated shutdown closes the listener and is idempotent',async t=>{
  const {base,headers}=await setup(t);
  assert.equal((await fetch(`${base}/shutdown`,{method:'POST',headers:{...headers,Origin:'https://evil.example'}})).status,401);
  assert.deepEqual(await (await fetch(`${base}/shutdown`,{method:'POST',headers})).json(),{stopped:true});
});
test('the bridge assigns command IDs rather than trusting client-supplied ones',async t=>{
  const {base,headers,connect}=await setup(t);const ws=await connect();await once(ws,'message');
  const message=once(ws,'message');
  const response=fetch(`${base}/command`,{method:'POST',headers,body:JSON.stringify({id:'caller-supplied',action:'document',targetDocumentId:'test-document'})});
  const [raw]=await message;const sent=JSON.parse(raw.toString());assert.notEqual(sent.id,'caller-supplied');
  ws.send(JSON.stringify({id:sent.id,result:{ok:true}}));assert.equal((await response).status,200);
});
test('does not silently replace the selected Figma connection',async t=>{
  const {connect}=await setup(t);const first=await connect();await once(first,'message');
  const second=await connect();const [code]=await once(second,'close');assert.equal(code,1008);assert.equal(first.readyState,WebSocket.OPEN);
});
test('disconnect rejects pending call instead of hanging',async t=>{
  const {connect,command}=await setup(t);const ws=await connect();await once(ws,'message');
  const message=once(ws,'message');const response=command();await message;ws.close();
  assert.match((await (await response).json()).error,/disconnected/);
});
test('timeout reports uncertain outcome and closes plugin',async t=>{
  const {connect,command}=await setup(t,30);const ws=await connect();await once(ws,'message');
  const closed=once(ws,'close');const response=await command();assert.equal(response.status,500);
  assert.match((await response.json()).error,/may have changed/);assert.equal((await closed)[0],1011);
});
