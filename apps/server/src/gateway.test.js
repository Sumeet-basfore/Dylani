import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {Writable} from 'node:stream';
import {createApp} from './app.js';
import {DESIGN_SPEC_VERSION} from '@dylani/design-spec';

const gatewayKey='unit-test-only-gateway-key';
const generationRequest={
  prompt:'A simple analytics dashboard',platform:'web',stack:'react-vite',mode:'optimized',model:'test-model',apiKey:gatewayKey
};

async function startGateway(handler) {
  const requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];
    for await (const chunk of req) chunks.push(chunk);
    const request={method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString()};
    requests.push(request);
    await handler(req,res,request);
  });
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const address=server.address();
  return {
    server,requests,baseURL:`http://127.0.0.1:${address.port}/v1`,
    async close(){
      server.closeAllConnections();
      await new Promise(resolve=>server.close(resolve));
    }
  };
}

async function createHarness(t,handler,{modelsTimeoutMs=2_000,generateTimeoutMs=2_000,logger=false,baseURL}={}) {
  const gateway=handler ? await startGateway(handler) : null;
  const logLines=[];
  const loggerConfig=logger ? {level:'trace',stream:new Writable({write(chunk,_encoding,callback){logLines.push(chunk.toString());callback();}})} : false;
  const app=createApp({
    baseURL:baseURL||gateway?.baseURL||'http://127.0.0.1:1/v1',
    modelsTimeoutMs,generateTimeoutMs,logger:loggerConfig
  });
  t.after(async()=>{
    await app.close();
    if (gateway) await gateway.close();
  });
  return {app,gateway,logLines};
}

const modelsResponse=()=>({data:[{id:'test-model'},{id:'another-model'}]});
const completionResponse=()=>({
  model:'served-test-model',
  choices:[{message:{content:'<!doctype html><html><head><style>body{color:#123456}</style></head><body><h1>Ready</h1></body></html>'}}],
  usage:{prompt_tokens:21,completion_tokens:34,total_tokens:55}
});
const defaultTokens={
  color:{brand:'#7966f5',background:'#0e1018',surface:'#191c28',foreground:'#f8f9ff',muted:'#a4a8bf'},
  radius:{card:'18px',button:'12px'},spacing:{section:'32px'}
};
function validDesignSpec(overrides={}) {
  return {
    schemaVersion:DESIGN_SPEC_VERSION,platform:'web',pageType:'dashboard',
    requirements:['Show a simple analytics dashboard'],
    layout:{kind:'sidebar',density:'comfortable'},tokens:defaultTokens,
    components:[{id:'overview',type:'hero',title:'Project overview',children:[{id:'revenue',type:'metric',label:'Revenue',value:'$12,400'}]}],
    responsive:{mobile:'stack',desktop:'sidebar'},
    selectedSkills:['typography','layout','responsive','accessibility'],
    ...overrides
  };
}
const sendJSON=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};

