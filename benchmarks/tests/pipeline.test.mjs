import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildVariantPrompt,comparisonHTML,fixtureDesignSpec,loadPrompts,runBenchmark,BENCHMARK_SETTINGS,BENCHMARK_VIEWPORTS} from '../src/pipeline.mjs';
import {designSpecSchema} from '@dylani/design-spec';

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

test('fixture run saves immutable source, metrics, anonymized report, and no ratings',async()=>{
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
    const saved=JSON.parse(await readFile(path.join(result.runDirectory,'run.json'),'utf8'));
    assert.deepEqual(saved,result.manifest);
    const report=await readFile(result.reportPath,'utf8');
    assert.match(report,/Pipeline A/);
    assert.match(report,/Pipeline B/);
    assert.doesNotMatch(report,/baseline|optimized|fixture-v1/i);
    assert.match(report,/Human ratings: unassigned/);
    const files=result.manifest.results[0].variants.map(item=>path.join(result.runDirectory,'artifacts',result.manifest.results[0].promptId,item.arm,'source','src','App.tsx'));
    assert.equal((await Promise.all(files.map(file=>readFile(file,'utf8')))).every(source=>source.includes('function App')),true);
    assert.doesNotMatch(JSON.stringify(saved),/fixture screenshot/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('live benchmark refuses to start without a model and secret',async()=>{
  await assert.rejects(runBenchmark({outputRoot:os.tmpdir(),fixture:false,model:'model-only',apiKey:''}),/DYLANI_BENCHMARK_API_KEY/);
});

test('comparison report does not assign numerical quality scores',()=>{
  const report=comparisonHTML({results:[{promptId:'x',category:'saas-dashboard',title:'Example',variants:[{arm:'A',build:{status:'built'},screenshots:{}},{arm:'B',build:{status:'built'},screenshots:{}}]}]});
  assert.match(report,/Human ratings: unassigned/);
  assert.doesNotMatch(report,/quality score|score:|rating\s*=/i);
});
