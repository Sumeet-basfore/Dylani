import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanPrototype,normalizeTokens,buildPrompt,selectSkills,wrapPreview} from './core.js';
test('normalizes native and DTCG token values',()=>{
  const x=normalizeTokens({color:{brand:{$type:'color',$value:'#112233'}}});
  assert.equal(x.color.brand,'#112233');
});
test('rejects invalid tokens',()=>assert.throws(()=>normalizeTokens({color:{brand:'red; background:url(x)'}})));
test('selects relevant skill for landing page',()=>assert.ok(selectSkills('web','Landing page').some(x=>x.id==='composition')));
test('baseline excludes extra skills',()=>assert.doesNotMatch(buildPrompt({prompt:'A dashboard',platform:'web',stack:'react-vite',tokens:{},mode:'baseline'}),/DESIGN RULES:/));
test('removes script and dangerous resource references',()=>{
 const html=wrapPreview(cleanPrototype('<html><head><style>@import url(https://evil.test); body{background:red}</style></head><body><script>alert(1)</script><div onclick="alert(1)">ok</div></body></html>'));
 assert.doesNotMatch(html,/<script/i);assert.doesNotMatch(html,/onclick=/i);assert.doesNotMatch(html,/@import/i);assert.match(html,/Content-Security-Policy/);
});
