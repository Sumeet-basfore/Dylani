import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync,statSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PROJECT_FILE_PATHS,validateProjectFiles} from './react-project.js';

const serverDirectory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../runner');
const toolchainDirectory=path.join(serverDirectory,'toolchain');
const workerPath=path.join(serverDirectory,'worker.mjs');
const previewPath=path.join(serverDirectory,'preview-server.mjs');
const sandboxLimits=Object.freeze({memoryMax:'768M',memorySwapMax:'0',cpuQuota:'100%',tasksMax:'64',workspaceBytes:192*1024*1024,tempBytes:16*1024*1024,maxRuntimeMs:30_000,maxOutputBytes:4_500_000});
const approvedToolchain=Object.freeze({'@types/react':'19.3.0','@types/react-dom':'19.3.0','@vitejs/plugin-react':'4.4.1',autoprefixer:'10.4.20',postcss:'8.5.33',react:'19.1.0','react-dom':'19.1.0',tailwindcss:'3.4.17',typescript:'5.8.3',vite:'6.4.6'});

function safeFailure(message='Isolated React build is unavailable on this host') {
  return {status:'unavailable',errors:[{message}]};
}

function parseMessage(output) {
  try {
    const lines=output.trim().split('\n');
    return JSON.parse(lines.at(-1));
  } catch { return null; }
}

function getAppOrigins() {
  const port=Number(process.env.VITE_PORT||5173);
  if (!Number.isInteger(port)||port<1||port>65535) return [];
  return [`http://127.0.0.1:${port}`,`http://localhost:${port}`];
}

function matchesApprovedToolchain() {
  try {
    const manifest=JSON.parse(readFileSync(path.join(toolchainDirectory,'package.json'),'utf8'));
    const lock=JSON.parse(readFileSync(path.join(toolchainDirectory,'package-lock.json'),'utf8'));
    if (JSON.stringify(manifest.dependencies)!==JSON.stringify(approvedToolchain)||JSON.stringify(lock.packages?.['']?.dependencies)!==JSON.stringify(approvedToolchain)) return false;
    return Object.entries(approvedToolchain).every(([name,version])=>JSON.parse(readFileSync(path.join(toolchainDirectory,'node_modules',name,'package.json'),'utf8')).version===version);
  } catch { return false; }
}

class PreviewService {
  #child;
  #ready;
  #pending=new Map();
  #buffer='';
  #artifactTtlMs;

