import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runBenchmark,writeBenchmarkReport} from './pipeline.mjs';

const packageDirectory=path.dirname(fileURLToPath(import.meta.url));
const command=process.argv[2]==='report'?'report':'run';
const options=command==='run'?{fixture:false,promptIds:[],outputRoot:path.resolve(packageDirectory,'../runs')}:{ratingFiles:[]};
const args=process.argv.slice(command==='report'?3:2);
for (let index=0;index<args.length;index++) {
  const arg=args[index];
  if (command==='run'&&arg==='--fixture') options.fixture=true;
  else if (command==='run'&&arg==='--prompt-id'&&args[index+1]) options.promptIds.push(args[++index]);
  else if (arg==='--output'&&args[index+1]) options[command==='run'?'outputRoot':'outputDirectory']=path.resolve(args[++index]);
  else if (command==='run'&&arg==='--model'&&args[index+1]) options.model=args[++index];
  else if (command==='run'&&arg==='--provider'&&args[index+1]) options.provider=args[++index];
  else if (command==='run'&&arg==='--base-url'&&args[index+1]) options.baseURL=args[++index];
  else if (command==='report'&&arg==='--run'&&args[index+1]) options.runDirectory=path.resolve(args[++index]);
  else if (command==='report'&&arg==='--ratings'&&args[index+1]) options.ratingFiles.push(path.resolve(args[++index]));
  else if (arg==='--help') {
    process.stdout.write(command==='run'
      ?'Usage: npm run run -- [--fixture] [--provider freellmapi|ollama] [--model MODEL] [--base-url URL] [--prompt-id ID] [--output DIR]\n'
      :'Usage: npm run report -- --run RUN_DIRECTORY [--ratings REVIEWER_JSON ...] [--output DIR]\n');
    process.exit(0);
  } else {
    process.stderr.write('Unknown or incomplete benchmark option. Use --help.\n');
    process.exit(2);
  }
}

try {
  if (command==='report') {
    const result=await writeBenchmarkReport(options);
    process.stdout.write(`${JSON.stringify({outputDirectory:result.outputDirectory,reviewers:result.summary.humanPreferences.reviewers,preferences:{baseline:result.summary.humanPreferences.baseline,optimized:result.summary.humanPreferences.optimized,tie:result.summary.humanPreferences.tie}})}\n`);
  } else {
    const result=await runBenchmark({...options,promptIds:options.promptIds.length?options.promptIds:null});
    process.stdout.write(`${JSON.stringify({runId:result.runId,runDirectory:result.runDirectory,comparisonReport:result.reportPath,summaryReport:result.summaryPath,provider:result.manifest.provider,model:result.manifest.model})}\n`);
  }
} catch (error) {
  let message=String(error?.message||'Benchmark operation failed safely');
  for (const secret of [process.env.DYLANI_BENCHMARK_API_KEY,process.env.FREELLMAPI_API_KEY,process.env.OPENAI_API_KEY]) if (secret) message=message.split(secret).join('[REDACTED]');
  process.stderr.write(`${message}\n`);
  process.exitCode=1;
}
