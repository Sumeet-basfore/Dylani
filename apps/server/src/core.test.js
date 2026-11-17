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
test('keeps ordinary prototype styles while removing CSS resource loads and legacy execution hooks',()=>{
 const html=wrapPreview(cleanPrototype(`<html><head><style>
   @import url(https://evil.test/remote.css);
   @\\69mport url(https://evil.test/escaped.css);
   @font-face{font-family:remote;src:url(https://evil.test/font.woff2)}
   body{display:grid;color:#123456;background:url(https://evil.test/pixel)}
   .escaped{background-image:u\\72l(https://evil.test/escaped)}
   .safe{padding:12px;margin:8px}
 </style></head><body><main class="safe">Preview</main></body></html>`));
 assert.match(html,/display:grid/);
 assert.match(html,/padding:12px/);
 assert.doesNotMatch(html,/@import|@\\69mport|@font-face|url\s*\(/i);
 assert.doesNotMatch(html,/https:\/\/evil\.test/);
 assert.doesNotMatch(html,/font-family:remote/);
});

test('strips active HTML, event handlers, unsafe links, and external assets',()=>{
 const html=wrapPreview(cleanPrototype(`<html><head><link rel="stylesheet" href="https://evil.test/a.css"></head><body>
   <script>alert(1)</script><img src="https://evil.test/pixel.png" onerror="alert(1)">
   <a href="javascript:alert(1)" onclick="alert(2)">bad link</a>
   <iframe src="https://evil.test"></iframe><object data="https://evil.test"></object>
   <svg onload="alert(3)"><circle cx="1" cy="1" r="1"></circle></svg>
   <div style="color:#123456;background-image:url(https://evil.test/pixel)">safe style</div>
 </body></html>`));
 assert.doesNotMatch(html,/<script|<iframe|<object|<link|onerror=|onclick=|onload=/i);
 assert.doesNotMatch(html,/javascript:|https:\/\/evil\.test|background-image/i);
 assert.match(html,/color:\s*#123456/i);
});

test('drops malformed stylesheets and keeps the preview CSP explicit',()=>{
 const html=wrapPreview(cleanPrototype('<html><head><style>body { color: red; @import url(https://evil.test);</style></head><body>ok</body></html>'));
 assert.doesNotMatch(html,/evil\.test|@import/i);
 assert.match(html,/script-src 'none'/);
 assert.match(html,/connect-src 'none'/);
 assert.match(html,/img-src data:/);
 assert.match(html,/object-src 'none'/);
 assert.match(html,/frame-src 'none'/);
});
