import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {buildVariantPrompt,comparisonHTML,fixtureDesignSpec,loadPrompts,requestDesignSpec,resolveBenchmarkProvider,runBenchmark,summarizeBenchmark,validateReviewRatings,writeBenchmarkReport,BENCHMARK_SETTINGS,BENCHMARK_VIEWPORTS} from '../src/pipeline.mjs';
import {designSpecSchema} from '@dylani/design-spec';

async function mockGateway(handler) {
  const server=createServer(handler);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  return {server,baseURL:`http://127.0.0.1:${address.port}/v1`};
}

function jsonResponse(response,status,value) {
  response.writeHead(status,{'Content-Type':'application/json'});
  response.end(JSON.stringify(value));
}

async function makeWritable(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const entryPath=path.join(directory,entry.name);
    if (entry.isDirectory()) {
      await makeWritable(entryPath);
      await chmod(entryPath,0o700);
    } else await chmod(entryPath,0o600);
  }
  await chmod(directory,0o700);
}

test('version-controlled prompt corpus has 10 prompts across all requested product categories',async()=>{
  const prompts=await loadPrompts();
  assert.equal(prompts.length,10);
  assert.equal(new Set(prompts.map(prompt=>prompt.id)).size,10);
  const counts=Object.fromEntries([...new Set(prompts.map(prompt=>prompt.category))].map(category=>[category,prompts.filter(prompt=>prompt.category===category).length]));
  assert.deepEqual(counts,{'saas-dashboard':3,'landing-page':3,'developer-portfolio':2,'e-commerce':2});
});

test('baseline and optimized prompts retain the same requirements and output contract',async()=>{
  const [prompt]=await loadPrompts();
  const baseline=buildVariantPrompt(prompt,'baseline');
  const optimized=buildVariantPrompt(prompt,'optimized');
  for (const requirement of prompt.requirements) {
    assert.ok(baseline.includes(requirement));
    assert.ok(optimized.includes(requirement));
  }
  assert.match(baseline,/DesignSpec schema version 1\.0/);
  assert.match(baseline,/Layout must be an object with kind exactly/);
  assert.match(baseline,/Responsive mobile must be stack or horizontal-scroll/);
  assert.match(baseline,/Each child must be one of these exact shapes/);
  assert.match(optimized,/schema version 1\.0/);
  assert.deepEqual(BENCHMARK_SETTINGS,{temperature:0.2,max_tokens:4000,stream:false});
  assert.deepEqual(BENCHMARK_VIEWPORTS.map(viewport=>[viewport.width,viewport.height]),[[390,844],[1440,900]]);
});

test('deterministic fixtures validate for both pipeline variants',async()=>{
  const prompts=await loadPrompts();
  for (const prompt of prompts) for (const variant of ['baseline','optimized']) {
    const parsed=designSpecSchema.safeParse(fixtureDesignSpec(prompt,variant));
    assert.equal(parsed.success,true,`${prompt.id}/${variant}`);
    assert.deepEqual(parsed.data.requirements,prompt.requirements);
  }
});

test('DesignSpec rejects the repeated generic child IDs found in the M1.3 outputs',async()=>{
  const [prompt]=await loadPrompts();
  const invalid=fixtureDesignSpec(prompt,'baseline');
  invalid.components[0].children[0].id='text';
  invalid.components.push({id:'second-section',type:'section',title:'Second section',children:[{id:'text',type:'text',text:'Repeated generic ID'}]});
  const result=designSpecSchema.safeParse(invalid);
  assert.equal(result.success,false);
  assert.ok(result.error.issues.some(issue=>issue.path.join('.')==='components'&&issue.message==='Component IDs must be unique'));
});

