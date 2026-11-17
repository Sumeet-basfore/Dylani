import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmod,copyFile,mkdir,readdir,readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {buildDesignSpecPrompt,designSpecSchema,DESIGN_SPEC_VERSION} from '@dylani/design-spec';
import {z} from 'zod';
import {DEFAULT_TOKENS,selectSkills} from '../../apps/server/src/core.js';
import {generateReactProjectFiles} from '../../apps/server/src/react-project.js';
import {createReactBuildRunner} from '../../apps/server/src/react-runner.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const promptFile=path.resolve(here,'../prompts.json');
const sourceFiles={
  benchmarkPipeline:fileURLToPath(import.meta.url),
  promptCorpus:promptFile,
  promptBuilder:path.resolve(here,'../../apps/server/src/core.js'),
  projectGenerator:path.resolve(here,'../../apps/server/src/react-project.js'),
  designSpec:path.resolve(here,'../../packages/design-spec/src/index.ts'),
  isolatedWorker:path.resolve(here,'../../apps/server/runner/worker.mjs'),
  runnerToolchainLock:path.resolve(here,'../../apps/server/runner/toolchain/package-lock.json')
};
const settings=Object.freeze({temperature:0.2,max_tokens:4000,stream:false});
const maxGenerationAttempts=2;
const retryableGenerationErrors=new Set(['invalid-designspec-json','invalid-designspec']);
const designSpecJSONSchema=z.toJSONSchema(designSpecSchema);
const viewports=Object.freeze([{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:900}]);
const maxModelOutputBytes=300_000;

export const BENCHMARK_SETTINGS=settings;
export const BENCHMARK_VIEWPORTS=viewports;

async function getSourceDigests() {
  return Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async([name,file])=>[
    name,createHash('sha256').update(await readFile(file)).digest('hex')
  ])));
}

async function startCaptureShell() {
  const server=http.createServer((request,response)=>{
    let previewUrl;
    try { previewUrl=new URL(request.url,'http://benchmark.invalid').searchParams.get('preview'); } catch {}
    if (request.method!=='GET'||typeof previewUrl!=='string'||!/^http:\/\/127\.0\.0\.2:\d+\/[a-f0-9]{32}\/index\.html$/.test(previewUrl)) {
      response.writeHead(404,{'X-Content-Type-Options':'nosniff'}).end();
      return;
    }
    const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dylani benchmark capture</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe title="Untrusted generated benchmark preview" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${previewUrl}"></iframe></body></html>`;
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-src http://127.0.0.2:*; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",'X-Content-Type-Options':'nosniff'}).end(html);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();
  return {url:`http://127.0.0.1:${address.port}/`,close:()=>new Promise(resolve=>server.close(resolve))};
}

export async function loadPrompts() {
  const prompts=JSON.parse(await readFile(promptFile,'utf8'));
  const ids=new Set();
  if (!Array.isArray(prompts)||prompts.length!==10) throw new Error('Benchmark corpus must contain exactly 10 prompts');
  for (const prompt of prompts) {
    if (!prompt||typeof prompt.id!=='string'||ids.has(prompt.id)||!Array.isArray(prompt.requirements)||prompt.requirements.length<1) throw new Error('Benchmark prompt corpus is invalid');
    ids.add(prompt.id);
  }
  return prompts;
}

function promptText(prompt) { return `${prompt.title}\n${prompt.requirements.map(item=>`- ${item}`).join('\n')}`; }

function rawContract(prompt) {
  return [
    'Return one JSON object only. Do not include markdown, source code, CSS, URLs, package names, or shell commands.',
    `The object must match DesignSpec schema version ${DESIGN_SPEC_VERSION}: schemaVersion, platform, pageType, requirements, layout, tokens, components, responsive, selectedSkills.`,
    'Use platform web. Use pageType landing, dashboard, settings, form, catalog, detail, onboarding, or other.',
    'Layout must be an object with kind exactly one of single-column, sidebar, two-column, grid and density exactly one of compact, comfortable, spacious.',
    'Components must be an array of sections with id, type, title, optional description, and children. Parent type is exactly one of hero, section, card-grid, sidebar. Use unique lowercase kebab-case ids.',
    'Each child must be one of these exact shapes: text has text; button has label; metric has label and value; input has label and optional placeholder; list has label and 1-8 string items; badge has text. Text is content data, never markup.',
    'Responsive mobile must be stack or horizontal-scroll. Responsive desktop must be centered, sidebar, two-column, or three-column.',
    `Copy these exact design tokens: ${JSON.stringify(DEFAULT_TOKENS)}. Set selectedSkills to [].`,
    `Functional requirements:\n${promptText(prompt)}`
  ].join('\n');
}

export function buildVariantPrompt(prompt,variant) {
  if (variant==='baseline') return rawContract(prompt);
  if (variant==='optimized') {
    const skillIds=selectSkills('web',promptText(prompt)).map(skill=>skill.id);
    return buildDesignSpecPrompt({prompt:promptText(prompt),platform:'web',tokens:DEFAULT_TOKENS,selectedSkills:skillIds});
  }
  throw new Error('Unknown benchmark pipeline variant');
}

export function fixtureDesignSpec(prompt,variant) {
  const selectedSkills=variant==='optimized'?selectSkills('web',promptText(prompt)).map(skill=>skill.id):[];
  const pageType=prompt.category==='saas-dashboard'?'dashboard':prompt.category==='e-commerce'?'catalog':prompt.category==='developer-portfolio'?'detail':'landing';
  const descriptions=variant==='optimized'?'A focused overview with clear hierarchy and responsive spacing.':undefined;
  const headline=variant==='optimized'?prompt.title:`${prompt.title} overview`;
  const children=[
    {id:'summary',type:'text',text:prompt.requirements[0]},
    {id:'primary-action',type:'button',label:'Get started'},
    {id:'metric',type:'metric',label:prompt.category==='e-commerce'?'Featured items':'This month',value:prompt.category==='e-commerce'?'4 products':'$24,800'}
  ];
  if (variant==='optimized') children.push({id:'highlights',type:'list',label:'What to know',items:prompt.requirements.slice(1)});
  return designSpecSchema.parse({
    schemaVersion:DESIGN_SPEC_VERSION,platform:'web',pageType,requirements:prompt.requirements,
    layout:{kind:variant==='optimized'?'two-column':'single-column',density:variant==='optimized'?'comfortable':'compact'},
    tokens:DEFAULT_TOKENS,
    components:[{id:'overview',type:'hero',title:headline,...(descriptions?{description:descriptions}:{}),children}],
    responsive:{mobile:'stack',desktop:variant==='optimized'?'two-column':'centered'},selectedSkills
  });
}

function parseGatewayURL(raw,{loopbackOnly=false}={}) {
  let url;
  try { url=new URL(raw); } catch { throw new Error('Invalid benchmark gateway URL'); }
  const loopbackHosts=new Set(['localhost','127.0.0.1','[::1]']);
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||loopbackOnly&&!loopbackHosts.has(url.hostname)) throw new Error(loopbackOnly?'Ollama must use a loopback URL':'Invalid benchmark gateway URL');
  return `${url.origin}${url.pathname.replace(/\/+$/,'')}`;
}

function configuredRate(value) {
  if (value===undefined||value===null||value==='') return null;
  const rate=Number(value);
  return Number.isFinite(rate)&&rate>=0?rate:null;
}

export function resolveBenchmarkProvider({provider,model,baseURL,apiKey,pricing}={}) {
  const selectedProvider=String(provider||process.env.DYLANI_BENCHMARK_PROVIDER||'freellmapi').toLowerCase();
  const selectedModel=String(model||process.env.DYLANI_BENCHMARK_MODEL||'').trim();
  if (!selectedModel||selectedModel.length>150) throw new Error('Set DYLANI_BENCHMARK_MODEL to one pinned model ID');
  if (!['freellmapi','ollama'].includes(selectedProvider)) throw new Error('Provider must be explicitly set to freellmapi or ollama');
  if (selectedProvider==='freellmapi') {
    const key=apiKey??process.env.DYLANI_BENCHMARK_API_KEY;
    if (typeof key!=='string'||!key.trim()) throw new Error('Set DYLANI_BENCHMARK_API_KEY for FreeLLMAPI, or explicitly select the local Ollama provider');
    return {
      provider:selectedProvider,model:selectedModel,
      baseURL:parseGatewayURL(baseURL||process.env.DYLANI_BENCHMARK_BASE_URL||process.env.FREELLMAPI_BASE_URL||'http://127.0.0.1:3001/v1'),
      apiKey:key,timeoutMs:90_000,
      pricing:resolvePricing(pricing)
    };
  }
  const localBaseURL=parseGatewayURL(baseURL||process.env.DYLANI_BENCHMARK_BASE_URL||'http://127.0.0.1:11434',{loopbackOnly:true}).replace(/\/v1$/,'');
  return {
    provider:selectedProvider,model:selectedModel,
    baseURL:localBaseURL,
    apiKey:null,timeoutMs:180_000,
    pricing:resolvePricing(pricing)
  };
}

function resolvePricing(pricing) {
  const inputUsdPerMillion=configuredRate(pricing?.inputUsdPerMillion??process.env.DYLANI_BENCHMARK_INPUT_USD_PER_MILLION);
  const outputUsdPerMillion=configuredRate(pricing?.outputUsdPerMillion??process.env.DYLANI_BENCHMARK_OUTPUT_USD_PER_MILLION);
  return inputUsdPerMillion===null||outputUsdPerMillion===null?null:{inputUsdPerMillion,outputUsdPerMillion};
}

function redactSecret(value,secret) {
  return typeof value==='string'&&typeof secret==='string'&&secret.length>0?value.split(secret).join('[REDACTED]'):value;
}

function redactConfiguredSecrets(value,config) {
  let redacted=value;
  for (const secret of [config.apiKey,process.env.DYLANI_BENCHMARK_API_KEY,process.env.FREELLMAPI_API_KEY,process.env.OPENAI_API_KEY]) redacted=redactSecret(redacted,secret);
  return redacted;
}

async function readBoundedResponse(response,maxBytes=maxModelOutputBytes) {
  if (!response.body) return {text:'',truncated:false};
  const reader=response.body.getReader();
  const chunks=[];
  let total=0;
  let truncated=false;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      const remaining=maxBytes-total;
      if (value.byteLength>remaining) {
        chunks.push(value.subarray(0,Math.max(0,remaining)));
        total=maxBytes;
        truncated=true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total+=value.byteLength;
    }
  } finally { reader.releaseLock(); }
  return {text:Buffer.concat(chunks).toString('utf8'),truncated};
}

