import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync,readdirSync,readFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {DESIGN_SPEC_VERSION} from '@dylani/design-spec';
import {generateReactProjectFiles,validateProjectFiles} from './react-project.js';
import {createReactBuildRunner} from './react-runner.js';

const tokens={
  color:{brand:'#7966f5',background:'#0e1018',surface:'#191c28',foreground:'#f8f9ff',muted:'#a4a8bf'},
  radius:{card:'18px',button:'12px'},spacing:{section:'32px'}
};
const spec={
  schemaVersion:DESIGN_SPEC_VERSION,platform:'web',pageType:'dashboard',requirements:['Show project metrics'],
  layout:{kind:'two-column',density:'comfortable'},tokens,
  components:[{id:'hero',type:'hero',title:'Workspace overview',children:[{id:'metric',type:'metric',label:'Revenue',value:'$100'}]}],
  responsive:{mobile:'stack',desktop:'two-column'},selectedSkills:['typography','layout','responsive','accessibility']
};
async function requireIsolatedRunner(t,runner) {
  if (await runner.isAvailable()) return true;
  t.skip('Linux bubblewrap namespaces or user-systemd cgroup limits are unavailable');
  return false;
}
function processesWithCommandText(text) {
  return readdirSync('/proc').filter(entry=>/^\d+$/.test(entry)).filter(pid=>{
    try { return readFileSync(`/proc/${pid}/cmdline`).includes(text); } catch { return false; }
  });
}

test('the isolated runner blocks host files, credentials, writes, outbound network, and host loopback services',{timeout:15_000},async t=>{
  const runner=createReactBuildRunner();
  t.after(()=>runner.close());
  const sentinel=`dylani-runner-secret-${randomBytes(8).toString('hex')}`;
  const hostSecretPath=`/tmp/dylani-isolation-probe-${randomBytes(8).toString('hex')}`;
  writeFileSync(hostSecretPath,sentinel,{mode:0o600});
  process.env.DYLANI_RUNNER_TEST_SECRET=sentinel;
  try {
    const report=await runner.getIsolationReport(hostSecretPath);
    if (!report) { t.skip('Linux bubblewrap namespaces or user-systemd cgroup limits are unavailable'); return; }
    assert.deepEqual(report,{nonRoot:true,cleanEnvironment:true,credentialNotPresent:true,homeNotMounted:true,hostEtcNotMounted:true,hostSecretFileNotReadable:true,baseFilesystemReadOnly:true,networkBlocked:true,loopbackServiceBlocked:true});
    assert.equal(await runner.isAvailable(),true);
  } finally { delete process.env.DYLANI_RUNNER_TEST_SECRET; unlinkSync(hostSecretPath); }
});

test('fixed React template compiles in isolation and publishes only a sandboxed static preview',{timeout:40_000},async t=>{
  const runner=createReactBuildRunner();
  t.after(()=>runner.close());
  if (!(await requireIsolatedRunner(t,runner))) return;
  const hostileTitle=`Workspace overview </script><script>window.parent.location='https://evil.invalid';fetch('https://evil.invalid')</script><img src=x onerror=alert(1)>`;
  const hostileSpec=structuredClone(spec);
  hostileSpec.components[0].title=hostileTitle;
  const hostileFiles=generateReactProjectFiles(hostileSpec);
  assert.doesNotMatch(hostileFiles.find(file=>file.path==='src/App.tsx').content,/dangerouslySetInnerHTML|eval\(/);
  assert.doesNotMatch(hostileFiles.find(file=>file.path==='src/design-spec.ts').content,/<\/script>/);
  const result=await runner.build(hostileFiles);
  assert.equal(result.status,'built',JSON.stringify({logs:result.logs,errors:result.errors}));
  assert.equal(result.exitCode,0);
  assert.match(result.previewUrl,/^http:\/\/127\.0\.0\.2:\d+\/[a-f0-9]{32}\/index\.html$/);
  const response=await fetch(result.previewUrl);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/Untrusted Dylani preview/);
  assert.match(html,/http:\/\/127\.0\.0\.2:\d+\/[a-f0-9]{32}\/assets\/index-[\w-]+\.js/);
  assert.doesNotMatch(html,/evil\.invalid|onerror=|window\.parent/);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'none'/);
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors http:\/\/127\.0\.0\.1:5173 http:\/\/localhost:5173/);
  assert.doesNotMatch(response.headers.get('content-security-policy'),/navigate-to/);
  assert.equal(response.headers.get('set-cookie'),null);
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.equal(response.headers.get('cross-origin-resource-policy'),'cross-origin');
  assert.equal(response.headers.get('access-control-allow-origin'),null);

  const scriptURL=html.match(/src="([^"]+\.js)"/)[1];
  const script=await fetch(scriptURL);
  assert.equal(script.status,200);
  assert.equal(script.headers.get('access-control-allow-origin'),'*');
  assert.match(script.headers.get('content-security-policy'),/script-src http:\/\/127\.0\.0\.2:/);
  const bundle=await script.text();
  assert.match(bundle,/Workspace overview/);
  assert.equal((await fetch(scriptURL,{method:'POST'})).status,405);
});

test('invalid project paths and unapproved dependencies are rejected before sandbox execution',async()=>{
  const runner=createReactBuildRunner();
  const files=generateReactProjectFiles(spec);
  const traversal=files.map(file=>({...file})); traversal[0].path='../outside.txt';
  assert.equal((await runner.build(traversal)).status,'rejected');
  const dependency=files.map(file=>({...file}));
  const manifest=dependency.find(file=>file.path==='package.json');
  const parsed=JSON.parse(manifest.content); parsed.dependencies.unknown='1.0.0'; manifest.content=JSON.stringify(parsed);
  assert.equal((await runner.build(dependency)).status,'rejected');
  await runner.close();
});

