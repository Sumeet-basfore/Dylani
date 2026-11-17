import http from 'node:http';
import {DESIGN_SPEC_VERSION} from '@dylani/design-spec';
import {generateReactProjectFiles} from '../../apps/server/src/react-project.js';
import {createReactBuildRunner} from '../../apps/server/src/react-runner.js';

const port=4173;
const runner=createReactBuildRunner();
const expiringRunners=new Set();
let previewUrl;
let canaryRequests=0;
let server;

const spec={
  schemaVersion:DESIGN_SPEC_VERSION,platform:'web',pageType:'dashboard',requirements:['Show a security test metric'],
  layout:{kind:'single-column',density:'comfortable'},
  tokens:{color:{brand:'#7966f5',background:'#0e1018',surface:'#191c28',foreground:'#f8f9ff',muted:'#a4a8bf'},radius:{card:'18px',button:'12px'},spacing:{section:'32px'}},
  components:[{id:'security',type:'hero',title:'React runtime is active',children:[{id:'metric',type:'metric',label:'Preview',value:'ready'}]}],
  responsive:{mobile:'stack',desktop:'centered'},selectedSkills:['typography','layout','responsive','accessibility']
};

function html() {
  if (!previewUrl) return '<!doctype html><html><body data-runner-available="false">Isolated runner unavailable</body></html>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dylani browser security fixture</title></head><body><main id="studio">Studio fixture</main><script>
    document.cookie='dylani_app_secret=fixture-cookie; SameSite=Lax; path=/';
    localStorage.setItem('dylani-app-secret','fixture-storage-value');
    window.__probe=null;
    window.addEventListener('message',event=>{if(event.data?.type==='dylani-security-probe')window.__probe=event.data});
  </script><iframe title="Untrusted generated React preview" sandbox="allow-scripts" referrerpolicy="no-referrer" src="${previewUrl}"></iframe></body></html>`;
}

async function buildPreview(selectedRunner,source) {
  const files=generateReactProjectFiles(spec);
  const app=files.find(file=>file.path==='src/App.tsx');
  app.content=app.content.replace('export default function App() {',`${source}\n\nexport default function App() {`);
  return selectedRunner.build(files);
}

async function start() {
  if (await runner.isAvailable()) {
    const source=`if (typeof window !== 'undefined') {
      let parentDocumentBlocked=false; let parentStorageBlocked=false;
      try { void window.parent.document.body; } catch (error) { parentDocumentBlocked=error instanceof DOMException&&error.name==='SecurityError'; }
      try { window.parent.localStorage.getItem('dylani-app-secret'); } catch (error) { parentStorageBlocked=error instanceof DOMException&&error.name==='SecurityError'; }
      let ownCookie=''; try { ownCookie=document.cookie; } catch { ownCookie='blocked'; }
      window.parent.postMessage({type:'dylani-security-probe',parentDocumentBlocked,parentStorageBlocked,ownCookie,ownOrigin:window.origin},'*');
      fetch('http://127.0.0.1:${port}/blocked-network-canary').catch(()=>{});
      try { window.top!.location.href='http://127.0.0.1:${port}/top-navigation-canary'; } catch {}
    }`;
    const result=await buildPreview(runner,source);
    if (result.status==='built') previewUrl=result.previewUrl;
  }

  server=http.createServer(async(request,response)=>{
    const pathname=new URL(request.url,'http://fixture.invalid').pathname;
    if (request.method!=='GET') { response.writeHead(405).end(); return; }
    if (pathname==='/') { response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}).end(html()); return; }
    if (pathname==='/blocked-network-canary'||pathname==='/top-navigation-canary') { canaryRequests++; response.writeHead(200).end('unexpected request'); return; }
    if (pathname==='/api/expired-preview') {
      const expiringRunner=createReactBuildRunner({previewArtifactTtlMs:1000});
      expiringRunners.add(expiringRunner);
      const result=await buildPreview(expiringRunner,'');
      response.writeHead(result.status==='built'?200:503,{'Content-Type':'application/json'}).end(JSON.stringify({previewUrl:result.previewUrl||null,status:result.status}));
      return;
    }
    if (pathname==='/api/canary-count') { response.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({count:canaryRequests})); return; }
    response.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
}

await start();
async function close() {
  await Promise.all([runner.close(),...Array.from(expiringRunners,instance=>instance.close())]);
  if (server?.listening) await new Promise(resolve=>server.close(resolve));
}
process.on('SIGINT',()=>close().finally(()=>process.exit(0)));
process.on('SIGTERM',()=>close().finally(()=>process.exit(0)));