test('fixture run saves source, diagnostics, a separate blind review package, and no automatic ratings',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'dylani-benchmark-test-'));
  const buildCalls=[];
  const fakeRunner={
    async build(files) { buildCalls.push(files); return {status:'built',exitCode:0,logs:'fixture build',previewUrl:'http://127.0.0.2:41000/fixture/index.html'}; },
    async close() {}
  };
  const capture=async(_url,directory)=>{
    await writeFile(path.join(directory,'desktop.png'),'fixture screenshot',{flag:'wx'});
    await writeFile(path.join(directory,'mobile.png'),'fixture screenshot',{flag:'wx'});
    return {status:'captured',runtimeErrors:[],screenshots:{desktop:'desktop.png',mobile:'mobile.png'},responsive:{mobile:{horizontalOverflow:false}},accessibility:{mobile:{unlabeledInputs:0}}};
  };
  try {
    const result=await runBenchmark({outputRoot:root,promptIds:['saas-01-operations-dashboard'],fixture:true,buildRunner:fakeRunner,capture});
    assert.equal(buildCalls.length,2);
    assert.equal(result.manifest.results[0].variants.length,2);
    assert.deepEqual(result.manifest.results[0].variants.map(item=>item.generation.requestCount),[0,0]);
    assert.equal(result.manifest.results[0].variants.every(item=>item.build.status==='built'),true);
    assert.equal(result.manifest.results[0].variants.every(item=>item.screenshots.desktop&&item.screenshots.mobile),true);
    assert.equal(result.manifest.results[0].reviewOrder.length,2);
    assert.equal(result.manifest.results[0].variants.every(item=>item.generation.modelVerified),true);
    assert.equal(result.manifest.metrics.totals.inferenceRequests,0);
    assert.equal(result.manifest.metrics.reviewablePromptCount,1);
    assert.match(result.manifest.sourceDigests.promptCorpus,/^[a-f0-9]{64}$/);
    assert.match(result.manifest.results[0].variants[0].promptHash,/^[a-f0-9]{64}$/);
    assert.notEqual(result.manifest.results[0].variants[0].promptHash,result.manifest.results[0].variants[1].promptHash);
    const saved=JSON.parse(await readFile(path.join(result.runDirectory,'run.json'),'utf8'));
    assert.equal((await stat(path.join(result.runDirectory,'run.json'))).mode&0o222,0);
    assert.equal((await stat(result.runDirectory)).mode&0o222,0);
    assert.deepEqual(saved,result.manifest);
    const report=await readFile(result.reportPath,'utf8');
    assert.match(report,/Candidate A/);
    assert.match(report,/Candidate B/);
    assert.doesNotMatch(report,/baseline|optimized|fixture-v1/i);
    assert.match(report,/No ratings are prefilled/);
    assert.match(report,/Overall preference/);
    assert.match(report,/Task requirements/);
    assert.doesNotMatch(await readFile(path.join(result.runDirectory,'blind-review','README.md'),'utf8'),/baseline|optimized/i);
    assert.match(await readFile(result.summaryPath,'utf8'),/No human ratings have been submitted/);
    assert.match(await readFile(result.summaryPath,'utf8'),/responsive overflow findings/);
    const files=result.manifest.results[0].variants.map(item=>path.join(result.runDirectory,'artifacts',result.manifest.results[0].promptId,item.arm,'source','src','App.tsx'));
    assert.equal((await Promise.all(files.map(file=>readFile(file,'utf8')))).every(source=>source.includes('function App')),true);
    assert.doesNotMatch(JSON.stringify(saved),/fixture screenshot/);

    const ratingFile=path.join(root,'reviewer-01.json');
    const baselineArm=result.manifest.results[0].variants.find(item=>item.variant==='baseline').arm;
    const ratingPayload={schemaVersion:1,runId:result.runId,reviewerId:'reviewer-01',ratings:[{promptId:'saas-01-operations-dashboard',candidates:{A:{visualQuality:4,taskFulfillment:3},B:{visualQuality:2,taskFulfillment:5}},overallPreference:baselineArm}]};
    await writeFile(ratingFile,JSON.stringify(ratingPayload),{flag:'wx'});
    assert.deepEqual(validateReviewRatings(ratingPayload,result.manifest),ratingPayload);
    const reviewResults=await writeBenchmarkReport({runDirectory:result.runDirectory,ratingFiles:[ratingFile],outputDirectory:path.join(root,'review-results')});
    assert.equal(reviewResults.summary.humanPreferences.reviewers,1);
    assert.equal(reviewResults.summary.humanPreferences.baseline,1);
    assert.equal(reviewResults.summary.humanPreferences.uniquePrompts,1);
    assert.equal(reviewResults.summary.humanPreferences.visualQualityRatings,2);
    assert.equal(reviewResults.summary.humanPreferences.taskFulfillmentRatings,2);
    assert.equal(reviewResults.summary.humanPreferences.overallPreferenceJudgments,1);
    assert.equal(reviewResults.summary.humanPreferences.judgmentCount,5);
    assert.match(await readFile(path.join(root,'review-results','summary.html'),'utf8'),/Human review:/);
    assert.deepEqual(JSON.parse(await readFile(path.join(root,'review-results','individual','reviewer-01.json'),'utf8')),ratingPayload);
    const noRatingsReport=await writeBenchmarkReport({runDirectory:result.runDirectory,outputDirectory:path.join(root,'diagnostics-only')});
    assert.equal(noRatingsReport.summary.humanPreferences.reviewers,0);
    assert.match(await readFile(path.join(root,'diagnostics-only','summary.html'),'utf8'),/No human ratings have been submitted/);
    await assert.rejects(readFile(path.join(root,'diagnostics-only','individual','reviewer-01.json')));
    assert.deepEqual(JSON.parse(await readFile(path.join(result.runDirectory,'run.json'),'utf8')),saved);
  } finally { await makeWritable(root); await rm(root,{recursive:true,force:true}); }
});

