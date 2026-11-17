import http from 'node:http';
import {randomUUID} from 'node:crypto';

const host='127.0.0.2';
const maxArtifacts=12;
const maxBytes=3_000_000;
const projects=new Map();
const webPort=Number(process.argv[2]);
const requestedTtlMs=Number(process.argv[4]);
const artifactTtlMs=Number.isInteger(requestedTtlMs)&&requestedTtlMs>0&&requestedTtlMs<=30*60_000?requestedTtlMs:30*60_000;
const appOrigins=(process.argv[3]||'').split(',').filter(value=>/^http:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}$/.test(value));
const previewOrigin=()=>`http://${host}:${server.address().port}`;

function securityHeaders(contentType) {
  return {
    'Content-Type':contentType,
    'Cache-Control':'no-store',
    'Content-Security-Policy':[
      "default-src 'none'",
      `script-src ${previewOrigin()}`,
      `style-src ${previewOrigin()}`,
      'img-src data:',
      "font-src 'none'",
      "connect-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${appOrigins.join(' ')||"'none'"}`
    ].join('; '),
    'Cross-Origin-Resource-Policy':'cross-origin',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()',
    'Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff'
  };
}

function validId(value) { return /^[a-f0-9]{32}$/.test(value); }
function fail(response,status=404) { response.writeHead(status,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); response.end(); }

const server=http.createServer((request,response)=>{
  if (!['GET','HEAD'].includes(request.method)) return fail(response,405);
  let pathname;
  try { pathname=new URL(request.url,'http://preview.invalid').pathname; }
  catch { return fail(response,400); }
  const parts=pathname.split('/').filter(Boolean);
  if (!parts.length || !validId(parts[0])) return fail(response);
  const project=projects.get(parts[0]);
  if (!project || project.expires<Date.now()) { projects.delete(parts[0]); return fail(response); }

  if (parts.length===2&&parts[1]==='index.html') {
    const js=project.files.find(file=>file.path.endsWith('.js'));
    const css=project.files.find(file=>file.path.endsWith('.css'));
    const html=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Untrusted Dylani preview</title>${css?`<link rel="stylesheet" href="${previewOrigin()}/${parts[0]}/${css.path}">`:''}</head><body><div id="root"></div><script type="module" crossorigin src="${previewOrigin()}/${parts[0]}/${js.path}"></script></body></html>`;
    response.writeHead(200,{...securityHeaders('text/html; charset=utf-8'),'Content-Length':Buffer.byteLength(html)});
    return response.end(request.method==='HEAD'?'':html);
  }

  if (parts.length===3&&parts[1]==='assets') {
    const asset=project.files.find(file=>file.path===`assets/${parts[2]}`);
    if (!asset) return fail(response);
    const type=asset.path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8';
    const body=Buffer.from(asset.content,'base64');
    response.writeHead(200,{...securityHeaders(type),...(asset.path.endsWith('.js')?{'Access-Control-Allow-Origin':'*'}:{}),'Content-Length':body.length});
    return response.end(request.method==='HEAD'?'':body);
  }
  return fail(response);
});

function publish(message) {
  if (!Array.isArray(message.files)||message.files.length<1||message.files.length>4) throw new Error('invalid files');
  let total=0;
  const files=message.files.map(file=>{
    if (!file||typeof file.path!=='string'||typeof file.content!=='string'||!/^assets\/index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(file.path)) throw new Error('invalid artifact');
    const bytes=Buffer.from(file.content,'base64');
    if (bytes.toString('base64')!==file.content) throw new Error('invalid encoding');
    total+=bytes.length;
    return {path:file.path,content:file.content};
  });
  if (total>maxBytes||files.filter(file=>file.path.endsWith('.js')).length!==1||files.filter(file=>file.path.endsWith('.css')).length>2) throw new Error('artifact limit');
  for (const [id,project] of projects) if (project.expires<Date.now()) projects.delete(id);
  while (projects.size>=maxArtifacts) projects.delete(projects.keys().next().value);
  const id=randomUUID().replaceAll('-','');
  projects.set(id,{files,expires:Date.now()+artifactTtlMs});
  process.stdout.write(`${JSON.stringify({type:'published',requestId:message.requestId,id,url:`${previewOrigin()}/${id}/index.html`})}\n`);
}

server.listen(0,host,()=>process.stdout.write(`${JSON.stringify({type:'ready',port:server.address().port})}\n`));
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  input+=chunk;
  if (Buffer.byteLength(input)>maxBytes*2) { input=''; return; }
  while (input.includes('\n')) {
    const newline=input.indexOf('\n');
    const line=input.slice(0,newline); input=input.slice(newline+1);
    let message;
    try { message=JSON.parse(line); } catch { continue; }
    try { if (message.type==='publish') publish(message); }
    catch { process.stdout.write(`${JSON.stringify({type:'error',requestId:message.requestId})}\n`); }
  }
});
process.stdin.on('end',()=>server.close(()=>process.exit(0)));
process.on('uncaughtException',()=>{});
