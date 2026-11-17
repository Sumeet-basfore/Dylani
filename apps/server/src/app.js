import Fastify from 'fastify';
import cors from '@fastify/cors';
import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {DEFAULT_TOKENS,normalizeTokens,selectSkills,buildPrompt,cleanPrototype,wrapPreview} from './core.js';
import {DESIGN_SPEC_VERSION,buildDesignSpecPrompt,designSpecSchema} from '@dylani/design-spec';
import {generateReactProjectFiles} from './react-project.js';
import {createReactBuildRunner} from './react-runner.js';

const configSchema=z.object({
  prompt:z.string().trim().min(5).max(3000), platform:z.enum(['web','mobile']),
  stack:z.enum(['react-vite','expo']), mode:z.enum(['baseline','optimized']),
  tokens:z.record(z.string(),z.unknown()).optional(), model:z.string().trim().min(1).max(150),
  apiKey:z.string().min(1).max(500)
}).refine(v=>v.platform==='web' ? v.stack==='react-vite':v.stack==='expo',{message:'Invalid platform/stack combination'});
const reactRequestSchema=z.object({
  prompt:z.string().trim().min(5).max(3000),platform:z.literal('web'),stack:z.literal('react-vite'),
  mode:z.enum(['baseline','optimized']),tokens:z.record(z.string(),z.unknown()).optional(),
  model:z.string().trim().min(1).max(150),apiKey:z.string().min(1).max(500)
}).strict();

function normalizeBaseURL(value) {
  let url;
  try { url=new URL(value); } catch { throw new Error('Invalid FREELLMAPI_BASE_URL'); }
  if (!['http:','https:'].includes(url.protocol)) throw new Error('Invalid FREELLMAPI_BASE_URL');
  return value.replace(/\/+$/,'');
}