test('model discovery uses the OpenAI-compatible GET path and forwards the gateway key only upstream',async t=>{
  const {app,gateway}=await createHarness(t,(_req,res)=>sendJSON(res,200,modelsResponse()));
  const response=await app.inject({method:'POST',url:'/api/models',payload:{apiKey:gatewayKey}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json(),{models:['test-model','another-model']});
  assert.equal(gateway.requests[0].method,'GET');
  assert.equal(gateway.requests[0].url,'/v1/models');
  assert.equal(gateway.requests[0].headers.authorization,`Bearer ${gatewayKey}`);
  assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
});

test('generation uses the OpenAI-compatible chat completion contract and returns safe preview HTML',async t=>{
  const {app,gateway}=await createHarness(t,(_req,res)=>sendJSON(res,200,completionResponse()));
  const response=await app.inject({method:'POST',url:'/api/generate',payload:generationRequest});
  assert.equal(response.statusCode,200);
  assert.equal(gateway.requests[0].method,'POST');
  assert.equal(gateway.requests[0].url,'/v1/chat/completions');
  assert.equal(gateway.requests[0].headers.authorization,`Bearer ${gatewayKey}`);
  const sent=JSON.parse(gateway.requests[0].body);
  assert.equal(sent.model,'test-model');
  assert.equal(sent.stream,false);
  assert.equal(sent.messages[0].role,'user');
  assert.match(sent.messages[0].content,/A simple analytics dashboard/);
  assert.equal(response.json().model,'served-test-model');
  assert.deepEqual(response.json().usage,{prompt_tokens:21,completion_tokens:34});
  assert.match(response.json().html,/Content-Security-Policy/);
  assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
});

for (const status of [401,429,500]) {
  test(`HTTP ${status} failures return the same safe API error for discovery and generation`,async t=>{
    const {app,logLines}=await createHarness(t,(_req,res)=>sendJSON(res,status,{error:`upstream failure ${gatewayKey}`}),{logger:true});
    for (const request of [
      {method:'POST',url:'/api/models',payload:{apiKey:gatewayKey}},
      {method:'POST',url:'/api/generate',payload:generationRequest}
    ]) {
      const response=await app.inject(request);
      assert.equal(response.statusCode,502);
      assert.deepEqual(response.json(),{error:'FreeLLMAPI request failed'});
      assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
    }
    assert.doesNotMatch(logLines.join(''),new RegExp(gatewayKey));
  });
}

test('malformed gateway JSON and OpenAI payloads return safe invalid-response errors',async t=>{
  let current='malformed-json';
  const {app}=await createHarness(t,(_req,res)=>{
    if (current==='malformed-json') {res.writeHead(200,{'content-type':'application/json'});res.end(`{"error":"${gatewayKey}"`);return;}
    sendJSON(res,200,current==='models-shape'?{items:[]}:{choices:[{message:{content:''}}]});
  });
  for (const payload of [
    {method:'POST',url:'/api/models',payload:{apiKey:gatewayKey}},
    {method:'POST',url:'/api/generate',payload:generationRequest}
  ]) {
    const response=await app.inject(payload);
    assert.equal(response.statusCode,502);
    assert.deepEqual(response.json(),{error:'FreeLLMAPI returned an invalid response'});
    assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
  }
  current='models-shape';
  const badModels=await app.inject({method:'POST',url:'/api/models',payload:{apiKey:gatewayKey}});
  assert.equal(badModels.statusCode,502);
  assert.deepEqual(badModels.json(),{error:'FreeLLMAPI returned an invalid response'});
  current='empty-completion';
  const badCompletion=await app.inject({method:'POST',url:'/api/generate',payload:generationRequest});
  assert.equal(badCompletion.statusCode,502);
  assert.deepEqual(badCompletion.json(),{error:'FreeLLMAPI returned an invalid response'});
});

test('unavailable gateway returns safe failures without leaking connection details',async t=>{
  const {app}=await createHarness(t,null,{baseURL:'http://127.0.0.1:1/v1'});
  for (const request of [
    {method:'POST',url:'/api/models',payload:{apiKey:gatewayKey}},
    {method:'POST',url:'/api/generate',payload:generationRequest}
  ]) {
    const response=await app.inject(request);
    assert.equal(response.statusCode,502);
    assert.deepEqual(response.json(),{error:'FreeLLMAPI request failed'});
    assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
    assert.doesNotMatch(response.payload,/127\.0\.0\.1:1/);
  }
});

test('gateway request timeouts return safe failures for discovery and generation',async t=>{
  const {app}=await createHarness(t,()=>new Promise(()=>{}),{modelsTimeoutMs:20,generateTimeoutMs:20});
  for (const request of [
    {method:'POST',url:'/api/models',payload:{apiKey:gatewayKey}},
    {method:'POST',url:'/api/generate',payload:generationRequest}
  ]) {
    const response=await app.inject(request);
    assert.equal(response.statusCode,502);
    assert.deepEqual(response.json(),{error:'FreeLLMAPI request failed'});
    assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
  }
});

test('gateway credentials never appear in API errors, Fastify logs, or gateway metadata',async t=>{
  const {app,logLines}=await createHarness(t,(_req,res)=>sendJSON(res,200,{
    ...completionResponse(),model:gatewayKey,usage:{prompt_tokens:1,completion_tokens:2,debug:gatewayKey}
  }),{logger:true});
  const response=await app.inject({method:'POST',url:'/api/generate',payload:generationRequest});
  assert.equal(response.statusCode,200);
  assert.equal(response.json().model,'test-model');
  assert.deepEqual(response.json().usage,{prompt_tokens:1,completion_tokens:2});
  assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
  assert.doesNotMatch(logLines.join(''),new RegExp(gatewayKey));
});

test('DesignSpec validation route accepts the current schema and gives path-specific version errors',async t=>{
  const {app}=await createHarness(t,(_req,res)=>sendJSON(res,200,{}));
  const valid=await app.inject({method:'POST',url:'/api/design-spec/validate',payload:validDesignSpec()});
  assert.equal(valid.statusCode,200);
  assert.deepEqual(valid.json(),{valid:true,schemaVersion:DESIGN_SPEC_VERSION});
  const invalid=await app.inject({method:'POST',url:'/api/design-spec/validate',payload:validDesignSpec({schemaVersion:'2.0'})});
  assert.equal(invalid.statusCode,422);
  assert.equal(invalid.json().error,'Invalid DesignSpec');
  assert.ok(invalid.json().details.some(issue=>issue.path==='schemaVersion'));
});

test('React generation validates the model DesignSpec and returns a fixed token-preserving project',async t=>{
  const spec=validDesignSpec();
  const {app,gateway}=await createHarness(t,(_req,res)=>sendJSON(res,200,{
    model:'served-model',choices:[{message:{content:JSON.stringify(spec)}}]
  }));
  const response=await app.inject({method:'POST',url:'/api/generate-react',payload:{...generationRequest,stack:'react-vite'}});
  assert.equal(response.statusCode,200);
  assert.equal(gateway.requests[0].url,'/v1/chat/completions');
  assert.equal(gateway.requests[0].headers.authorization,`Bearer ${gatewayKey}`);
  const request=JSON.parse(gateway.requests[0].body);
  assert.equal(request.stream,false);
  assert.match(request.messages[0].content,/framework-neutral design specification/i);
  assert.equal(response.json().schemaVersion,DESIGN_SPEC_VERSION);
  assert.equal(response.json().designSpec.components[0].title,'Project overview');
  assert.ok(response.json().files.some(file=>file.path==='src/App.tsx'));
  assert.match(response.json().files.find(file=>file.path==='src/index.css').content,/#7966f5/);
  assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
});

test('malformed model JSON and invalid DesignSpec output fail with safe actionable responses',async t=>{
  let content='not-json';
  const {app}=await createHarness(t,(_req,res)=>sendJSON(res,200,{choices:[{message:{content}}]}));
  const payload={...generationRequest,stack:'react-vite'};
  const malformed=await app.inject({method:'POST',url:'/api/generate-react',payload});
  assert.equal(malformed.statusCode,502);
  assert.deepEqual(malformed.json(),{error:'Model returned invalid DesignSpec JSON'});
  content=JSON.stringify(validDesignSpec({schemaVersion:'99.0'}));
  const invalid=await app.inject({method:'POST',url:'/api/generate-react',payload});
  assert.equal(invalid.statusCode,422);
  assert.ok(invalid.json().details.some(issue=>issue.path==='schemaVersion'));
  content=JSON.stringify(validDesignSpec({platform:'mobile'}));
  const unsupported=await app.inject({method:'POST',url:'/api/generate-react',payload});
  assert.equal(unsupported.statusCode,422);
  assert.ok(unsupported.json().details.some(issue=>issue.path==='platform'));
});

test('React generation request rejects mobile target before contacting the gateway',async t=>{
  const {app,gateway}=await createHarness(t,(_req,res)=>sendJSON(res,200,{}));
  const response=await app.inject({method:'POST',url:'/api/generate-react',payload:{...generationRequest,platform:'mobile',stack:'expo'}});
  assert.equal(response.statusCode,400);
  assert.equal(gateway.requests.length,0);
});
