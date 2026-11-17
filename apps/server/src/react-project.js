import {z} from 'zod';

const versions=Object.freeze({
  dependencies:{react:'19.1.0','react-dom':'19.1.0'},
  devDependencies:{'@types/react':'19.3.0','@types/react-dom':'19.3.0','@vitejs/plugin-react':'4.4.1',autoprefixer:'10.4.20',postcss:'8.5.33',tailwindcss:'3.4.17',typescript:'5.8.3',vite:'6.4.6'}
});
const scripts=Object.freeze({dev:'vite --host 127.0.0.1',build:'tsc --noEmit && vite build',preview:'vite preview --host 127.0.0.1'});
export const PROJECT_FILE_PATHS=Object.freeze([
  'README.md','index.html','package.json','postcss.config.js','tailwind.config.ts','tsconfig.json','vite.config.ts',
  'src/App.tsx','src/design-spec.ts','src/index.css','src/main.tsx','src/vite-env.d.ts'
]);

const fileSchema=z.object({path:z.string().min(1).max(120),content:z.string().max(100_000)}).strict();
const projectFilesSchema=z.array(fileSchema).length(PROJECT_FILE_PATHS.length);
const layoutClasses={
  'single-column':'mx-auto max-w-5xl',
  sidebar:'grid gap-section lg:grid-cols-[15rem_minmax(0,1fr)]',
  'two-column':'grid gap-section lg:grid-cols-2',
  grid:'grid gap-section sm:grid-cols-2 lg:grid-cols-3'
};
const desktopClasses={centered:'lg:mx-auto lg:max-w-5xl',sidebar:'lg:grid-cols-[15rem_minmax(0,1fr)]','two-column':'lg:grid-cols-2','three-column':'lg:grid-cols-3'};
const densityClasses={compact:'gap-4',comfortable:'gap-6',spacious:'gap-section'};
const mobileClasses={stack:'grid-cols-1','horizontal-scroll':'grid-flow-col auto-cols-[minmax(14rem,1fr)] overflow-x-auto'};

function sourceLiteral(value) {
  return JSON.stringify(value,null,2).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
}

function generatedApp(spec) {
  const layout=layoutClasses[spec.layout.kind];
  const desktop=desktopClasses[spec.responsive.desktop];
  const density=densityClasses[spec.layout.density];
  const mobile=mobileClasses[spec.responsive.mobile];
  return `import {designSpec} from './design-spec';
import type {DesignComponent, DesignElement} from './design-spec';

const layoutClass = ${JSON.stringify(layout)};
const desktopClass = ${JSON.stringify(desktop)};
const densityClass = ${JSON.stringify(density)};
const mobileClass = ${JSON.stringify(mobile)};

function ElementView({item}: {item: DesignElement}) {
  switch (item.type) {
    case 'text': return <p className="leading-7 text-muted">{item.text}</p>;
    case 'button': return <button type="button" className="rounded-button bg-brand px-5 py-3 font-semibold text-foreground">{item.label}</button>;
    case 'metric': return <div className="rounded-card border border-white/10 bg-surface p-5"><p className="text-sm text-muted">{item.label}</p><strong className="mt-2 block text-2xl">{item.value}</strong></div>;
    case 'input': return <label className="grid gap-2 text-sm">{item.label}<input className="rounded-button border border-white/15 bg-background px-3 py-2" placeholder={item.placeholder ?? ''} /></label>;
    case 'list': return <section><h3 className="mb-3 font-semibold">{item.label}</h3><ul className="grid gap-2 text-muted">{item.items.map((entry,index)=><li key={index}>{entry}</li>)}</ul></section>;
    case 'badge': return <span className="inline-flex rounded-full bg-brand/15 px-3 py-1 text-sm text-brand">{item.text}</span>;
  }
}

function ComponentView({component}: {component: DesignComponent}) {
  const isHero=component.type==='hero';
  return <section className={isHero ? 'rounded-card border border-white/10 bg-surface p-8 lg:p-12' : 'rounded-card border border-white/10 bg-surface p-6'}>
    <div className="mb-6"><h2 className={isHero ? 'text-3xl font-bold tracking-tight lg:text-5xl' : 'text-xl font-semibold'}>{component.title}</h2>
      {component.description && <p className="mt-3 max-w-2xl leading-7 text-muted">{component.description}</p>}</div>
    <div className={"grid items-start " + mobileClass + " " + densityClass + " sm:grid-cols-2 " + desktopClass}>
      {component.children.map(item=><ElementView key={item.id} item={item} />)}
    </div>
  </section>;
}

export default function App() {
  return <main className="min-h-screen bg-background px-5 py-8 text-foreground lg:px-10 lg:py-12">
    <div className={"mx-auto grid max-w-7xl grid-cols-1 " + densityClass + " " + layoutClass}>
      {designSpec.components.map(component=><ComponentView key={component.id} component={component} />)}
    </div>
  </main>;
}
`;
}

