import Fastify from 'fastify';
import cors from '@fastify/cors';
import {z} from 'zod';
import {DEFAULT_TOKENS,normalizeTokens,selectSkills,buildPrompt,cleanPrototype,wrapPreview} from './core.js';

const app=Fastify({logger:true,bodyLimit:100_000});
await app.register(cors,{origin:['http://127.0.0.1:5173','http://localhost:5173']});
const configSchema=z.object({
  prompt:z.string().trim().min(5).max(3000), platform:z.enum(['web','mobile']),
  stack:z.enum(['react-vite','expo']), mode:z.enum(['baseline','optimized']),
  tokens:z.record(z.unknown()).optional(), model:z.string().trim().min(1).max(150),
  apiKey:z.string().min(1).max(500)
}).refine(v=>v.platform==='web' ? v.stack==='react-vite':v.stack==='expo',{message:'Invalid platform/stack combination'});
const baseURL=process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001/v1';
if (!/^https?:\/\//.test(baseURL)) throw new Error('Invalid FREELLMAPI_BASE_URL');
app.get('/api/health',async()=>({status:'ok',provider:'freellmapi',configuredBaseURL:baseURL}));
app.get('/api/defaults',async()=>({tokens:DEFAULT_TOKENS,skills:Object.keys(selectSkills('web','landing page'))}));
app.post('/api/models',async(request,reply)=>{
  const parsed=z.object({apiKey:z.string().min(1).max(500)}).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({error:'Enter a gateway API key'});
  try {
    const response=await fetch(`${baseURL}/models`,{headers:{Authorization:`Bearer ${parsed.data.apiKey}`},signal:AbortSignal.timeout(10000)});
    if(!response.ok) return reply.code(502).send({error:`Gateway returned HTTP ${response.status}`});
    const payload=await response.json();
    return {models:Array.isArray(payload.data)?payload.data.map(m=>m.id).filter(x=>typeof x==='string').slice(0,200):[]};
  }catch(e){return reply.code(502).send({error:'Cannot connect to FreeLLMAPI: '+e.message});}
});
app.post('/api/generate',async(request,reply)=>{
  const parsed=configSchema.safeParse(request.body);
  if(!parsed.success) return reply.code(400).send({error:'Invalid request',details:parsed.error.issues.map(i=>i.message)});
  let tokens;
  try {tokens=normalizeTokens(parsed.data.tokens);} catch(e) {return reply.code(400).send({error:e.message});}
  const {prompt,platform,stack,mode,model,apiKey}=parsed.data;
  try {
    const response=await fetch(`${baseURL}/chat/completions`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},
      body:JSON.stringify({model,messages:[{role:'user',content:buildPrompt({prompt,platform,stack,mode,tokens})}],temperature:0.35,max_tokens:6000,stream:false}),
      signal:AbortSignal.timeout(90000)
    });
    if (!response.ok){const detail=(await response.text()).slice(0,300);return reply.code(502).send({error:`FreeLLMAPI HTTP ${response.status}`,detail});}
    const json=await response.json();
    const content=json.choices?.[0]?.message?.content;
    if(typeof content!=='string'||!content.trim()) return reply.code(502).send({error:'Provider returned no HTML content'});
    const html=wrapPreview(cleanPrototype(content));
    if(html.length<150) return reply.code(502).send({error:'Generated prototype is empty after sanitization'});
    return {html,model:json.model||model,routedVia:response.headers.get('x-routed-via')||null,usage:json.usage||null,skills:mode==='optimized'?selectSkills(platform,prompt).map(x=>x.id):[],mode,platform,stack};
  }catch(e){return reply.code(502).send({error:'Generation failed: '+e.message});}
});
await app.listen({host:'127.0.0.1',port:Number(process.env.PORT||3002)});