test('live benchmark refuses to start without a model and secret',async()=>{
  await assert.rejects(runBenchmark({outputRoot:os.tmpdir(),fixture:false,model:'model-only',apiKey:''}),/DYLANI_BENCHMARK_API_KEY/);
});

test('provider selection is explicit, pins one model, and limits local Ollama to loopback',()=>{
  const local=resolveBenchmarkProvider({provider:'ollama',model:'qwen3:4b'});
  assert.equal(local.provider,'ollama');
  assert.equal(local.model,'qwen3:4b');
  assert.equal(local.baseURL,'http://127.0.0.1:11434');
  assert.equal(local.apiKey,null);
  assert.throws(()=>resolveBenchmarkProvider({provider:'ollama',model:'qwen3:4b',baseURL:'http://example.com:11434/v1'}),/loopback/);
  assert.throws(()=>resolveBenchmarkProvider({provider:'other',model:'qwen3:4b'}),/Provider must be explicitly/);
  assert.throws(()=>resolveBenchmarkProvider({provider:'freellmapi',model:'model-only',apiKey:''}),/DYLANI_BENCHMARK_API_KEY/);
});

test('Ollama uses the pinned native chat request without an Authorization credential',async t=>{
  const [prompt]=await loadPrompts();
  let requestHeaders;
  let requestBody;
  let requestPath;
  const gateway=await mockGateway(async(request,response)=>{
    requestHeaders=request.headers;
    requestPath=request.url;
    requestBody=JSON.parse(await new Promise(resolve=>{let raw='';request.on('data',chunk=>raw+=chunk);request.on('end',()=>resolve(raw));}));
    jsonResponse(response,200,{model:'qwen3:4b',message:{content:JSON.stringify(fixtureDesignSpec(prompt,'baseline'))},prompt_eval_count:17,eval_count:31});
  });
  t.after(()=>gateway.server.close());
  const config=resolveBenchmarkProvider({provider:'ollama',model:'qwen3:4b',baseURL:gateway.baseURL});
  const result=await requestDesignSpec(prompt,'baseline',config);
  assert.equal(result.status,'generated');
  assert.equal(result.actualModel,'qwen3:4b');
  assert.equal(result.modelVerified,true);
  assert.equal(result.inferenceRequests,1);
  assert.deepEqual(result.usage,{prompt_tokens:17,completion_tokens:31,total_tokens:48});
  assert.equal(requestHeaders.authorization,undefined);
  assert.equal(requestPath,'/api/chat');
  assert.equal(requestBody.model,'qwen3:4b');
  assert.equal(requestBody.think,false);
  assert.equal(requestBody.format.type,'object');
  assert.equal(requestBody.format.properties.schemaVersion.const,'1.0');
  assert.deepEqual({temperature:requestBody.options.temperature,max_tokens:requestBody.options.num_predict,stream:requestBody.stream},{...BENCHMARK_SETTINGS,stream:false});
});

