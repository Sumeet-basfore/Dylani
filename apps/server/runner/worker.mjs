import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,readdir,stat,chmod,symlink} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';

const PROJECT_PATHS=[
  'README.md','index.html','package.json','postcss.config.js','tailwind.config.ts','tsconfig.json','vite.config.ts',
  'src/App.tsx','src/design-spec.ts','src/index.css','src/main.tsx','src/vite-env.d.ts'
];
const MAX_INPUT_BYTES=400_000;
const MAX_ARTIFACT_BYTES=3_000_000;
const MAX_ARTIFACT_FILES=4;

async function respond(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function validFiles(files) {
  if (!Array.isArray(files) || files.length!==PROJECT_PATHS.length) return false;
  const seen=new Set();
  let size=0;
  for (const file of files) {
    if (!file || typeof file.path!=='string' || typeof file.content!=='string') return false;
    const parts=file.path.split('/');
    if (file.path.startsWith('/') || file.path.includes('\\') || parts.some(part=>!part||part==='.'||part==='..')) return false;
    if (!PROJECT_PATHS.includes(file.path) || seen.has(file.path)) return false;
    seen.add(file.path);
    size+=Buffer.byteLength(file.content);
    if (size>300_000) return false;
  }
  return PROJECT_PATHS.every(file=>seen.has(file));
}

async function writeProject(files) {
  const project='/workspace/project';
  await mkdir(`${project}/src`,{recursive:true,mode:0o755});
  await mkdir('/workspace/artifacts',{recursive:true,mode:0o755});
  for (const file of files) {
    const destination=path.resolve(project,file.path);
    if (!destination.startsWith(`${project}/`)) throw new Error('unsafe-path');
    await writeFile(destination,file.content,{encoding:'utf8',flag:'wx',mode:0o444});
  }
  await symlink('/toolchain/node_modules',`${project}/node_modules`,'dir');
  await chmod(`${project}/src`,0o555);
  await chmod(project,0o555);
}

function cleanDiagnostic(diagnostic,ts) {
  if (!diagnostic.file) return {message:'TypeScript validation failed'};
  const position=diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start??0);
  const relative=path.relative('/workspace/project',diagnostic.file.fileName).split(path.sep).join('/');
  const file=PROJECT_PATHS.includes(relative)?relative:'source';
  return {file,line:position.line+1,column:position.character+1,code:diagnostic.code,message:`TypeScript validation failed (TS${diagnostic.code})`};
}

async function typecheck() {
  const require=createRequire('/toolchain/package.json');
  const ts=require('typescript');
  const rootNames=['src/App.tsx','src/design-spec.ts','src/main.tsx','src/vite-env.d.ts'].map(file=>`/workspace/project/${file}`);
  const options={
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    jsx:ts.JsxEmit.ReactJSX,strict:true,skipLibCheck:true,noEmit:true,isolatedModules:true,
    allowImportingTsExtensions:true,resolveJsonModule:true,allowSyntheticDefaultImports:true,
    lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts']
  };
  const program=ts.createProgram({rootNames,options});
  const diagnostics=ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) return diagnostics.slice(0,20).map(item=>cleanDiagnostic(item,ts));
  return [];
}

function expectedTailwindConfig(spec) {
  return {
    content:['/workspace/project/index.html','/workspace/project/src/**/*.{ts,tsx}'],
    theme:{extend:{
      colors:{brand:'var(--token-color-brand)',background:'var(--token-color-background)',surface:'var(--token-color-surface)',foreground:'var(--token-color-foreground)',muted:'var(--token-color-muted)'},
      borderRadius:{card:'var(--token-radius-card)',button:'var(--token-radius-button)'},
      spacing:{section:'var(--token-spacing-section)'}
    }},
    plugins:[]
  };
}

async function listArtifacts() {
  const files=[];
  let total=0;
  async function visit(directory) {
    for (const entry of await readdir(directory,{withFileTypes:true})) {
      const full=path.join(directory,entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const relative=path.relative('/workspace/artifacts',full).split(path.sep).join('/');
        if (relative==='index.html') continue;
        if (!/^assets\/index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(relative)) throw new Error('unsafe-artifact');
        const info=await stat(full);
        total+=info.size;
        if (files.length>=MAX_ARTIFACT_FILES || total>MAX_ARTIFACT_BYTES) throw new Error('artifact-limit');
        const content=await readFile(full);
        files.push({path:relative,content:content.toString('base64')});
      } else throw new Error('unsafe-artifact');
    }
  }
  await visit('/workspace/artifacts');
  const scripts=files.filter(file=>file.path.endsWith('.js'));
  if (scripts.length!==1 || files.some(file=>!file.path.endsWith('.js')&&!file.path.endsWith('.css'))) throw new Error(`unexpected-artifacts-${files.length}-${scripts.length}`);
  return files;
}

async function verifyWorkspaceBoundary() {
  const entries=(await readdir('/workspace')).sort();
  if (entries.join(',')!=='artifacts,project') throw new Error('workspace-boundary');
}