function createRecoveryPrompt(previousPrompt,result) {
  const feedback=(result.validationErrors||[result.error]).filter(Boolean).join('; ').slice(0,1000);
  return `${previousPrompt}\n\nBounded format recovery: the previous response failed validation (${feedback}). Regenerate the complete DesignSpec JSON object. Use globally unique lowercase kebab-case IDs across every parent component and every child in the entire document; do not reuse generic IDs such as text, metric, or label. Keep the original requirements, exact design tokens, selected skills, and allowed enum values. Return JSON only, with no markdown or explanation.`;
}

function sumUsage(results) {
  const totals={};
  for (const result of results) for (const [key,value] of Object.entries(result.usage||{})) totals[key]=(totals[key]||0)+value;
  return Object.keys(totals).length?totals:null;
}

export async function requestDesignSpec(prompt,variant,config) {
  const originalPrompt=buildVariantPrompt(prompt,variant);
  const started=performance.now();
  const attemptResults=[];
  let content=originalPrompt;
  for (let attempt=1;attempt<=maxGenerationAttempts;attempt++) {
    const result=await requestDesignSpecAttempt(content,config);
    const promptHash=createHash('sha256').update(content).digest('hex');
    attemptResults.push({...result,attempt,promptHash});
    if (result.status==='generated'||!retryableGenerationErrors.has(result.error)||attempt===maxGenerationAttempts) break;
    content=createRecoveryPrompt(originalPrompt,result);
  }
  const latest=attemptResults.at(-1);
  const rawOutputs=attemptResults.filter(result=>result.rawOutput!==null).map(result=>result.rawOutput);
  const attemptDetails=attemptResults.map(result=>({
    attempt:result.attempt,status:result.status,error:result.error||null,elapsedMs:result.elapsedMs,
    actualModel:result.actualModel,modelVerified:result.modelVerified,finishReason:result.finishReason,
    usage:result.usage,validationErrors:result.validationErrors||[],promptHash:result.promptHash
  }));
  return {
    ...latest,elapsedMs:Math.round(performance.now()-started),attempts:attemptResults.length,
    inferenceRequests:attemptResults.reduce((sum,result)=>sum+result.inferenceRequests,0),
    requestCount:attemptResults.reduce((sum,result)=>sum+result.requestCount,0),
    modelVerified:attemptResults.every(result=>result.modelVerified),usage:sumUsage(attemptResults),
    rawOutput:latest.rawOutput,rawOutputs,attemptDetails,recovered:latest.status==='generated'&&attemptResults.length>1
  };
}