test('unexpected serving models and invalid model outputs are preserved but never build-eligible',async t=>{
  const [prompt]=await loadPrompts();
  const secret='private-benchmark-key-that-must-not-be-saved';
  let calls=0;
  const gateway=await mockGateway(async(_request,response)=>{
    calls++;
    jsonResponse(response,200,calls===1
      ?{model:'other-model',choices:[{message:{content:'not a DesignSpec'}}]}
      :{model:'pinned-model',choices:[{message:{content:`invalid output with ${secret}`}}]});
  });
  t.after(()=>gateway.server.close());
  const config=resolveBenchmarkProvider({provider:'freellmapi',model:'pinned-model',apiKey:secret,baseURL:gateway.baseURL});
  const mismatch=await requestDesignSpec(prompt,'baseline',config);
  assert.equal(mismatch.status,'failed');
  assert.equal(mismatch.error,'model-identity-mismatch');
  assert.equal(mismatch.actualModel,'other-model');
  assert.equal(mismatch.modelVerified,false);
  assert.equal(mismatch.rawOutput,'not a DesignSpec');
  const echoedSecret=await requestDesignSpec(prompt,'baseline',config);
  assert.equal(echoedSecret.status,'failed');
  assert.equal(echoedSecret.error,'credential-in-model-response');
  assert.match(echoedSecret.rawOutput,/\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify({mismatch,echoedSecret}),new RegExp(secret));
  assert.equal(echoedSecret.inferenceRequests,1);
});

test('failed generation output is retained with credentials redacted and failed-token usage recorded',async()=>{
  const [prompt]=await loadPrompts();
  const root=await mkdtemp(path.join(os.tmpdir(),'dylani-invalid-output-'));
  const secret='model-output-credential-fixture';
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({
    model:'pinned-model',choices:[{message:{content:`not JSON: ${secret}`},finish_reason:'stop'}],usage:{prompt_tokens:11,completion_tokens:7,total_tokens:18}
  }),{status:200,headers:{'Content-Type':'application/json'}});
  const runner={async build(){throw new Error('failed output must not build');},async close(){}};
  try {
    const run=await runBenchmark({outputRoot:root,promptIds:[prompt.id],provider:'freellmapi',model:'pinned-model',apiKey:secret,baseURL:'http://127.0.0.1:3001/v1',buildRunner:runner,capture:async()=>({status:'skipped'})});
    const item=run.manifest.results[0].variants.find(candidate=>candidate.variant==='baseline');
    assert.equal(item.generation.error,'credential-in-model-response');
    assert.equal(item.generation.modelVerified,true);
    assert.equal(item.generation.finishReason,'stop');
    assert.deepEqual(item.generation.usage,{prompt_tokens:11,completion_tokens:7,total_tokens:18});
    const raw=await readFile(path.join(run.runDirectory,'artifacts',prompt.id,item.arm,item.generation.rawOutputPaths[0]),'utf8');
    assert.equal(raw,'not JSON: [REDACTED]');
    assert.doesNotMatch(JSON.stringify(run.manifest),new RegExp(secret));
  } finally {
    globalThis.fetch=previousFetch;
    await makeWritable(root);
    await rm(root,{recursive:true,force:true});
  }
});