function designSpecSource(spec) {
  return `export type DesignElement =
  | {id: string; type: 'text'; text: string}
  | {id: string; type: 'button'; label: string}
  | {id: string; type: 'metric'; label: string; value: string}
  | {id: string; type: 'input'; label: string; placeholder?: string}
  | {id: string; type: 'list'; label: string; items: string[]}
  | {id: string; type: 'badge'; text: string};

export type DesignComponent = {id: string; type: 'hero' | 'section' | 'card-grid' | 'sidebar'; title: string; description?: string; children: DesignElement[]};
export type DesignSpec = {
  schemaVersion: '1.0'; platform: 'web' | 'mobile'; pageType: string; requirements: string[];
  layout: {kind: 'single-column' | 'sidebar' | 'two-column' | 'grid'; density: 'compact' | 'comfortable' | 'spacious'};
  tokens: {color: Record<string, string>; radius: Record<string, string>; spacing: Record<string, string>};
  components: DesignComponent[];
  responsive: {mobile: 'stack' | 'horizontal-scroll'; desktop: 'centered' | 'sidebar' | 'two-column' | 'three-column'};
  selectedSkills: string[];
};

export const designSpec = ${sourceLiteral(spec)} satisfies DesignSpec;
`;
}

function cssTokens(tokens) {
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --token-color-brand: ${tokens.color.brand};
  --token-color-background: ${tokens.color.background};
  --token-color-surface: ${tokens.color.surface};
  --token-color-foreground: ${tokens.color.foreground};
  --token-color-muted: ${tokens.color.muted};
  --token-radius-card: ${tokens.radius.card};
  --token-radius-button: ${tokens.radius.button};
  --token-spacing-section: ${tokens.spacing.section};
}

@layer base {
  html { color-scheme: dark; }
  body { margin: 0; background: var(--token-color-background); color: var(--token-color-foreground); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  button, input { font: inherit; }
}
`;
}

export function generateReactProjectFiles(spec) {
  const packageJSON={name:'dylani-generated-design',private:true,type:'module',scripts,dependencies:versions.dependencies,devDependencies:versions.devDependencies};
  const tailwindConfig=`import type {Config} from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {extend: {
    colors: {
      brand: 'var(--token-color-brand)', background: 'var(--token-color-background)',
      surface: 'var(--token-color-surface)', foreground: 'var(--token-color-foreground)', muted: 'var(--token-color-muted)'
    },
    borderRadius: {card: 'var(--token-radius-card)', button: 'var(--token-radius-button)'},
    spacing: {section: 'var(--token-spacing-section)'}
  }}, plugins: []
} satisfies Config;
`;
  const files=[
    {path:'README.md',content:'# Generated Dylani project\n\nThis fixed React + TypeScript + Vite + Tailwind project was generated from a validated, framework-neutral DesignSpec.\n\nRun `npm install`, then `npm run dev`. Dependencies and scripts are fixed by the Dylani project template.\n'},
    {path:'index.html',content:'<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Dylani generated design</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n'},
    {path:'package.json',content:JSON.stringify(packageJSON,null,2)+'\n'},
    {path:'postcss.config.js',content:"export default {plugins: {tailwindcss: {}, autoprefixer: {}}};\n"},
    {path:'tailwind.config.ts',content:tailwindConfig},
    {path:'tsconfig.json',content:JSON.stringify({compilerOptions:{target:'ES2022',useDefineForClassFields:true,lib:['ES2022','DOM','DOM.Iterable'],module:'ESNext',skipLibCheck:true,moduleResolution:'Bundler',allowImportingTsExtensions:true,resolveJsonModule:true,isolatedModules:true,noEmit:true,jsx:'react-jsx',strict:true},include:['src']},null,2)+'\n'},
    {path:'vite.config.ts',content:"import {defineConfig} from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({plugins:[react()]});\n"},
    {path:'src/App.tsx',content:generatedApp(spec)},
    {path:'src/design-spec.ts',content:designSpecSource(spec)},
    {path:'src/index.css',content:cssTokens(spec.tokens)},
    {path:'src/main.tsx',content:"import React from 'react';\nimport {createRoot} from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);\n"},
    {path:'src/vite-env.d.ts',content:'/// <reference types="vite/client" />\n'}
  ];
  return validateProjectFiles(files);
}

export function validateProjectFiles(input) {
  const parsed=projectFilesSchema.safeParse(input);
  if (!parsed.success) throw new Error('Generated project files failed validation');
  const files=parsed.data;
  const paths=files.map(file=>file.path);
  for (const path of paths) {
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part=>part==='..' || part==='.' || part==='')) throw new Error('Generated project contains an unsafe file path');
  }
  if (new Set(paths).size!==paths.length || [...PROJECT_FILE_PATHS].some(path=>!paths.includes(path))) throw new Error('Generated project file structure is invalid');
  if (files.reduce((total,file)=>total+file.content.length,0)>300_000) throw new Error('Generated project is too large');
  const packageFile=files.find(file=>file.path==='package.json');
  let manifest;
  try { manifest=JSON.parse(packageFile.content); } catch { throw new Error('Generated package manifest is invalid'); }
  const manifestKeys=['name','private','type','scripts','dependencies','devDependencies'];
  if (!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).sort().join(',')!==[...manifestKeys].sort().join(',')||manifest.name!=='dylani-generated-design'||manifest.private!==true||manifest.type!=='module') throw new Error('Generated package manifest is invalid');
  if (JSON.stringify(manifest.dependencies)!==JSON.stringify(versions.dependencies) || JSON.stringify(manifest.devDependencies)!==JSON.stringify(versions.devDependencies)) throw new Error('Generated project contains an unapproved dependency');
  if (JSON.stringify(manifest.scripts)!==JSON.stringify(scripts)) throw new Error('Generated project contains an unapproved command');
  return files;
}
