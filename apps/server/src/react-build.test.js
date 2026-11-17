import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from './app.js';
import {DESIGN_SPEC_VERSION} from '@dylani/design-spec';

const gatewayKey='never-forward-this-test-key';
const designSpec={
  schemaVersion:DESIGN_SPEC_VERSION,platform:'web',pageType:'dashboard',requirements:['Show a metrics dashboard'],
  layout:{kind:'two-column',density:'comfortable'},
  tokens:{color:{brand:'#7966f5',background:'#0e1018',surface:'#191c28',foreground:'#f8f9ff',muted:'#a4a8bf'},radius:{card:'18px',button:'12px'},spacing:{section:'32px'}},
  components:[{id:'hero',type:'hero',title:'Dashboard',children:[{id:'metric',type:'metric',label:'Revenue',value:'$100'}]}],
  responsive:{mobile:'stack',desktop:'two-column'},selectedSkills:['typography','layout','responsive','accessibility']
};

test('build route validates DesignSpec then compiles a server-generated fixed project without provider credentials',async t=>{
  let received;
  const runner={async build(files){received=files;return {status:'built',exitCode:0,logs:'isolated test build',previewUrl:'http://127.0.0.2:4173/0123456789abcdef0123456789abcdef/index.html'};}};
  const app=createApp({reactRunner:runner});
  t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:'/api/build-react',payload:{designSpec}});
  assert.equal(response.statusCode,200);
  assert.equal(response.json().status,'built');
  assert.equal(response.json().sourceOnly,false);
  assert.equal(response.json().exitCode,0);
  assert.match(response.json().previewUrl,/^http:\/\/127\.0\.0\.2:/);
  assert.ok(received.some(file=>file.path==='src/App.tsx'));
  assert.doesNotMatch(JSON.stringify(received),new RegExp(gatewayKey));
  assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
});

test('invalid DesignSpec receives safe validation errors without invoking the runner',async t=>{
  let called=false;
  const app=createApp({reactRunner:{async build(){called=true;throw new Error('must not run');}}});
  t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:'/api/build-react',payload:{designSpec:{...designSpec,schemaVersion:'99.0',credential:gatewayKey}}});
  assert.equal(response.statusCode,422);
  assert.deepEqual(response.json().error,'Invalid DesignSpec');
  assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
  assert.equal(called,false);
});

test('an unavailable isolation runner preserves source-only export behavior',async t=>{
  const app=createApp({reactRunner:{async build(){return {status:'unavailable'};}}});
  t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:'/api/build-react',payload:{designSpec}});
  assert.equal(response.statusCode,503);
  assert.equal(response.json().sourceOnly,true);
  assert.equal(response.json().previewUrl,undefined);
  assert.doesNotMatch(response.payload,/token|secret|credential/i);
});

test('build failure details are returned as bounded safe diagnostics',async t=>{
  const app=createApp({reactRunner:{async build(){return {status:'failed',exitCode:1,logs:'src/App.tsx:1:1:TypeScript validation failed',errors:[{file:'src/App.tsx',line:1,message:'TypeScript validation failed (TS1109)'}]};}}});
  t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:'/api/build-react',payload:{designSpec}});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.json().errors,[{file:'src/App.tsx',line:1,message:'TypeScript validation failed (TS1109)'}]);
  assert.doesNotMatch(response.payload,new RegExp(gatewayKey));
});
