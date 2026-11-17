import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {buildDesignSpecPrompt,designSpecSchema,DESIGN_SPEC_VERSION} from '@dylani/design-spec';
import {DEFAULT_TOKENS,selectSkills} from '../../apps/server/src/core.js';
import {generateReactProjectFiles} from '../../apps/server/src/react-project.js';
import {createReactBuildRunner} from '../../apps/server/src/react-runner.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const promptFile=path.resolve(here,'../prompts.json');
const settings=Object.freeze({temperature:0.2,max_tokens:4000,stream:false});
const viewports=Object.freeze([{name:'mobile',width:390,height:844},{name:'desktop',width:1440,height:900}]);

export const BENCHMARK_SETTINGS=settings;
export const BENCHMARK_VIEWPORTS=viewports;

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
    'Use only schema component and child types. Components must use unique lowercase kebab-case ids; text is content data, never markup.',
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

function parseGatewayURL(raw) {
  let url;
  try { url=new URL(raw); } catch { throw new Error('Invalid benchmark gateway URL'); }
  if (!['http:','https:'].includes(url.protocol)||url.username||url.password) throw new Error('Invalid benchmark gateway URL');
  return raw.replace(/\/+$/,'');
}

async function requestDesignSpec(prompt,variant,config) {
  const content=buildVariantPrompt(prompt,variant);
  const started=performance.now();
  try {
    const response=await fetch(`${config.baseURL}/chat/completions`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.apiKey}`},
      body:JSON.stringify({model:config.model,messages:[{role:'user',content}],...settings}),signal:AbortSignal.timeout(config.timeoutMs)
    });
    if (!response.ok) { try { await response.body?.cancel(); } catch {} return {status:'failed',error:`gateway-http-${response.status}`,elapsedMs:Math.round(performance.now()-started),requestCount:1}; }
    const json=await response.json();
    const output=json?.choices?.[0]?.message?.content;
    if (typeof output!=='string'||!output.trim()||output.includes(config.apiKey)) return {status:'failed',error:'invalid-model-response',elapsedMs:Math.round(performance.now()-started),requestCount:1};
    let data;
    try { data=JSON.parse(output); } catch { return {status:'failed',error:'invalid-designspec-json',elapsedMs:Math.round(performance.now()-started),requestCount:1}; }
    const parsed=designSpecSchema.safeParse(data);
    if (!parsed.success) return {status:'failed',error:'invalid-designspec',elapsedMs:Math.round(performance.now()-started),requestCount:1};
    return {
      status:'generated',designSpec:parsed.data,elapsedMs:Math.round(performance.now()-started),requestCount:1,
      model:typeof json.model==='string'&&!json.model.includes(config.apiKey)?json.model:config.model,
      usage:safeUsage(json.usage)
    };
  } catch {
    return {status:'failed',error:'gateway-request-failed',elapsedMs:Math.round(performance.now()-started),requestCount:1};
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

export function comparisonHTML(manifest) {
  const sections=manifest.results.map(promptResult=>{
    const arms=['A','B'].map(arm=>{
      const item=promptResult.variants.find(candidate=>candidate.arm===arm);
      const screenshots=item?.screenshots||{};
      return `<article><h3>Pipeline ${arm}</h3><p>Build: ${htmlEscape(item?.build?.status||'not built')} · Execution: ${htmlEscape(item?.elapsedMs??'—')} ms</p><div class="screens">${['desktop','mobile'].map(viewport=>screenshots[viewport]?`<figure><figcaption>${viewport} · ${viewport==='desktop'?'1440 × 900':'390 × 844'}</figcaption><img src="${htmlEscape(`artifacts/${promptResult.promptId}/${arm}/${screenshots[viewport]}`)}" alt="Prompt ${htmlEscape(promptResult.promptId)}, pipeline ${arm}, ${viewport} viewport"></figure>`:`<p>${viewport} screenshot unavailable</p>`).join('')}</div></article>`;
    }).join('');
    return `<section><header><span>${htmlEscape(promptResult.category)}</span><h2>${htmlEscape(promptResult.title)}</h2><p>${htmlEscape(promptResult.promptId)}</p></header><div class="comparison">${arms}</div><p class="rating">Human ratings: unassigned</p></section>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blind design comparison</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f2ed;color:#1d2527;font:15px/1.5 Inter,system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:40px}h1{font-size:clamp(2rem,4vw,3.5rem);line-height:1.05;margin:0}header>span{font-size:.72rem;text-transform:uppercase;letter-spacing:.16em;color:#59716b}section{border-top:1px solid #c9cdc5;padding:32px 0 40px}header{margin-bottom:24px}.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.comparison article{min-width:0;background:#fff;border:1px solid #d8d9d1;border-radius:16px;padding:18px}.comparison h3{margin:0 0 4px}.screens{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.screens figure{min-width:0;margin:0}.screens img{display:block;width:100%;border:1px solid #e1e3dc;border-radius:8px}.rating{color:#67706d;font-size:.85rem}@media(max-width:760px){main{padding:22px}.comparison{grid-template-columns:minmax(0,1fr)}.screens{grid-template-columns:minmax(0,1fr)}}
  </style></head><body><main><p>DYLANI · BENCHMARK FOUNDATION</p><h1>Blind design comparison</h1><p>Pipeline labels are anonymized. Human ratings remain unassigned.</p>${sections}</main></body></html>`;
}

export async function runBenchmark({
  outputRoot=path.resolve(here,'../runs'),promptIds=null,fixture=false,model,provider='FreeLLMAPI',baseURL,
  apiKey,timeoutMs=90_000,buildRunner=null,capture=null,now=()=>new Date()
}={}) {
  const prompts=await loadPrompts();
  const selected=promptIds?prompts.filter(prompt=>promptIds.includes(prompt.id)):prompts;
  if (!selected.length||promptIds&&selected.length!==promptIds.length) throw new Error('Unknown or empty benchmark prompt selection');
  const runId=`${now().toISOString().replace(/[:.]/g,'-')}-${randomUUID()}`;
  const runDirectory=path.resolve(outputRoot,runId);
  const config=fixture?null:{baseURL:parseGatewayURL(baseURL||process.env.FREELLMAPI_BASE_URL||'http://127.0.0.1:3001/v1'),apiKey:apiKey||process.env.DYLANI_BENCHMARK_API_KEY,model:model||process.env.DYLANI_BENCHMARK_MODEL,timeoutMs};
  if (!fixture&&(!config.apiKey||!config.model)) throw new Error('Set DYLANI_BENCHMARK_API_KEY and DYLANI_BENCHMARK_MODEL, or use --fixture');
  await mkdir(runDirectory,{recursive:true});
  const manifest={schemaVersion:1,runId,createdAt:now().toISOString(),provider:fixture?'deterministic-fixture':provider,model:fixture?'fixture-v1':config.model,generationSettings:settings,viewports,prompts:selected.map(prompt=>({id:prompt.id,category:prompt.category})),results:[]};
  const previousVitePort=process.env.VITE_PORT;
  const captureShell=capture?null:await startCaptureShell();
  if (captureShell) process.env.VITE_PORT=new URL(captureShell.url).port;
  const activeRunner=buildRunner||createReactBuildRunner();
  const activeCapture=capture||((previewUrl,directory)=>capturePreview(previewUrl,directory,captureShell?.url));

  try {
    for (const prompt of selected) {
      const variantResults=[];
      const labels=randomBytes(1)[0]&1?{baseline:'A',optimized:'B'}:{baseline:'B',optimized:'A'};
      for (const variant of ['baseline','optimized']) {
        const started=performance.now();
        let generation;
        if (fixture) generation={status:'generated',designSpec:fixtureDesignSpec(prompt,variant),elapsedMs:0,requestCount:0,model:'fixture-v1',usage:null};
        else generation=await requestDesignSpec(prompt,variant,config);
        const arm=labels[variant];
        const artifactDir=path.join(runDirectory,'artifacts',prompt.id,arm);
        await mkdir(artifactDir,{recursive:true});
        const item={variant,arm,model:generation.model||manifest.model,generation:{status:generation.status,elapsedMs:generation.elapsedMs,requestCount:generation.requestCount,usage:generation.usage||null,error:generation.error||null},build:{status:'not-started',exitCode:null,logs:''},runtimeErrors:[],screenshots:{},responsive:{},accessibility:{},elapsedMs:0};
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
      manifest.results.push({promptId:prompt.id,category:prompt.category,title:prompt.title,variants:variantResults});
    }
  } finally {
    await activeRunner.close?.();
    if (captureShell) await captureShell.close();
    if (previousVitePort===undefined) delete process.env.VITE_PORT;
    else process.env.VITE_PORT=previousVitePort;
  }

  manifest.completedAt=now().toISOString();
  await writeNew(path.join(runDirectory,'run.json'),`${JSON.stringify(manifest,null,2)}\n`);
  await writeNew(path.join(runDirectory,'comparison.html'),comparisonHTML(manifest));
  return {runId,runDirectory,manifest,reportPath:path.join(runDirectory,'comparison.html')};
}