test('one bounded DesignSpec recovery uses the same policy for both variants and preserves every attempt',async t=>{
  const [prompt]=await loadPrompts();
  const root=await mkdtemp(path.join(os.tmpdir(),'dylani-recovery-'));
  let calls=0;
  const requestBodies=[];
  const requestHeaders=[];
  const gateway=await mockGateway(async(_request,response)=>{
    const call=++calls;
    requestHeaders.push(_request.headers);
    const body=JSON.parse(await new Promise(resolve=>{let raw='';_request.on('data',chunk=>raw+=chunk);_request.on('end',()=>resolve(raw));}));
    requestBodies.push(body);
    const variant=call<=2?'baseline':'optimized';
    const spec=fixtureDesignSpec(prompt,variant);
    if (call===1) spec.components[0].children[0].id=spec.components[0].id;
    jsonResponse(response,200,{
      model:'pinned-model',message:{content:call===3?'not JSON':JSON.stringify(spec)},done:true,done_reason:'stop',
      prompt_eval_count:call%2===1?7:9,eval_count:call%2===1?3:8
    });
  });
  t.after(()=>gateway.server.close());
  const buildRunner={async build(){return {status:'built',exitCode:0,logs:'fixed template built',previewUrl:null};},async close(){}};
  try {
    const run=await runBenchmark({
      outputRoot:root,promptIds:[prompt.id],provider:'ollama',model:'pinned-model',baseURL:gateway.baseURL,
      buildRunner,capture:async()=>({status:'skipped',runtimeErrors:[],screenshots:{},responsive:{},accessibility:{}})
    });
    assert.equal(calls,4);
    assert.ok(requestBodies.every(body=>body.model==='pinned-model'&&body.think===false&&body.format.properties.schemaVersion.const==='1.0'));
    assert.ok(requestHeaders.every(headers=>headers.authorization===undefined));
    assert.equal(requestBodies[1].messages[0].content.includes('globally unique lowercase kebab-case IDs'),true);
    assert.equal(requestBodies[3].messages[0].content.includes('globally unique lowercase kebab-case IDs'),true);
    assert.deepEqual(run.manifest.recoveryPolicy,{maxAttempts:2,retryOn:['invalid-designspec-json','invalid-designspec'],samePolicyForBothVariants:true});
    for (const item of run.manifest.results[0].variants) {
      assert.equal(item.generation.status,'generated');
      assert.equal(item.generation.recovered,true);
      assert.equal(item.generation.attempts,2);
      assert.equal(item.generation.inferenceRequests,2);
      assert.deepEqual(item.generation.usage,{prompt_tokens:16,completion_tokens:11,total_tokens:27});
      assert.equal(item.generation.attemptDetails[0].error,item.variant==='baseline'?'invalid-designspec':'invalid-designspec-json');
      assert.equal(item.generation.attemptDetails[1].error,null);
      assert.notEqual(item.generation.attemptDetails[0].promptHash,item.generation.attemptDetails[1].promptHash);
      assert.match(item.generation.attemptDetails[1].promptHash,/^[a-f0-9]{64}$/);
      const artifactDir=path.join(run.runDirectory,'artifacts',prompt.id,item.arm);
      assert.equal(item.generation.rawOutputPaths.length,2);
      const firstOutput=await readFile(path.join(artifactDir,item.generation.rawOutputPaths[0]),'utf8');
      if (item.variant==='baseline') assert.match(firstOutput,/"id":"overview"/);
      else assert.equal(firstOutput,'not JSON');
      const retryBody=JSON.parse(await readFile(path.join(artifactDir,'generation-output-attempt-2.txt'),'utf8'));
      assert.equal(retryBody.schemaVersion,'1.0');
    }
    for (const item of run.manifest.results[0].variants) {
      const retryPrompt=item.generation.attemptDetails[1].promptHash;
      assert.notEqual(retryPrompt,item.promptHash);
    }
    assert.equal(run.manifest.metrics.byVariant.baseline.recoveredCandidates,1);
    assert.equal(run.manifest.metrics.byVariant.optimized.failedGenerationAttempts,1);
    assert.deepEqual(run.manifest.metrics.byVariant.baseline.retryTokenUsage,{prompt_tokens:9,completion_tokens:8,total_tokens:17});
    assert.equal(run.manifest.metrics.totals.recoveredCandidates,2);
  } finally {
    await makeWritable(root);
    await rm(root,{recursive:true,force:true});
  }
});