async function build(files) {
  if (!validFiles(files)) return {status:'rejected',logs:['Project files rejected by the fixed template allowlist'],errors:['Project files failed the fixed template allowlist']};
  let manifest;
  try { manifest=JSON.parse(files.find(file=>file.path==='package.json').content); }
  catch { return {status:'rejected',logs:['Project manifest rejected'],errors:['Project manifest is invalid']}; }
  const manifestKeys=['name','private','type','scripts','dependencies','devDependencies'];
  if (!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).sort().join(',')!==[...manifestKeys].sort().join(',')||manifest.name!=='dylani-generated-design'||manifest.private!==true||manifest.type!=='module') return {status:'rejected',logs:['Project manifest rejected'],errors:['Project manifest is invalid']};
  if (JSON.stringify(manifest.dependencies)!==JSON.stringify({react:'19.1.0','react-dom':'19.1.0'}) ||
      JSON.stringify(manifest.devDependencies)!==JSON.stringify({'@types/react':'19.3.0','@types/react-dom':'19.3.0','@vitejs/plugin-react':'4.4.1',autoprefixer:'10.4.20',postcss:'8.5.33',tailwindcss:'3.4.17',typescript:'5.8.3',vite:'6.4.6'}) ||
      JSON.stringify(manifest.scripts)!==JSON.stringify({dev:'vite --host 127.0.0.1',build:'tsc --noEmit && vite build',preview:'vite preview --host 127.0.0.1'})) {
    return {status:'rejected',logs:['Project dependency or command allowlist failed'],errors:['Project dependency or command allowlist failed']};
  }
  const specSource=files.find(file=>file.path==='src/design-spec.ts').content;
  const match=specSource.match(/export const designSpec = ([\s\S]+) satisfies DesignSpec;\n$/);
  if (!match) return {status:'rejected',logs:['DesignSpec source rejected'],errors:['DesignSpec source is invalid']};
  let spec;
  try { spec=JSON.parse(match[1]); } catch { return {status:'rejected',logs:['DesignSpec source rejected'],errors:['DesignSpec source is invalid']}; }
  await writeProject(files);
  const logs=['Validated fixed project files and dependency allowlist','TypeScript typecheck started'];
  const diagnostics=await typecheck();
  if (diagnostics.length) return {status:'failed',logs:[...logs,...diagnostics.map(item=>item.message)],errors:diagnostics};
  logs.push('TypeScript typecheck passed','Vite production bundle started');

  const require=createRequire('/toolchain/package.json');
  const {build:buildWithVite}=await import(pathToFileURL('/toolchain/node_modules/vite/dist/node/index.js'));
  const react=(await import(pathToFileURL('/toolchain/node_modules/@vitejs/plugin-react/dist/index.mjs'))).default;
  const tailwindcss=require('tailwindcss');
  const autoprefixer=require('autoprefixer');
  const config=expectedTailwindConfig(spec);
  try {
    await buildWithVite({
      configFile:false,root:'/workspace/project',logLevel:'silent',plugins:[react()],
      css:{postcss:{plugins:[tailwindcss({config}),autoprefixer()]}},
      build:{outDir:'/workspace/artifacts',assetsDir:'assets',emptyOutDir:true,sourcemap:false,manifest:false,write:true,reportCompressedSize:false}
    });
  } catch {
    return {status:'failed',logs:[...logs,'Vite production bundle failed'],errors:[{message:'React project compilation failed'}]};
  }
  try {
    await verifyWorkspaceBoundary();
    return {status:'built',logs:[...logs,'Vite production bundle completed','Workspace boundary and static artifact allowlists passed'],files:await listArtifacts()};
  }
  catch (error) { return {status:'failed',logs:[...logs,'Static artifact validation failed'],errors:[{message:typeof error?.message==='string'&&/^unexpected-artifacts-\d+-\d+$/.test(error.message)?`Build output failed artifact validation (${error.message.slice(20)})`:'Build output failed artifact validation'}]}; }
}

async function isolationProbe(hostSecretPath,loopbackProbeURL) {
  const checks={nonRoot:process.getuid()===65534,cleanEnvironment:Object.keys(process.env).sort().join(',')==='HOME,NODE_ENV,PATH,PWD',credentialNotPresent:process.env.DYLANI_RUNNER_TEST_SECRET===undefined,homeNotMounted:!(await import('node:fs')).existsSync('/home'),hostEtcNotMounted:!(await import('node:fs')).existsSync('/etc/passwd')};
  if (typeof hostSecretPath==='string'&&/^\/tmp\/dylani-isolation-probe-[a-f0-9]{16}$/.test(hostSecretPath)) {
    try { await readFile(hostSecretPath); checks.hostSecretFileNotReadable=false; }
    catch { checks.hostSecretFileNotReadable=true; }
  }
  try { await writeFile(`/usr/lib/dylani-probe-${randomBytes(6).toString('hex')}`,'probe'); checks.baseFilesystemReadOnly=false; }
  catch { checks.baseFilesystemReadOnly=true; }
  try { await fetch('http://1.1.1.1',{signal:AbortSignal.timeout(300)}); checks.networkBlocked=false; }
  catch { checks.networkBlocked=true; }
  checks.loopbackNetworkBlocked=false;
  try {
    const probeURL=new URL(loopbackProbeURL||'');
    if (probeURL.protocol==='http:'&&probeURL.hostname==='127.0.0.1'&&/^\d+$/.test(probeURL.port)&&probeURL.pathname==='/probe') {
      await fetch(probeURL,{signal:AbortSignal.timeout(300)});
    }
  } catch { checks.loopbackNetworkBlocked=true; }
  return {status:'probe',checks};
}