async function requestDesignSpecAttempt(content,config) {
  const started=performance.now();
  const baseResult={elapsedMs:0,attempts:1,inferenceRequests:1,requestCount:1,actualModel:null,modelVerified:false,usage:null,finishReason:null,rawOutput:null};
  const fail=(error,rawOutput=null,actualModel=null,metadata={})=>({status:'failed',error,...baseResult,...metadata,elapsedMs:Math.round(performance.now()-started),rawOutput:redactConfiguredSecrets(rawOutput,config),actualModel:redactConfiguredSecrets(actualModel,config)});
  try {
    const headers={'Content-Type':'application/json'};
    if (config.apiKey) headers.Authorization=`Bearer ${config.apiKey}`;
    const endpoint=config.provider==='ollama'?`${config.baseURL}/api/chat`:`${config.baseURL}/chat/completions`;
    const body=config.provider==='ollama'
      ?{model:config.model,messages:[{role:'user',content}],stream:false,think:false,format:designSpecJSONSchema,options:{temperature:settings.temperature,num_predict:settings.max_tokens}}
      :{model:config.model,messages:[{role:'user',content}],...settings};
    const response=await fetch(endpoint,{
      method:'POST',headers,
      body:JSON.stringify(body),signal:AbortSignal.timeout(config.timeoutMs)
    });
    if (!response.ok) { try { await response.body?.cancel(); } catch {} return fail(`provider-http-${response.status}`); }
    const responseBody=await readBoundedResponse(response);
    if (responseBody.truncated) return fail('provider-response-too-large',responseBody.text);
    let json;
    try { json=JSON.parse(responseBody.text); } catch { return fail('invalid-provider-json',responseBody.text); }
    const output=config.provider==='ollama'?json?.message?.content:json?.choices?.[0]?.message?.content;
    const actualModel=typeof json?.model==='string'&&json.model.length<=150?json.model:null;
    const usage=config.provider==='ollama'
      ?safeUsage({
        prompt_tokens:json.prompt_eval_count,completion_tokens:json.eval_count,
        total_tokens:Number.isFinite(json.prompt_eval_count)&&Number.isFinite(json.eval_count)?json.prompt_eval_count+json.eval_count:undefined
      })
      :safeUsage(json.usage);
    const finishReason=config.provider==='ollama'?json.done_reason:json?.choices?.[0]?.finish_reason;
    const metadata={usage,finishReason:typeof finishReason==='string'?finishReason:null,modelVerified:actualModel===config.model};
    if (typeof output!=='string'||!output.trim()) return fail('invalid-model-response',responseBody.text,actualModel,metadata);
    const responseText=`${output}${actualModel||''}`;
    if ([config.apiKey,process.env.DYLANI_BENCHMARK_API_KEY,process.env.FREELLMAPI_API_KEY,process.env.OPENAI_API_KEY].some(secret=>secret&&responseText.includes(secret))) return fail('credential-in-model-response',output,actualModel,metadata);
    if (!actualModel) return fail('model-identity-missing',output,null,{...metadata,modelVerified:false});
    if (actualModel!==config.model) return fail('model-identity-mismatch',output,actualModel,{...metadata,modelVerified:false});
    let data;
    try { data=JSON.parse(output); } catch { return fail('invalid-designspec-json',output,actualModel,metadata); }
    const parsed=designSpecSchema.safeParse(data);
    if (!parsed.success) {
      const validationErrors=parsed.error.issues.map(issue=>`${issue.path.join('.')||'root'}: ${issue.message}`);
      return fail('invalid-designspec',output,actualModel,{...metadata,validationErrors});
    }
    return {
      ...baseResult,status:'generated',designSpec:parsed.data,elapsedMs:Math.round(performance.now()-started),
      actualModel,modelVerified:true,rawOutput:redactConfiguredSecrets(output,config),usage,finishReason:metadata.finishReason
    };
  } catch (error) {
    return fail(error?.name==='TimeoutError'?'provider-timeout':'provider-request-failed');
  }
}

function safeUsage(value) {
  if (!value||typeof value!=='object') return null;
  const usage={};
  for (const key of ['prompt_tokens','completion_tokens','total_tokens']) if (Number.isFinite(value[key])&&value[key]>=0) usage[key]=value[key];
  return Object.keys(usage).length?usage:null;
}