test('review forms randomize candidate position and do not expose pipeline identities',()=>{
  const screenshots={mobile:'mobile.png',desktop:'desktop.png'};
  const report=comparisonHTML({runId:'test-run',results:[{promptId:'x',category:'saas-dashboard',title:'Example',requirements:['Show the required metric'],reviewOrder:['B','A'],variants:[{variant:'baseline',arm:'A',screenshots},{variant:'optimized',arm:'B',screenshots}]}]});
  assert.ok(report.indexOf('<article data-candidate="B">')<report.indexOf('<article data-candidate="A">'));
  assert.match(report,/value="tie"> Tie/);
  assert.match(report,/visualQuality/);
  assert.match(report,/taskFulfillment/);
  assert.match(report,/Download my ratings/);
  assert.match(report,/Show the required metric/);
  assert.doesNotMatch(report,/baseline|optimized|fixture-v1|quality score|automatic aesthetic score/i);
});

test('blind report omits ratings when a complete pair of screenshots is unavailable',()=>{
  const report=comparisonHTML({runId:'failed-run',results:[{promptId:'failed-01',title:'Failed preview',variants:[{arm:'A',screenshots:{}},{arm:'B',screenshots:{mobile:'mobile.png'}}]}]});
  assert.match(report,/data-reviewable="false"/);
  assert.match(report,/omitted from ratings/);
  assert.doesNotMatch(report,/<select data-rating=/);
  assert.doesNotMatch(report,/name="preference-failed-01"/);
});

test('summary reports token usage coverage, build/runtime outcomes, and only configured cost estimates',()=>{
  const manifest={pricing:{inputUsdPerMillion:1,outputUsdPerMillion:2},results:[{
    promptId:'p1',variants:[
      {variant:'baseline',arm:'A',generation:{status:'generated',inferenceRequests:1,attempts:1,elapsedMs:120,usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}},build:{status:'built'},elapsedMs:500,runtimeErrors:[],screenshots:{mobile:'m.png',desktop:'d.png'},responsive:{mobile:{horizontalOverflow:true},desktop:{horizontalOverflow:false}},accessibility:{mobile:{unlabeledInputs:1,imagesWithoutAlt:0,missingDocumentLanguage:0,emptyButtons:0}}},
      {variant:'optimized',arm:'B',generation:{status:'failed',inferenceRequests:1,attempts:1,elapsedMs:300,usage:null,error:'invalid-designspec-json'},build:{status:'not-built'},elapsedMs:300,runtimeErrors:[],screenshots:{},responsive:{},accessibility:{}}
    ]
  }]};
  const result=summarizeBenchmark(manifest);
  assert.equal(result.totals.inferenceRequests,2);
  assert.equal(result.totals.tokenUsage.prompt_tokens,100);
  assert.equal(result.totals.tokenUsageCoverage.prompt_tokens,1);
  assert.equal(result.byVariant.baseline.buildSuccessRate,1);
  assert.equal(result.byVariant.baseline.approxCostUsd,0.0002);
  assert.equal(result.byVariant.optimized.generationFailures,1);
  assert.equal(result.byVariant.optimized.approxCostUsd,null);
  assert.equal(result.byVariant.baseline.accessibility.unlabeledInputs,1);
  assert.equal(result.byVariant.baseline.responsiveChecks,2);
  assert.equal(result.byVariant.baseline.horizontalOverflowFindings,1);
  assert.equal(result.byVariant.baseline.candidatesWithHorizontalOverflow,1);
  assert.equal(result.totals.horizontalOverflowFindings,1);
  assert.equal(result.reviewablePromptCount,0);
});