async function fillUntilBoundedLimit(filePath,limitBytes) {
  const {open,unlink}=await import('node:fs/promises');
  const handle=await open(filePath,'wx',0o600);
  const chunk=Buffer.alloc(64*1024,0x5a);
  let bytesWritten=0;
  let failureCode;
  try {
    while (bytesWritten<=limitBytes) {
      try {
        const result=await handle.write(chunk);
        bytesWritten+=result.bytesWritten;
        if (result.bytesWritten===0) { failureCode='ENOSPC'; break; }
      } catch (error) { failureCode=error?.code; break; }
    }
  } finally {
    await handle.close();
    await unlink(filePath).catch(()=>{});
  }
  return {enforced:failureCode==='ENOSPC'&&bytesWritten<=limitBytes,bytesWritten,failureCode};
}

async function processLimitProbe() {
  const children=[];
  let failureCode;
  for (let index=0;index<80;index++) {
    const outcome=await new Promise(resolve=>{
      const child=spawn('/usr/bin/sleep',['30'],{stdio:'ignore'});
      child.once('spawn',()=>resolve({child}));
      child.once('error',error=>resolve({code:error?.code}));
    });
    if (outcome.child) children.push(outcome.child);
    else { failureCode=outcome.code; break; }
  }
  const closed=children.map(child=>new Promise(resolve=>child.once('close',resolve)));
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(closed);
  return {enforced:failureCode==='EAGAIN'&&children.length<80,started:children.length,cleanupComplete:children.every(child=>child.exitCode!==null||child.signalCode!==null)};
}

async function resourceLimitProbe(workspaceBytes,tempBytes) {
  const workspace=await fillUntilBoundedLimit('/workspace/resource-limit-probe.bin',workspaceBytes);
  const temporary=await fillUntilBoundedLimit('/tmp/resource-limit-probe.bin',tempBytes);
  const processes=await processLimitProbe();
  return {status:'resource-probe',checks:{workspace,temp:temporary,processes}};
}

async function memoryLimitProbe() {
  const program="const blocks=[];for(let i=0;i<64;i++){const block=Buffer.alloc(4*1024*1024);block.fill(7);blocks.push(block)}";
  const child=spawn('/usr/bin/node',['-e',program],{stdio:'ignore'});
  const {code,signal}=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  return {status:'memory-probe',checks:{memoryLimitEnforced:signal==='SIGKILL'||code===137,childExitCode:code,childSignal:signal}};
}

async function timeoutCleanupProbe(processToken) {
  if (typeof processToken!=='string'||!/^dylani-child-[a-f0-9]{16}$/.test(processToken)) throw new Error('invalid-timeout-probe');
  const childProgram="process.title=process.argv[1];setTimeout(()=>{},60000)";
  const child=spawn('/usr/bin/node',['-e',childProgram,processToken],{stdio:'ignore'});
  await new Promise((resolve,reject)=>{ child.once('spawn',resolve); child.once('error',reject); });
  await respond({status:'timeout-probe-started'});
  await new Promise(()=>{});
}

try {
  let raw='';
  for await (const chunk of process.stdin) {
    raw+=chunk;
    if (Buffer.byteLength(raw)>MAX_INPUT_BYTES) throw new Error('input-limit');
  }
  const request=JSON.parse(raw);
  if (request.action==='probe') await respond(await isolationProbe(request.hostSecretPath,request.loopbackProbeURL));
  else if (request.action==='resource-probe') await respond(await resourceLimitProbe(request.workspaceBytes,request.tempBytes));
  else if (request.action==='memory-probe') await respond(await memoryLimitProbe());
  else if (request.action==='timeout-probe') await timeoutCleanupProbe(request.processToken);
  else if (request.action==='build') {
    const result=await build(request.files);
    await respond(result);
    if (result.status==='failed') process.exitCode=1;
  }
  else throw new Error('invalid-request');
} catch (error) {
  const code=typeof error?.code==='string'?error.code:typeof error?.name==='string'?error.name:'unknown';
  await respond({status:'failed',logs:['Isolated build failed safely'],errors:[{message:`Isolated build failed safely (${code})`}]});
  process.exitCode=1;
}