  constructor(artifactTtlMs) { this.#artifactTtlMs=artifactTtlMs; }

  async #start() {
    if (this.#ready) return this.#ready;
    this.#ready=new Promise((resolve,reject)=>{
      const bubblewrapArgs=[
        '--unshare-user','--unshare-pid','--unshare-ipc','--unshare-uts','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent','--cap-drop','ALL','--uid','65534','--gid','65534',
        '--ro-bind','/usr','/usr','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64',
        '--dir','/runner','--ro-bind',previewPath,'/runner/preview-server.mjs','--dir','/etc','--proc','/proc','--dev','/dev',
        '--clearenv','--setenv','PATH','/usr/bin','--setenv','HOME','/tmp','--setenv','NODE_ENV','production','--setenv','PWD','/runner',
        '--chdir','/runner','--','/usr/bin/node','/runner/preview-server.mjs','0',getAppOrigins().join(','),String(this.#artifactTtlMs)
      ];
      const environment={PATH:'/usr/bin',HOME:'/tmp',NODE_ENV:'production'};
      for (const key of ['XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) environment[key]=process.env[key];
      const child=spawn('/usr/bin/systemd-run',[
        '--user','--scope','--quiet','--property=MemoryMax=128M','--property=MemorySwapMax=0','--property=CPUQuota=25%','--property=TasksMax=16',
        '--','/usr/bin/bwrap',...bubblewrapArgs
      ],{
        cwd:'/tmp',env:environment,
        stdio:['pipe','pipe','ignore'],windowsHide:true
      });
      this.#child=child;
      const startTimer=setTimeout(()=>reject(new Error('preview-start-timeout')),3000);
      child.stdin.on('error',()=>{});
      child.once('error',error=>{clearTimeout(startTimer);reject(error);});
      child.once('exit',()=>{
        clearTimeout(startTimer);
        for (const {reject:fail} of this.#pending.values()) fail(new Error('preview-server-exited'));
        this.#pending.clear();
        this.#ready=null;
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        this.#buffer+=chunk;
        if (this.#buffer.length>5_000_000) { this.#child?.kill('SIGKILL'); return; }
        while (this.#buffer.includes('\n')) {
          const end=this.#buffer.indexOf('\n');
          const line=this.#buffer.slice(0,end); this.#buffer=this.#buffer.slice(end+1);
          let message;
          try { message=JSON.parse(line); } catch { continue; }
          if (message.type==='ready'&&Number.isInteger(message.port)) {
            clearTimeout(startTimer);
            resolve(message.port);
          } else if (message.type==='published'&&this.#pending.has(message.requestId)) {
            const pending=this.#pending.get(message.requestId); this.#pending.delete(message.requestId); pending.resolve(message.url);
          } else if (message.type==='error'&&this.#pending.has(message.requestId)) {
            const pending=this.#pending.get(message.requestId); this.#pending.delete(message.requestId); pending.reject(new Error('preview-publish-failed'));
          }
        }
      });
    });
    return this.#ready;
  }

  async publish(files) {
    const port=await this.#start();
    const requestId=randomBytes(8).toString('hex');
    const pending=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#pending.delete(requestId);reject(new Error('preview-publish-timeout'));},3000);
      this.#pending.set(requestId,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    });
    this.#child.stdin.write(`${JSON.stringify({type:'publish',requestId,files})}\n`);
    const url=await pending;
    if (!url.startsWith(`http://127.0.0.2:${port}/`)) throw new Error('invalid-preview-url');
    return url;
  }

  async close() {
    if (!this.#child) return;
    const child=this.#child;
    this.#child=null;
    child.stdin.end();
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,1000))]);
    if (child.exitCode===null) child.kill('SIGKILL');
    this.#ready=null;
  }
}

export function createReactBuildRunner({
  wallTimeoutMs=sandboxLimits.maxRuntimeMs,previewArtifactTtlMs=30*60_000,workspaceBytes=sandboxLimits.workspaceBytes,
  tempBytes=sandboxLimits.tempBytes,memoryMax=sandboxLimits.memoryMax,skipAvailabilityProbe=false
}={}) {
  const workspaceLimit=Number.isInteger(workspaceBytes)&&workspaceBytes>0?Math.min(workspaceBytes,sandboxLimits.workspaceBytes):sandboxLimits.workspaceBytes;
  const tempLimit=Number.isInteger(tempBytes)&&tempBytes>0?Math.min(tempBytes,sandboxLimits.tempBytes):sandboxLimits.tempBytes;
  const memoryMatch=typeof memoryMax==='string'?memoryMax.match(/^(\d+)M$/):null;
  const memoryLimit=memoryMatch&&Number(memoryMatch[1])>=64&&Number(memoryMatch[1])<=768?memoryMax:sandboxLimits.memoryMax;
  const limits=Object.freeze({...sandboxLimits,workspaceBytes:workspaceLimit,tempBytes:tempLimit,memoryMax:memoryLimit});
  const safeArtifactTtlMs=Number.isInteger(previewArtifactTtlMs)&&previewArtifactTtlMs>0&&previewArtifactTtlMs<=30*60_000?previewArtifactTtlMs:30*60_000;
  const preview=new PreviewService(safeArtifactTtlMs);
  let availability;

  function commandArguments(request,executionTimeoutMs=wallTimeoutMs) {
    const workspaceArg=String(limits.workspaceBytes);
    const tempArg=String(limits.tempBytes);
    const remaining=Math.max(0.001,executionTimeoutMs/1000).toFixed(3).replace(/0+$/,'').replace(/\.$/,'');
    return [
      '--user','--scope','--quiet',
      `--property=MemoryMax=${limits.memoryMax}`,
      `--property=MemorySwapMax=${limits.memorySwapMax}`,
      `--property=CPUQuota=${limits.cpuQuota}`,
      `--property=TasksMax=${limits.tasksMax}`,
      '--','/usr/bin/timeout','--signal=KILL','--kill-after=1s',`${remaining}s`,
      '/usr/bin/bwrap','--unshare-all','--unshare-user','--disable-userns','--assert-userns-disabled','--new-session','--die-with-parent',
      '--cap-drop','ALL','--uid','65534','--gid','65534',
      '--ro-bind','/usr','/usr','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64',
      '--ro-bind',toolchainDirectory,'/toolchain',
      '--dir','/runner','--ro-bind',workerPath,'/runner/worker.mjs',
      '--dir','/etc','--proc','/proc','--dev','/dev',
      '--size',workspaceArg,'--tmpfs','/workspace','--chmod','1777','/workspace',
      '--size',tempArg,'--tmpfs','/tmp','--chmod','1777','/tmp',
      '--clearenv','--setenv','PATH','/usr/bin','--setenv','HOME','/tmp','--setenv','NODE_ENV','production','--setenv','PWD','/workspace',
      '--chdir','/workspace','--','/usr/bin/node','/runner/worker.mjs'
    ];
  }

  function runSandbox(request,executionTimeoutMs=wallTimeoutMs) {
    return new Promise(resolve=>{
      let child;
      try {
        const environment={PATH:'/usr/bin',HOME:'/tmp',LANG:'C',NODE_ENV:'production'};
        for (const key of ['XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) environment[key]=process.env[key];
        child=spawn('/usr/bin/systemd-run',commandArguments(request,executionTimeoutMs),{cwd:'/tmp',env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
      } catch { resolve({error:'spawn'}); return; }
      const output=[]; let outputBytes=0; let errorBytes=0; let stderr=''; let completed=false;
      const timer=setTimeout(()=>{child.kill('SIGKILL');finish({timeout:true});},executionTimeoutMs+5000);
      function finish(result) { if (completed) return; completed=true; clearTimeout(timer); resolve(result); }
      child.stdout.on('data',chunk=>{
        outputBytes+=chunk.length;
        if (outputBytes>limits.maxOutputBytes) { child.kill('SIGKILL'); finish({error:'output-limit'}); return; }
        output.push(chunk);
      });
      child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes<16_384)stderr+=chunk.toString('utf8').slice(0,16_384-errorBytes);});
      child.stdin.on('error',()=>{});
      child.once('error',()=>finish({error:'spawn'}));
      child.once('close',(code,signal)=>{
        const stdout=Buffer.concat(output).toString('utf8');
        finish({code,signal,stdout,stderr});
      });
      child.stdin.end(JSON.stringify(request));
    });
  }

  async function checkAvailable() {
    if (process.platform!=='linux'||process.getuid?.()===0||!existsSync('/usr/bin/bwrap')||!existsSync('/usr/bin/systemd-run')||!existsSync('/usr/bin/timeout')||!existsSync(workerPath)||!existsSync(previewPath)||!matchesApprovedToolchain()) return false;
    try {
      if (!statSync(toolchainDirectory).isDirectory()) return false;
      const version=spawnSync('/usr/bin/bwrap',['--version'],{encoding:'utf8',timeout:1000,env:{PATH:'/usr/bin',HOME:'/tmp'}});
      if (version.status!==0) return false;
      const report=await getIsolationReport();
      return report&&Object.values(report).every(Boolean);
    } catch { return false; }
  }

  async function getIsolationReport(hostSecretPath) {
    let contacted=false;
    const service=createServer((_request,response)=>{contacted=true;response.end('loopback probe');});
    try {
      await new Promise((resolve,reject)=>{
        service.once('error',reject);
        service.listen(0,'127.0.0.1',resolve);
      });
      const address=service.address();
      const probe=await runSandbox({
        action:'probe',
        ...(hostSecretPath?{hostSecretPath}:{}),
        loopbackProbeURL:`http://127.0.0.1:${address.port}/probe`
      },sandboxLimits.maxRuntimeMs);
      if (probe.timeout||probe.error||probe.code!==0) return null;
      const result=parseMessage(probe.stdout);
      if (result?.status!=='probe') return null;
      result.checks.loopbackServiceBlocked=result.checks.loopbackNetworkBlocked&&!contacted;
      delete result.checks.loopbackNetworkBlocked;
      return result.checks;
    } catch { return null; }
    finally { service.close(); }
  }

  async function getResourceLimitReport() {
    const execution=await runSandbox({action:'resource-probe',workspaceBytes:limits.workspaceBytes,tempBytes:limits.tempBytes},sandboxLimits.maxRuntimeMs);
    if (execution.timeout||execution.error||execution.code!==0) return null;
    const result=parseMessage(execution.stdout);
    return result?.status==='resource-probe'?result:null;
  }

  async function runMemoryLimitProbe() {
    const execution=await runSandbox({action:'memory-probe'},sandboxLimits.maxRuntimeMs);
    if (execution.timeout||execution.error) return null;
    return {code:execution.code,signal:execution.signal,stderr:execution.stderr,result:parseMessage(execution.stdout)};
  }

  async function runTimeoutCleanupProbe(processToken) {
    const execution=await runSandbox({action:'timeout-probe',processToken});
    return {timeout:execution.timeout===true,code:execution.code,signal:execution.signal,output:execution.stdout,stderr:execution.stderr};
  }

  async function isAvailable() {
    if (!availability) availability=skipAvailabilityProbe?checkFilesOnly():checkAvailable();
    return availability;
  }

  async function checkFilesOnly() {
    return process.platform==='linux'&&existsSync('/usr/bin/bwrap')&&existsSync('/usr/bin/systemd-run')&&existsSync(path.join(toolchainDirectory,'node_modules/vite/package.json'));
  }

  async function build(inputFiles) {
    let files;
    try { files=validateProjectFiles(inputFiles); }
    catch (error) {
      const message=/unsafe file path/.test(error.message)?'Project contains an unsafe file path':/unapproved dependency/.test(error.message)?'Project contains an unapproved dependency':'Project files failed the fixed template allowlist';
      return {status:'rejected',errors:[{message}]};
    }
    if (!(await isAvailable())) return safeFailure();
    const execution=await runSandbox({action:'build',files});
    if (execution.timeout||execution.code===124||execution.code===137) return {status:'failed',exitCode:execution.code??null,logs:'Build exceeded its wall-clock limit or was terminated by a resource limit',errors:[{message:'Build exceeded its wall-clock limit or was terminated by a resource limit'}]};
    if (execution.error) return {status:'failed',exitCode:null,logs:'Isolated build was stopped safely',errors:[{message:'Isolated build was stopped safely'}]};
    const result=parseMessage(execution.stdout);
    if (!result) return {status:'failed',exitCode:execution.code,logs:'Build stopped before returning a result (wall-clock limit, resource limit, or runner failure)',errors:[{message:'Build stopped before returning a result (wall-clock limit, resource limit, or runner failure)'}]};
    if (!['built','failed','rejected'].includes(result.status)) return {status:'failed',exitCode:execution.code,logs:'Isolated build returned an invalid response',errors:[{message:'Isolated build returned an invalid response'}]};
    if (result.status!=='built') return {status:result.status,exitCode:execution.code,logs:(Array.isArray(result.logs)?result.logs.join('\n'):(result.errors||[]).map(item=>typeof item==='string'?item:[item.file,item.line,item.column,item.message].filter(Boolean).join(':')).join('\n')).slice(0,16_384),errors:result.errors||[]};
    if (execution.code!==0||!Array.isArray(result.files)) return {status:'failed',exitCode:execution.code,logs:'Isolated build exited unsuccessfully',errors:[{message:'Isolated build exited unsuccessfully'}]};
    try {
      const previewUrl=await preview.publish(result.files);
      return {status:'built',exitCode:execution.code,logs:(Array.isArray(result.logs)?result.logs.join('\n'):'Build completed').slice(0,16_384),previewUrl};
    } catch {
      return {status:'preview-unavailable',exitCode:execution.code,logs:'Build completed, but the separate preview server is unavailable',errors:[{message:'Static preview delivery is unavailable'}]};
    }
  }

  return {build,isAvailable,getIsolationReport,getResourceLimitReport,runMemoryLimitProbe,runTimeoutCleanupProbe,close:()=>preview.close(),limits,projectPaths:PROJECT_FILE_PATHS};
}