export async function capturePreview(previewUrl,outputDirectory,captureShellURL) {
  if (!captureShellURL) return {status:'skipped',reason:'isolated-capture-shell-unavailable',runtimeErrors:[],screenshots:{},responsive:{},accessibility:{}};
  let browser;
  try { browser=await chromium.launch({headless:true}); }
  catch { return {status:'skipped',reason:'chromium-unavailable',runtimeErrors:[],screenshots:{},responsive:{},accessibility:{}}; }
  const result={status:'pending',runtimeErrors:[],screenshots:{},responsive:{},accessibility:{}};
  try {
    for (const viewport of viewports) {
      const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},deviceScaleFactor:1});
      const page=await context.newPage();
      page.on('pageerror',error=>result.runtimeErrors.push(error.message.slice(0,500)));
      page.on('console',message=>{if (message.type()==='error') result.runtimeErrors.push(message.text().slice(0,500));});
      try {
        await page.goto(`${captureShellURL}?preview=${encodeURIComponent(previewUrl)}`,{waitUntil:'domcontentloaded',timeout:15_000});
        let frame;
        const frameDeadline=Date.now()+10_000;
        while (!frame&&Date.now()<frameDeadline) {
          frame=page.frames().find(candidate=>candidate!==page.mainFrame()&&candidate.url().includes('/index.html'));
          if (!frame) await new Promise(resolve=>setTimeout(resolve,50));
        }
        if (!frame) throw new Error(`preview-frame-unavailable:${page.frames().map(candidate=>candidate.url()).join('|')}`);
        await frame.waitForFunction(()=>document.querySelector('#root')?.childElementCount>0,undefined,{timeout:10_000});
        await page.screenshot({path:path.join(outputDirectory,`${viewport.name}.png`),fullPage:true});
        result.screenshots[viewport.name]=`${viewport.name}.png`;
        const findings=await frame.evaluate(()=>{
          const documentWidth=Math.max(document.documentElement.scrollWidth,document.body.scrollWidth);
          const unlabeledInputs=[...document.querySelectorAll('input,select,textarea')].filter(element=>!element.labels?.length&&!element.getAttribute('aria-label')&&!element.getAttribute('aria-labelledby')).length;
          const imagesWithoutAlt=document.querySelectorAll('img:not([alt])').length;
          const missingDocumentLanguage=!document.documentElement.lang;
          const emptyButtons=[...document.querySelectorAll('button')].filter(button=>!button.innerText.trim()&&!button.getAttribute('aria-label')).length;
          return {viewportWidth:innerWidth,documentWidth,horizontalOverflow:documentWidth>innerWidth,findings:{unlabeledInputs,imagesWithoutAlt,missingDocumentLanguage,emptyButtons}};
        });
        result.responsive[viewport.name]={width:viewport.width,height:viewport.height,horizontalOverflow:findings.horizontalOverflow,documentWidth:findings.documentWidth};
        result.accessibility[viewport.name]=findings.findings;
      } catch (error) {
        result.runtimeErrors.push(`preview-${viewport.name}-failed:${String(error?.name||'Error')}:${String(error?.message||'').slice(0,240)}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  result.status=Object.keys(result.screenshots).length?'captured':'failed';
  return result;
}

async function writeNew(filePath,content) {
  await mkdir(path.dirname(filePath),{recursive:true});
  await writeFile(filePath,content,{flag:'wx'});
}

async function freezeRunDirectory(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const entryPath=path.join(directory,entry.name);
    if (entry.isDirectory()) {
      await freezeRunDirectory(entryPath);
      await chmod(entryPath,0o555);
    } else await chmod(entryPath,0o444);
  }
  await chmod(directory,0o555);
}

async function saveSourceFiles(directory,files) {
  for (const file of files) {
    const resolved=path.resolve(directory,file.path);
    if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error('Unsafe generated source path');
    await writeNew(resolved,file.content);
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}

function isReviewable(promptResult) {
  return ['A','B'].every(arm=>{
    const candidate=promptResult.variants.find(item=>item.arm===arm);
    return Boolean(candidate?.screenshots?.mobile&&candidate?.screenshots?.desktop);
  });
}

export function comparisonHTML(manifest) {
  const sections=manifest.results.map(promptResult=>{
    const reviewable=isReviewable(promptResult);
    const arms=(promptResult.reviewOrder||['A','B']).map(arm=>{
      const item=promptResult.variants.find(candidate=>candidate.arm===arm);
      const screenshots=item?.screenshots||{};
      const ratingControls=reviewable?`<fieldset><legend>Human ratings for Candidate ${arm}</legend><label>Visual quality <select data-rating="${arm}-visual"><option value="">Choose 1–5</option>${[1,2,3,4,5].map(value=>`<option value="${value}">${value}</option>`).join('')}</select></label><label>Task fulfillment <select data-rating="${arm}-task"><option value="">Choose 1–5</option>${[1,2,3,4,5].map(value=>`<option value="${value}">${value}</option>`).join('')}</select></label></fieldset>`:'<p class="unavailable">This candidate is not rated because a complete paired preview is unavailable.</p>';
      return `<article data-candidate="${arm}"><h3>Candidate ${arm}</h3><div class="screens">${['desktop','mobile'].map(viewport=>screenshots[viewport]?`<figure><figcaption>${viewport} · ${viewport==='desktop'?'1440 × 900':'390 × 844'}</figcaption><img src="assets/${htmlEscape(promptResult.promptId)}/${arm}/${htmlEscape(viewport)}.png" alt="${htmlEscape(promptResult.title)}, Candidate ${arm}, ${viewport} viewport"></figure>`:`<figure><figcaption>${viewport} · ${viewport==='desktop'?'1440 × 900':'390 × 844'}</figcaption><div class="missing">Preview unavailable</div></figure>`).join('')}</div>${ratingControls}</article>`;
    }).join('');
    const preference=reviewable?`<fieldset class="preference"><legend>Overall preference</legend><label><input type="radio" name="preference-${htmlEscape(promptResult.promptId)}" value="A"> Candidate A</label><label><input type="radio" name="preference-${htmlEscape(promptResult.promptId)}" value="B"> Candidate B</label><label><input type="radio" name="preference-${htmlEscape(promptResult.promptId)}" value="tie"> Tie</label></fieldset>`:'<p class="unavailable">This prompt is omitted from ratings because a complete pair is unavailable.</p>';
    return `<section data-prompt-id="${htmlEscape(promptResult.promptId)}" data-reviewable="${reviewable}"><header><span>${htmlEscape(promptResult.category)}</span><h2>${htmlEscape(promptResult.title)}</h2><p>${htmlEscape(promptResult.promptId)}</p></header><p>Task requirements</p><ul>${(promptResult.requirements||[]).map(requirement=>`<li>${htmlEscape(requirement)}</li>`).join('')}</ul><div class="comparison">${arms}</div>${preference}</section>`;
  }).join('');
  const runId=JSON.stringify(manifest.runId||'').replace(/</g,'\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blind design comparison</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f2ed;color:#1d2527;font:15px/1.5 Inter,system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:40px}h1{font-size:clamp(2rem,4vw,3.5rem);line-height:1.05;margin:0}header>span{font-size:.72rem;text-transform:uppercase;letter-spacing:.16em;color:#59716b}section{border-top:1px solid #c9cdc5;padding:32px 0 40px}header{margin-bottom:24px}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.comparison article{min-width:0;background:#fff;border:1px solid #d8d9d1;border-radius:16px;padding:18px}.comparison h3{margin:0 0 12px}.screens{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.screens figure{min-width:0;margin:0}.screens figcaption{font-size:.8rem;font-weight:650;margin-bottom:6px}.screens img{display:block;width:100%;height:auto;border:1px solid #e1e3dc;border-radius:8px}.missing{min-height:150px;display:grid;place-items:center;background:#f1f2ee;color:#67706d;border-radius:8px}fieldset{display:flex;flex-wrap:wrap;gap:16px;border:1px solid #d8d9d1;border-radius:8px;margin:16px 0 0;padding:12px}legend{font-weight:650;padding:0 4px}label{display:flex;align-items:center;gap:7px}select,input,button{font:inherit}.preference{background:#fff}.reviewer{display:flex;gap:12px;align-items:end;position:sticky;bottom:0;background:#f4f2ed;border-top:1px solid #c9cdc5;padding:16px 0}.reviewer label{display:grid;gap:5px}.reviewer input{min-width:220px;padding:8px;border:1px solid #a9afa6;border-radius:6px}.reviewer button{padding:9px 14px;border:0;border-radius:7px;background:#193d3c;color:#fff;font-weight:650;cursor:pointer}.rating-note{color:#596361;font-size:.9rem}@media(max-width:850px){main{padding:22px}.comparison{grid-template-columns:minmax(0,1fr)}.screens{grid-template-columns:repeat(2,minmax(0,1fr)}}@media(max-width:540px){.screens{grid-template-columns:minmax(0,1fr)}.reviewer{align-items:stretch;flex-direction:column}.reviewer input{width:100%}}
  </style></head><body><main><p>DYLANI · BLIND REVIEW</p><h1>Design comparison</h1><p>Candidate positions are randomized per prompt. Pipeline identity is withheld. Compare the same desktop (1440 × 900) and mobile (390 × 844) captures.</p><p class="rating-note">Choose human ratings only after review. The 1–5 scales are reviewer judgments; ties are valid. No ratings are prefilled or inferred.</p><div class="reviewer"><label>Reviewer ID <input id="reviewer-id" maxlength="64" autocomplete="off" placeholder="Use a reviewer alias"></label><button id="download-ratings" type="button">Download my ratings</button><span id="review-message" role="status"></span></div>${sections}</main><script>
    const runId=${runId};
    document.getElementById('download-ratings').addEventListener('click',()=>{
      const reviewerId=document.getElementById('reviewer-id').value.trim();
      const message=document.getElementById('review-message');
      if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(reviewerId)){message.textContent='Enter a short reviewer alias using letters, numbers, dots, underscores, or hyphens.';return;}
      const sections=[...document.querySelectorAll('section[data-prompt-id][data-reviewable="true"]')];
      if(!sections.length){message.textContent='No complete paired previews are available for rating.';return;}
      const ratings=[];
      for(const section of sections){
        const value=name=>section.querySelector('[data-rating="'+name+'"]')?.value||'';
        const preference=section.querySelector('input[type="radio"]:checked')?.value||'';
        const candidateA={visualQuality:value('A-visual'),taskFulfillment:value('A-task')};
        const candidateB={visualQuality:value('B-visual'),taskFulfillment:value('B-task')};
        if(!candidateA.visualQuality||!candidateA.taskFulfillment||!candidateB.visualQuality||!candidateB.taskFulfillment||!['A','B','tie'].includes(preference)){message.textContent='Complete both candidate ratings and choose a preference or tie for every prompt.';return;}
        ratings.push({promptId:section.dataset.promptId,candidates:{A:{visualQuality:Number(candidateA.visualQuality),taskFulfillment:Number(candidateA.taskFulfillment)},B:{visualQuality:Number(candidateB.visualQuality),taskFulfillment:Number(candidateB.taskFulfillment)}},overallPreference:preference});
      }
      const payload={schemaVersion:1,runId,reviewerId,ratings};
      const blob=new Blob([JSON.stringify(payload,null,2)+'\\n'],{type:'application/json'});
      const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='dylani-review-'+reviewerId+'.json';link.click();URL.revokeObjectURL(link.href);
      message.textContent='Rating file downloaded. Keep this individual file for the review record.';
    });
  </script></body></html>`;
}

function median(values) {
  if (!values.length) return null;
  const ordered=[...values].sort((a,b)=>a-b);
  const middle=Math.floor(ordered.length/2);
  return ordered.length%2?ordered[middle]:Math.round((ordered[middle-1]+ordered[middle])/2);
}

export function summarizeBenchmark(manifest,reviewers=[]) {
  const items=manifest.results.flatMap(prompt=>prompt.variants);
  const reviewablePromptCount=manifest.results.filter(isReviewable).length;
  const byVariant={};
  for (const variant of ['baseline','optimized']) {
    const candidates=items.filter(item=>item.variant===variant);
    const generated=candidates.filter(item=>item.generation?.status==='generated');
    const buildSuccesses=candidates.filter(item=>item.build?.status==='built').length;
    const usageCandidates=candidates.filter(item=>item.generation?.usage);
    const usage={prompt_tokens:0,completion_tokens:0,total_tokens:0};
    const usageFields={prompt_tokens:0,completion_tokens:0,total_tokens:0};
    for (const item of candidates) for (const key of Object.keys(usage)) {
      if (Number.isFinite(item.generation?.usage?.[key])) { usage[key]+=item.generation.usage[key]; usageFields[key]++; }
    }
    const generationTimes=candidates.map(item=>item.generation?.elapsedMs).filter(Number.isFinite);
    const pipelineTimes=candidates.map(item=>item.elapsedMs).filter(Number.isFinite);
    const responsiveChecks=candidates.reduce((sum,item)=>sum+Object.keys(item.responsive||{}).length,0);
    const horizontalOverflowFindings=candidates.reduce((sum,item)=>sum+Object.values(item.responsive||{}).filter(viewport=>viewport?.horizontalOverflow===true).length,0);
    const candidatesWithHorizontalOverflow=candidates.filter(item=>Object.values(item.responsive||{}).some(viewport=>viewport?.horizontalOverflow===true)).length;
    const accessibility={unlabeledInputs:0,imagesWithoutAlt:0,missingDocumentLanguage:0,emptyButtons:0,viewportChecks:0};
    for (const item of candidates) for (const finding of Object.values(item.accessibility||{})) {
      accessibility.viewportChecks++;
      for (const key of ['unlabeledInputs','imagesWithoutAlt','missingDocumentLanguage','emptyButtons']) accessibility[key]+=Number(finding[key])||0;
    }
    const priced=manifest.pricing&&candidates.filter(item=>Number.isFinite(item.generation?.usage?.prompt_tokens)&&Number.isFinite(item.generation?.usage?.completion_tokens));
    const approxCostUsd=priced?.length?priced.reduce((sum,item)=>sum+item.generation.usage.prompt_tokens*manifest.pricing.inputUsdPerMillion/1_000_000+item.generation.usage.completion_tokens*manifest.pricing.outputUsdPerMillion/1_000_000,0):null;
    byVariant[variant]={
      candidates:candidates.length,generated:generated.length,buildSuccesses,
      buildSuccessRate:generated.length?buildSuccesses/generated.length:null,
      generationFailures:candidates.filter(item=>item.generation?.status!=='generated').length,
      buildFailures:candidates.filter(item=>item.build?.status==='failed'||item.build?.status==='rejected').length,
      modelIdentityFailures:candidates.filter(item=>['model-identity-mismatch','model-identity-missing'].includes(item.generation?.error)).length,
      inferenceRequests:candidates.reduce((sum,item)=>sum+(item.generation?.inferenceRequests||0),0),
      generationAttempts:candidates.reduce((sum,item)=>sum+(item.generation?.attempts||0),0),
      recoveredCandidates:candidates.filter(item=>item.generation?.recovered).length,
      failedGenerationAttempts:candidates.reduce((sum,item)=>sum+(item.generation?.attemptDetails||[]).filter(attempt=>attempt.error).length,0),
      retryTokenUsage:sumUsage(candidates.flatMap(item=>(item.generation?.attemptDetails||[]).filter(attempt=>attempt.attempt>1))),
      generationElapsedMs:generationTimes.reduce((sum,value)=>sum+value,0),medianGenerationMs:median(generationTimes),
      pipelineElapsedMs:pipelineTimes.reduce((sum,value)=>sum+value,0),medianPipelineMs:median(pipelineTimes),
      runtimeFailureCandidates:candidates.filter(item=>(item.runtimeErrors||[]).length>0||item.captureStatus==='failed').length,
      runtimeExceptions:candidates.reduce((sum,item)=>sum+(item.runtimeErrors||[]).length,0),
      responsiveChecks,horizontalOverflowFindings,candidatesWithHorizontalOverflow,
      tokenUsage:usage,tokenUsageCoverage:usageFields,usageCandidates:usageCandidates.length,
      accessibility,approxCostUsd,pricedCandidates:priced?.length||0,
      capturedViewports:candidates.reduce((sum,item)=>sum+Object.keys(item.screenshots||{}).length,0),
      expectedViewports:candidates.length*viewports.length
    };
  }
  const humanPreferences={baseline:0,optimized:0,tie:0,reviewers:reviewers.length,individual:[]};
  for (const reviewer of reviewers) for (const rating of reviewer.ratings) {
    const prompt=manifest.results.find(result=>result.promptId===rating.promptId);
    const selected=rating.overallPreference==='tie'?null:prompt?.variants.find(item=>item.arm===rating.overallPreference)?.variant;
    const preference=selected||'tie';
    humanPreferences[preference]++;
    humanPreferences.individual.push({reviewerId:reviewer.reviewerId,promptId:rating.promptId,preference,ratings:rating.candidates});
  }
  humanPreferences.uniquePrompts=new Set(humanPreferences.individual.map(item=>item.promptId)).size;
  humanPreferences.visualQualityRatings=humanPreferences.individual.length*2;
  humanPreferences.taskFulfillmentRatings=humanPreferences.individual.length*2;
  humanPreferences.overallPreferenceJudgments=humanPreferences.individual.length;
  humanPreferences.judgmentCount=humanPreferences.individual.length*5;
  const totals={
    promptCount:manifest.results.length,candidateCount:items.length,
    inferenceRequests:items.reduce((sum,item)=>sum+(item.generation?.inferenceRequests||0),0),
    generationAttempts:items.reduce((sum,item)=>sum+(item.generation?.attempts||0),0),
    recoveredCandidates:items.filter(item=>item.generation?.recovered).length,
    failedGenerationAttempts:items.reduce((sum,item)=>sum+(item.generation?.attemptDetails||[]).filter(attempt=>attempt.error).length,0),
    retryTokenUsage:sumUsage(items.flatMap(item=>(item.generation?.attemptDetails||[]).filter(attempt=>attempt.attempt>1))),
    tokenUsage:{prompt_tokens:0,completion_tokens:0,total_tokens:0},tokenUsageCoverage:{prompt_tokens:0,completion_tokens:0,total_tokens:0},
    generationElapsedMs:items.reduce((sum,item)=>sum+(item.generation?.elapsedMs||0),0),
    pipelineElapsedMs:items.reduce((sum,item)=>sum+(item.elapsedMs||0),0),
    runtimeFailureCandidates:items.filter(item=>(item.runtimeErrors||[]).length>0||item.captureStatus==='failed').length,
    runtimeExceptions:items.reduce((sum,item)=>sum+(item.runtimeErrors||[]).length,0),
    responsiveChecks:items.reduce((sum,item)=>sum+Object.keys(item.responsive||{}).length,0),
    horizontalOverflowFindings:items.reduce((sum,item)=>sum+Object.values(item.responsive||{}).filter(viewport=>viewport?.horizontalOverflow===true).length,0),
    candidatesWithHorizontalOverflow:items.filter(item=>Object.values(item.responsive||{}).some(viewport=>viewport?.horizontalOverflow===true)).length,
    modelIdentityFailures:items.filter(item=>['model-identity-mismatch','model-identity-missing'].includes(item.generation?.error)).length,
    approxCostUsd:manifest.pricing?0:null,pricedCandidates:0,
    capturedViewports:items.reduce((sum,item)=>sum+Object.keys(item.screenshots||{}).length,0),expectedViewports:items.length*viewports.length
  };
  for (const item of items) for (const key of Object.keys(totals.tokenUsage)) if (Number.isFinite(item.generation?.usage?.[key])) { totals.tokenUsage[key]+=item.generation.usage[key]; totals.tokenUsageCoverage[key]++; }
  if (manifest.pricing) {
    let pricedCount=0;
    for (const item of items) if (Number.isFinite(item.generation?.usage?.prompt_tokens)&&Number.isFinite(item.generation?.usage?.completion_tokens)) {
      totals.approxCostUsd+=item.generation.usage.prompt_tokens*manifest.pricing.inputUsdPerMillion/1_000_000+item.generation.usage.completion_tokens*manifest.pricing.outputUsdPerMillion/1_000_000;
      pricedCount++; totals.pricedCandidates++;
    }
    if (!pricedCount) totals.approxCostUsd=null;
  }
  return {byVariant,totals,humanPreferences,reviewablePromptCount,limitations:{accessibility:'DOM heuristic checks only; not a WCAG audit',visualQuality:'No automated aesthetic score; preference values come only from submitted human reviews',modelIdentity:'An output is build-eligible only when the serving model matches the pinned model exactly'}};
}

export function validateReviewRatings(payload,manifest) {
  if (!payload||payload.schemaVersion!==1||payload.runId!==manifest.runId||typeof payload.reviewerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(payload.reviewerId)||!Array.isArray(payload.ratings)) throw new Error('Invalid review rating file');
  const promptIds=manifest.results.filter(isReviewable).map(result=>result.promptId);
  if (!promptIds.length) throw new Error('This run has no complete paired previews to review');
  if (payload.ratings.length!==promptIds.length) throw new Error('Review file must rate every prompt in the run');
  const seen=new Set();
  const ratings=payload.ratings.map(rating=>{
    if (!rating||!promptIds.includes(rating.promptId)||seen.has(rating.promptId)||!['A','B','tie'].includes(rating.overallPreference)) throw new Error('Review file has an invalid prompt or preference');
    seen.add(rating.promptId);
    const candidates={};
    for (const arm of ['A','B']) {
      const value=rating.candidates?.[arm];
      for (const key of ['visualQuality','taskFulfillment']) if (!Number.isInteger(value?.[key])||value[key]<1||value[key]>5) throw new Error('Review ratings must be integers from 1 to 5');
      candidates[arm]={visualQuality:value.visualQuality,taskFulfillment:value.taskFulfillment};
    }
    return {promptId:rating.promptId,candidates,overallPreference:rating.overallPreference};
  });
  return {schemaVersion:1,runId:manifest.runId,reviewerId:payload.reviewerId,ratings};
}

function summaryHTML(manifest,reviewers=[]) {
  const summary=summarizeBenchmark(manifest,reviewers);
  const variantRows=['baseline','optimized'].map(variant=>{
    const row=summary.byVariant[variant];
    const success=row.buildSuccessRate===null?'n/a':`${row.buildSuccesses}/${row.generated} (${(row.buildSuccessRate*100).toFixed(1)}%)`;
    const tokens=`prompt ${row.tokenUsage.prompt_tokens} (${row.tokenUsageCoverage.prompt_tokens}/${row.candidates}), completion ${row.tokenUsage.completion_tokens} (${row.tokenUsageCoverage.completion_tokens}/${row.candidates}), total ${row.tokenUsage.total_tokens} (${row.tokenUsageCoverage.total_tokens}/${row.candidates})`;
    const recovery=`${row.recoveredCandidates} recovered; ${row.failedGenerationAttempts} failed attempts; retry tokens ${JSON.stringify(row.retryTokenUsage||{})}`;
    return `<tr><th>${variant}</th><td>${success}</td><td>${row.generationFailures}</td><td>${row.buildFailures}</td><td>${row.runtimeFailureCandidates} candidates / ${row.runtimeExceptions} exceptions</td><td>${row.responsiveChecks} checks / ${row.horizontalOverflowFindings} overflow findings (${row.candidatesWithHorizontalOverflow} candidates)</td><td>${htmlEscape(recovery)}</td><td>${row.inferenceRequests} / ${row.generationAttempts}</td><td>${htmlEscape(tokens)}</td><td>Generation ${row.generationElapsedMs} ms total (median ${row.medianGenerationMs??'n/a'}); end-to-end ${row.pipelineElapsedMs} ms (median ${row.medianPipelineMs??'n/a'})</td><td>${row.approxCostUsd===null?'unknown':`$${row.approxCostUsd.toFixed(6)} (estimate, ${row.pricedCandidates}/${row.candidates} candidates)`}</td><td>${htmlEscape(JSON.stringify({...row.accessibility,capturedViewports:row.capturedViewports,expectedViewports:row.expectedViewports}))}</td></tr>`;
  }).join('');
  const preferences=summary.humanPreferences.reviewers?`<p>Human review: ${summary.humanPreferences.reviewers} reviewer file(s), ${summary.humanPreferences.uniquePrompts} unique prompt(s), ${summary.humanPreferences.judgmentCount} individual judgments (${summary.humanPreferences.visualQualityRatings} visual-quality ratings, ${summary.humanPreferences.taskFulfillmentRatings} task-fulfillment ratings, ${summary.humanPreferences.overallPreferenceJudgments} overall preferences). Preferences: baseline ${summary.humanPreferences.baseline}, optimized ${summary.humanPreferences.optimized}, tie ${summary.humanPreferences.tie}. These are raw reviewer selections, not an automatic score; the small sample is descriptive only.</p><table><thead><tr><th>Reviewer</th><th>Prompt</th><th>Preference</th><th>Ratings by candidate</th></tr></thead><tbody>${summary.humanPreferences.individual.map(item=>`<tr><td>${htmlEscape(item.reviewerId)}</td><td>${htmlEscape(item.promptId)}</td><td>${htmlEscape(item.preference)}</td><td>${htmlEscape(JSON.stringify(item.ratings))}</td></tr>`).join('')}</tbody></table>`:'<p>No human ratings have been submitted. Human preferences are not available.</p>';
  const total=summary.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dylani benchmark results</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f2ed;color:#1d2527;font:15px/1.5 Inter,system-ui,sans-serif}main{max-width:1500px;margin:auto;padding:36px}h1{line-height:1.1}table{width:100%;border-collapse:collapse;background:#fff;margin:18px 0 36px}th,td{text-align:left;vertical-align:top;padding:10px;border:1px solid #d5d8d0;overflow-wrap:anywhere}thead{background:#e9ece5}.callout{padding:16px;border:1px solid #d5d8d0;background:#fff;border-radius:10px;margin:20px 0}</style></head><body><main><p>DYLANI · BENCHMARK SUMMARY</p><h1>${htmlEscape(manifest.runId)}</h1><div class="callout"><strong>Requested provider/model:</strong> ${htmlEscape(manifest.provider)} / ${htmlEscape(manifest.model)}<br><strong>Model policy:</strong> ${htmlEscape(manifest.modelPolicy)}<br><strong>Prompts:</strong> ${total.promptCount}; <strong>inference requests:</strong> ${total.inferenceRequests}; <strong>attempts:</strong> ${total.generationAttempts}; <strong>recovered candidates:</strong> ${total.recoveredCandidates}; <strong>failed attempts:</strong> ${total.failedGenerationAttempts}; <strong>retry tokens:</strong> ${htmlEscape(JSON.stringify(total.retryTokenUsage||{}))}; <strong>generation time:</strong> ${total.generationElapsedMs} ms; <strong>end-to-end time:</strong> ${total.pipelineElapsedMs} ms<br><strong>Usage totals:</strong> prompt ${total.tokenUsage.prompt_tokens} (${total.tokenUsageCoverage.prompt_tokens}/${total.candidateCount} candidates), completion ${total.tokenUsage.completion_tokens} (${total.tokenUsageCoverage.completion_tokens}/${total.candidateCount}), total ${total.tokenUsage.total_tokens} (${total.tokenUsageCoverage.total_tokens}/${total.candidateCount})<br><strong>Viewport captures:</strong> ${total.capturedViewports}/${total.expectedViewports}; <strong>responsive overflow findings:</strong> ${total.horizontalOverflowFindings} across ${total.responsiveChecks} checks; <strong>model identity mismatches/missing:</strong> ${total.modelIdentityFailures}; <strong>estimated cost:</strong> ${total.approxCostUsd===null?'unknown':`$${total.approxCostUsd.toFixed(6)} for ${total.pricedCandidates} candidates`}</div><h2>Pipeline diagnostics</h2><table><thead><tr><th>Pipeline</th><th>Build success</th><th>Generation failures</th><th>Build failures</th><th>Runtime failures</th><th>Responsive overflow</th><th>Recovery diagnostics</th><th>Requests / attempts</th><th>Token consumption and coverage</th><th>Latency</th><th>Approximate cost</th><th>Accessibility findings (heuristics)</th></tr></thead><tbody>${variantRows}</tbody></table><h2>Human preferences</h2>${preferences}<h2>Limitations and missing data</h2><ul><li>Accessibility results are limited DOM heuristics and are not a WCAG audit.</li><li>No automatic visual-quality score is calculated; ratings only exist after reviewers submit them.</li><li>Token and cost data are partial when the provider omits usage or prices were not configured.</li><li>Each output is build-eligible only when the response identifies the exact pinned model.</li></ul><p><a href="blind-review/comparison.html">Open the blind review package</a></p></main></body></html>`;
}

async function prepareBlindReview(runDirectory,manifest) {
  const directory=path.join(runDirectory,'blind-review');
  await mkdir(directory,{recursive:true});
  for (const prompt of manifest.results) for (const item of prompt.variants) for (const viewport of ['mobile','desktop']) {
    if (!item.screenshots?.[viewport]) continue;
    const source=path.join(runDirectory,'artifacts',prompt.promptId,item.arm,item.screenshots[viewport]);
    const destination=path.join(directory,'assets',prompt.promptId,item.arm,`${viewport}.png`);
    await mkdir(path.dirname(destination),{recursive:true});
    await copyFile(source,destination);
  }
  await writeNew(path.join(directory,'comparison.html'),comparisonHTML(manifest));
  await writeNew(path.join(directory,'README.md'),'Share this directory with reviewers. It contains only anonymized screenshots and the rating form; keep the parent run.json and source artifacts private until review is complete. Each reviewer should use a unique alias, rate visual quality and task fulfillment from 1 to 5, choose A, B, or tie, then download and preserve their individual JSON file. Do not edit or combine reviewer files.\n');
  return directory;
}

export async function writeBenchmarkReport({runDirectory,ratingFiles=[],outputDirectory}={}) {
  const resolvedRun=path.resolve(runDirectory||'');
  const manifest=JSON.parse(await readFile(path.join(resolvedRun,'run.json'),'utf8'));
  if (!Array.isArray(ratingFiles)) throw new Error('Reviewer ratings must be supplied as a list of JSON files');
  const reviewers=[];
  const reviewerIds=new Set();
  for (const ratingFile of ratingFiles) {
    const payload=JSON.parse(await readFile(ratingFile,'utf8'));
    const valid=validateReviewRatings(payload,manifest);
    if (reviewerIds.has(valid.reviewerId)) throw new Error('Reviewer IDs must be unique within a results report');
    reviewerIds.add(valid.reviewerId);
    reviewers.push(valid);
  }
  const destination=path.resolve(outputDirectory||path.join(path.dirname(resolvedRun),`${path.basename(resolvedRun)}-report-${randomUUID()}`));
  if (destination===resolvedRun||destination.startsWith(`${resolvedRun}${path.sep}`)) throw new Error('Review results must be written outside the immutable run directory');
  await mkdir(destination,{recursive:false});
  if (reviewers.length) {
    await mkdir(path.join(destination,'individual'),{recursive:true});
    for (const reviewer of reviewers) await writeNew(path.join(destination,'individual',`${reviewer.reviewerId}.json`),`${JSON.stringify(reviewer,null,2)}\n`);
  }
  const summary=summarizeBenchmark(manifest,reviewers);
  await writeNew(path.join(destination,'summary.json'),`${JSON.stringify({schemaVersion:1,runId:manifest.runId,reviewers,summary},null,2)}\n`);
  await writeNew(path.join(destination,'summary.html'),summaryHTML(manifest,reviewers));
  return {outputDirectory:destination,summary};
}

export async function runBenchmark({
  outputRoot=path.resolve(here,'../runs'),promptIds=null,fixture=false,model,provider,baseURL,
  apiKey,timeoutMs,pricing,buildRunner=null,capture=null,now=()=>new Date()
}={}) {
  const prompts=await loadPrompts();
  const selected=promptIds?prompts.filter(prompt=>promptIds.includes(prompt.id)):prompts;
  if (!selected.length||promptIds&&selected.length!==promptIds.length) throw new Error('Unknown or empty benchmark prompt selection');
  const runId=`${now().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  const runDirectory=path.resolve(outputRoot,runId);
  const digests=await getSourceDigests();
  const config=fixture?null:resolveBenchmarkProvider({provider,model,baseURL,apiKey,pricing});
  if (config&&timeoutMs!==undefined&&Number.isInteger(timeoutMs)&&timeoutMs>0) config.timeoutMs=Math.min(timeoutMs,config.provider==='ollama'?300_000:180_000);
  await mkdir(runDirectory,{recursive:true});
  const manifest={schemaVersion:1,benchmarkVersion:'1.4.0',runId,createdAt:now().toISOString(),provider:fixture?'deterministic-fixture':config.provider,model:fixture?'fixture-v1':config.model,modelPolicy:'pinned-exact-response-identity; no model fallback',generationSettings:settings,recoveryPolicy:{maxAttempts:maxGenerationAttempts,retryOn:[...retryableGenerationErrors],samePolicyForBothVariants:true},requestTimeoutMs:config?.timeoutMs??null,providerSettings:config?.provider==='ollama'?{api:'ollama-native-chat',think:false,responseFormat:'DesignSpec JSON Schema'}:config?{api:'openai-compatible-chat-completions'}:{api:'fixture'},pricing:config?.pricing??null,sourceDigests:digests,viewports,prompts:selected.map(prompt=>({id:prompt.id,category:prompt.category,requirements:prompt.requirements})),results:[]};
  const previousVitePort=process.env.VITE_PORT;
  const captureShell=capture?null:await startCaptureShell();
  if (captureShell) process.env.VITE_PORT=new URL(captureShell.url).port;
  const activeRunner=buildRunner||createReactBuildRunner();
  const activeCapture=capture||((previewUrl,directory)=>capturePreview(previewUrl,directory,captureShell?.url));

  try {
    for (const prompt of selected) {
      const variantResults=[];
      const labels=randomBytes(1)[0]&1?{baseline:'A',optimized:'B'}:{baseline:'B',optimized:'A'};
      const reviewOrder=randomBytes(1)[0]&1?['A','B']:['B','A'];
      for (const variant of ['baseline','optimized']) {
        const started=performance.now();
        let generation;
        const promptHash=createHash('sha256').update(buildVariantPrompt(prompt,variant)).digest('hex');
        if (fixture) generation={status:'generated',designSpec:fixtureDesignSpec(prompt,variant),elapsedMs:0,attempts:0,inferenceRequests:0,requestCount:0,actualModel:'fixture-v1',modelVerified:true,usage:null,rawOutput:null};
        else generation=await requestDesignSpec(prompt,variant,config);
        const arm=labels[variant];
        const artifactDir=path.join(runDirectory,'artifacts',prompt.id,arm);
        await mkdir(artifactDir,{recursive:true});
        const rawOutputs=generation.rawOutputs||((generation.rawOutput!==undefined&&generation.rawOutput!==null)?[generation.rawOutput]:[]);
        const rawOutputPaths=[];
        for (const [outputIndex,rawOutput] of rawOutputs.entries()) {
          const outputPath=`generation-output-attempt-${outputIndex+1}.txt`;
          await writeNew(path.join(artifactDir,outputPath),rawOutput);
          rawOutputPaths.push(outputPath);
        }
        const item={variant,arm,promptHash,requestedModel:fixture?'fixture-v1':config.model,actualModel:generation.actualModel??null,generation:{status:generation.status,elapsedMs:generation.elapsedMs,attempts:generation.attempts||0,inferenceRequests:generation.inferenceRequests??generation.requestCount??0,requestCount:generation.requestCount??0,modelVerified:generation.modelVerified===true,finishReason:generation.finishReason??null,usage:generation.usage||null,error:generation.error||null,recovered:generation.recovered===true,attemptDetails:generation.attemptDetails||[],rawOutputPaths},build:{status:'not-started',exitCode:null,logs:''},runtimeErrors:[],screenshots:{},responsive:{},accessibility:{},elapsedMs:0};
        if (generation.status==='generated') {
          try {
            const files=generateReactProjectFiles(generation.designSpec);
            await saveSourceFiles(path.join(artifactDir,'source'),files);
            const build=await activeRunner.build(files);
            item.build={status:build.status,exitCode:build.exitCode??null,logs:typeof build.logs==='string'?build.logs.slice(0,16_384):''};
            if (build.status==='built'&&build.previewUrl) {
              const captureResult=await activeCapture(build.previewUrl,artifactDir);
              item.runtimeErrors=captureResult.runtimeErrors||[];
              item.screenshots=captureResult.screenshots||{};
              item.responsive=captureResult.responsive||{};
              item.accessibility=captureResult.accessibility||{};
              item.captureStatus=captureResult.status;
            }
          } catch { item.build={status:'failed',exitCode:null,logs:'Project generation, build, or artifact capture failed'}; }
        } else item.build={status:'not-built',exitCode:null,logs:''};
        item.elapsedMs=Math.round(performance.now()-started);
        variantResults.push(item);
      }
      manifest.results.push({promptId:prompt.id,category:prompt.category,title:prompt.title,requirements:prompt.requirements,reviewOrder,variants:variantResults});
    }
  } finally {
    await activeRunner.close?.();
    if (captureShell) await captureShell.close();
    if (previousVitePort===undefined) delete process.env.VITE_PORT;
    else process.env.VITE_PORT=previousVitePort;
  }

  manifest.completedAt=now().toISOString();
  manifest.metrics=summarizeBenchmark(manifest);
  await writeNew(path.join(runDirectory,'run.json'),`${JSON.stringify(manifest,null,2)}\n`);
  const blindReviewDirectory=await prepareBlindReview(runDirectory,manifest);
  const summaryPath=path.join(runDirectory,'summary.html');
  await writeNew(summaryPath,summaryHTML(manifest));
  await freezeRunDirectory(runDirectory);
  return {runId,runDirectory,manifest,reportPath:path.join(blindReviewDirectory,'comparison.html'),summaryPath};
}