export function createApp({
  baseURL=process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001/v1',
  fetchImpl=globalThis.fetch,
  modelsTimeoutMs=10_000,
  generateTimeoutMs=90_000,
  reactRunner=createReactBuildRunner(),
  logger=false
}={}) {
  const gatewayURL=normalizeBaseURL(baseURL);
  if (typeof fetchImpl!=='function') throw new TypeError('fetchImpl must be a function');
  const app=Fastify({logger,bodyLimit:100_000});
  app.register(cors,{origin:['http://127.0.0.1:5173','http://localhost:5173']});
  app.addHook('onClose',async()=>{await reactRunner.close?.();});

  async function gatewayRequest(path,options,timeoutMs) {
    try {
      const response=await fetchImpl(`${gatewayURL}${path}`,{...options,signal:AbortSignal.timeout(timeoutMs)});
      if (!response.ok) {
        try { await response.body?.cancel(); } catch {}
        return {kind:'failure'};
      }
      try { return {kind:'ok',json:await response.json(),response}; }
      catch { return {kind:'invalid'}; }
    } catch {
      return {kind:'failure'};
    }
  }

  const upstreamFailure=reply=>reply.code(502).send({error:'FreeLLMAPI request failed'});
  const invalidResponse=reply=>reply.code(502).send({error:'FreeLLMAPI returned an invalid response'});

  app.get('/api/health',async()=>({status:'ok',provider:'freellmapi'}));
  app.get('/api/defaults',async()=>({tokens:DEFAULT_TOKENS,skills:selectSkills('web','landing page').map(skill=>skill.id)}));
  app.post('/api/design-spec/validate',async(request,reply)=>{
    const parsed=designSpecSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({error:'Invalid DesignSpec',details:parsed.error.issues.map(issue=>({path:issue.path.join('.'),message:issue.message}))});
    return {valid:true,schemaVersion:DESIGN_SPEC_VERSION};
  });
  app.post('/api/models',async(request,reply)=>{
    const parsed=z.object({apiKey:z.string().min(1).max(500)}).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'Enter a gateway API key'});
    const result=await gatewayRequest('/models',{headers:{Authorization:`Bearer ${parsed.data.apiKey}`}},modelsTimeoutMs);
    if (result.kind==='failure') return upstreamFailure(reply);
    if (result.kind==='invalid' || !Array.isArray(result.json?.data) || result.json.data.some(model=>typeof model?.id!=='string')) return invalidResponse(reply);
    return {models:result.json.data.map(model=>model.id).filter(id=>!id.includes(parsed.data.apiKey)).slice(0,200)};
  });
  app.post('/api/generate',async(request,reply)=>{
    const parsed=configSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'Invalid request',details:parsed.error.issues.map(i=>i.message)});
    let tokens;
    try { tokens=normalizeTokens(parsed.data.tokens); } catch(e) { return reply.code(400).send({error:e.message}); }
    const {prompt,platform,stack,mode,model,apiKey}=parsed.data;
    const result=await gatewayRequest('/chat/completions',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model,messages:[{role:'user',content:buildPrompt({prompt,platform,stack,mode,tokens})}],temperature:0.35,max_tokens:6000,stream:false})
    },generateTimeoutMs);
    if (result.kind==='failure') return upstreamFailure(reply);
    const json=result.json;
    const content=json?.choices?.[0]?.message?.content;
    if (result.kind==='invalid' || typeof content!=='string' || !content.trim() || content.includes(apiKey)) return invalidResponse(reply);
    const html=wrapPreview(cleanPrototype(content));
    if (html.length<150) return invalidResponse(reply);
    const responseModel=typeof json.model==='string' && json.model.length<=150 && !json.model.includes(apiKey) ? json.model : model;
    const routedVia=result.response.headers.get('x-routed-via');
    const rawUsage=json.usage;
    const usage=rawUsage && typeof rawUsage==='object' ? Object.fromEntries(
      ['prompt_tokens','completion_tokens'].filter(key=>Number.isFinite(rawUsage[key]) && rawUsage[key]>=0).map(key=>[key,rawUsage[key]])
    ) : {};
    return {
      html,model:responseModel,
      routedVia:routedVia && routedVia.length<=100 && !routedVia.includes(apiKey) ? routedVia : null,
      usage:Object.keys(usage).length?usage:null,
      skills:mode==='optimized'?selectSkills(platform,prompt).map(skill=>skill.id):[],mode,platform,stack
    };
  });
  app.post('/api/generate-react',async(request,reply)=>{
    const parsed=reactRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'Invalid request',details:parsed.error.issues.map(issue=>issue.message)});
    let tokens;
    try { tokens=normalizeTokens(parsed.data.tokens); } catch(e) { return reply.code(400).send({error:e.message}); }
    const {prompt,mode,model,apiKey}=parsed.data;
    const selectedSkills=mode==='optimized'?selectSkills('web',prompt).map(skill=>skill.id):[];
    const result=await gatewayRequest('/chat/completions',{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model,messages:[{role:'user',content:buildDesignSpecPrompt({prompt,platform:'web',tokens,selectedSkills})}],temperature:0.2,max_tokens:4000,stream:false})
    },generateTimeoutMs);
    if (result.kind==='failure') return upstreamFailure(reply);
    if (result.kind==='invalid') return reply.code(502).send({error:'Model returned an invalid DesignSpec response'});
    const content=result.json?.choices?.[0]?.message?.content;
    if (typeof content!=='string' || !content.trim() || content.includes(apiKey)) return reply.code(502).send({error:'Model returned an invalid DesignSpec response'});
    let untrustedSpec;
    try { untrustedSpec=JSON.parse(content); } catch { return reply.code(502).send({error:'Model returned invalid DesignSpec JSON'}); }
    if (JSON.stringify(untrustedSpec).includes(apiKey)) return reply.code(502).send({error:'Model returned an invalid DesignSpec response'});
    const specResult=designSpecSchema.safeParse(untrustedSpec);
    if (!specResult.success) return reply.code(422).send({error:'Invalid DesignSpec',details:specResult.error.issues.map(issue=>({path:issue.path.join('.'),message:issue.message}))});
    const designSpec=specResult.data;
    const details=[];
    if (designSpec.platform!=='web') details.push({path:'platform',message:'React + Tailwind export currently supports web only'});
    if (!isDeepStrictEqual(designSpec.tokens,tokens)) details.push({path:'tokens',message:'Generated tokens must match the active design system'});
    if (!isDeepStrictEqual(designSpec.selectedSkills,selectedSkills)) details.push({path:'selectedSkills',message:'Generated skills must match the selected studio mode'});
    if (details.length) return reply.code(422).send({error:'Invalid DesignSpec',details});
    let files;
    try { files=generateReactProjectFiles(designSpec); }
    catch { return reply.code(502).send({error:'Generated project failed validation'}); }
    const responseModel=typeof result.json.model==='string' && result.json.model.length<=150 && !result.json.model.includes(apiKey) ? result.json.model : model;
    return {schemaVersion:DESIGN_SPEC_VERSION,designSpec,files,exportFilename:'dylani-react-project.zip',model:responseModel};
  });
  app.post('/api/build-react',async(request,reply)=>{
    const parsed=z.object({designSpec:z.unknown()}).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error:'Invalid build request'});
    const specResult=designSpecSchema.safeParse(parsed.data.designSpec);
    if (!specResult.success) return reply.code(422).send({error:'Invalid DesignSpec',details:specResult.error.issues.map(issue=>({path:issue.path.join('.'),message:issue.message}))});
    if (specResult.data.platform!=='web') return reply.code(422).send({error:'React + Tailwind preview supports web projects only'});
    let files;
    try { files=generateReactProjectFiles(specResult.data); }
    catch { return reply.code(422).send({error:'DesignSpec could not be compiled into the fixed project template'}); }
    const result=await reactRunner.build(files);
    if (result.status==='unavailable') return reply.code(503).send({status:'unavailable',sourceOnly:true,errors:[{message:'Isolated React build and preview are unavailable on this host'}]});
    return {status:result.status,sourceOnly:result.status!=='built',exitCode:result.exitCode??null,logs:result.logs||'',errors:result.errors||[],previewUrl:result.previewUrl||null};
  });
  return app;
}