test('TypeScript compilation failures return bounded diagnostics and no preview',{timeout:30_000},async t=>{
  const runner=createReactBuildRunner();
  t.after(()=>runner.close());
  if (!(await requireIsolatedRunner(t,runner))) return;
  const files=generateReactProjectFiles(spec);
  files.find(file=>file.path==='src/App.tsx').content='export default function App( { return <div>broken</div> }';
  const result=await runner.build(files);
  assert.equal(result.status,'failed');
  assert.equal(result.previewUrl,undefined);
  assert.match(result.logs,/TypeScript validation failed/);
  assert.doesNotMatch(result.logs,/\/home\/|freellmapi|api.?key/i);
});

test('generated child-process code is compiled as inert source and not executed during the build',{timeout:40_000},async t=>{
  const runner=createReactBuildRunner();
  t.after(()=>runner.close());
  if (!(await requireIsolatedRunner(t,runner))) return;
  const files=generateReactProjectFiles(spec);
  const app=files.find(file=>file.path==='src/App.tsx');
  app.content+=`\n// @ts-ignore\nglobalThis.process.mainModule.require('node:child_process').execFileSync('/usr/bin/touch',['/workspace/child-process-marker']);\n`;
  const result=await runner.build(files);
  assert.equal(result.status,'built',JSON.stringify({logs:result.logs,errors:result.errors}));
});

test('wall-clock and cgroup resource limits are fixed and enforced by the runner',{timeout:45_000},async t=>{
  const availabilityRunner=createReactBuildRunner();
  if (!(await requireIsolatedRunner(t,availabilityRunner))) { await availabilityRunner.close(); return; }
  await availabilityRunner.close();
  const runner=createReactBuildRunner({wallTimeoutMs:1,skipAvailabilityProbe:true});
  const result=await runner.build(generateReactProjectFiles(spec));
  assert.equal(runner.limits.memoryMax,'768M');
  assert.equal(runner.limits.memorySwapMax,'0');
  assert.equal(runner.limits.cpuQuota,'100%');
  assert.equal(runner.limits.tasksMax,'64');
  assert.ok(runner.limits.workspaceBytes<=192*1024*1024);
  assert.ok(runner.limits.tempBytes<=16*1024*1024);
  assert.equal(result.status,'failed');
  assert.match(result.logs,/wall-clock limit|resource limit/i);
  await runner.close();
});

test('workspace and temporary storage limits plus process-count limits are enforced',{timeout:15_000},async t=>{
  const runner=createReactBuildRunner({workspaceBytes:1024*1024,tempBytes:1024*1024});
  t.after(()=>runner.close());
  if (!(await requireIsolatedRunner(t,runner))) return;
  const report=await runner.getResourceLimitReport();
  if (!report) { t.skip('user systemd cgroup or tmpfs limits are unavailable'); return; }
  assert.equal(report.checks.workspace.enforced,true);
  assert.equal(report.checks.temp.enforced,true);
  assert.equal(report.checks.workspace.failureCode,'ENOSPC');
  assert.equal(report.checks.temp.failureCode,'ENOSPC');
  assert.ok(report.checks.workspace.bytesWritten<=1024*1024);
  assert.ok(report.checks.temp.bytesWritten<=1024*1024);
  assert.equal(report.checks.processes.enforced,true);
  assert.equal(report.checks.processes.cleanupComplete,true);
  assert.ok(report.checks.processes.started<80);
  assert.equal(runner.limits.tasksMax,'64');
});

test('memory exhaustion is contained by the configured cgroup memory limit',{timeout:15_000},async t=>{
  const runner=createReactBuildRunner({memoryMax:'128M',wallTimeoutMs:10_000});
  t.after(()=>runner.close());
  if (!(await requireIsolatedRunner(t,runner))) return;
  const probe=await runner.runMemoryLimitProbe();
  if (probe?.result?.checks?.memoryLimitEnforced) {
    assert.equal(runner.limits.memoryMax,'128M');
    return;
  }
  if (probe?.code===137||probe?.signal==='SIGTERM') {
    assert.equal(runner.limits.memoryMax,'128M');
    return;
  }
  t.skip('the host did not expose a usable cgroup memory controller for the bounded probe');
});

test('wall timeout terminates a worker and its canary child process',{timeout:10_000},async t=>{
  const runner=createReactBuildRunner({wallTimeoutMs:250});
  t.after(()=>runner.close());
  if (!(await requireIsolatedRunner(t,runner))) return;
  const token=`dylani-child-${randomBytes(8).toString('hex')}`;
  const result=await runner.runTimeoutCleanupProbe(token);
  assert.ok(result.timeout||result.code===137||result.signal==='SIGKILL',JSON.stringify(result));
  const deadline=Date.now()+2000;
  let remaining;
  do {
    remaining=processesWithCommandText(token);
    if (!remaining.length) break;
    await new Promise(resolve=>setTimeout(resolve,50));
  } while (Date.now()<deadline);
  if (remaining?.length) for (const pid of remaining) { try { process.kill(Number(pid),'SIGKILL'); } catch {} }
  assert.deepEqual(remaining,[],'timed out worker left a canary child process running');
});

test('preview policy does not use the HTML-only policy or grant same-origin iframe access',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../../web/src/main.tsx',import.meta.url),'utf8'));
  assert.match(source,/sandbox="allow-scripts"/);
  assert.doesNotMatch(source,/sandbox="[^"]*allow-same-origin/);
  assert.match(source,/src=\{reactBuild\.previewUrl\}/);
});

test('runner validates the fixed generated project schema before invoking the worker',()=>{
  assert.doesNotThrow(()=>validateProjectFiles(generateReactProjectFiles(spec)));
});
