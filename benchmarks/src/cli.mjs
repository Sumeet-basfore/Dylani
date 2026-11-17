import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBenchmark} from './pipeline.mjs';

const packageDirectory=path.dirname(fileURLToPath(import.meta.url));
const options={fixture:false,promptIds:[],outputRoot:path.resolve(packageDirectory,'../runs')};
const args=process.argv.slice(2);
for (let index=0;index<args.length;index++) {
  const arg=args[index];
  if (arg==='--fixture') options.fixture=true;
  else if (arg==='--prompt-id'&&args[index+1]) options.promptIds.push(args[++index]);
  else if (arg==='--output'&&args[index+1]) options.outputRoot=path.resolve(args[++index]);
  else if (arg==='--model'&&args[index+1]) options.model=args[++index];
  else if (arg==='--provider'&&args[index+1]) options.provider=args[++index];
  else if (arg==='--base-url'&&args[index+1]) options.baseURL=args[++index];
  else if (arg==='--help') {
    process.stdout.write('Usage: npm run run -- [--fixture] [--prompt-id ID] [--output DIR] [--model MODEL] [--provider PROVIDER] [--base-url URL]\n');
    process.exit(0);
  } else {
    process.stderr.write('Unknown or incomplete benchmark option. Use --help.\n');
    process.exit(2);
  }
}

try {
  const result=await runBenchmark({...options,promptIds:options.promptIds.length?options.promptIds:null});
  process.stdout.write(`${JSON.stringify({runId:result.runId,runDirectory:result.runDirectory,comparisonReport:result.reportPath})}\n`);
} catch (error) {
  process.stderr.write(`${String(error?.message||'Benchmark failed').replace(/DYLANI_BENCHMARK_API_KEY|Bearer[^\s]+/gi,'[redacted]')}\n`);
  process.exitCode=1;
}
