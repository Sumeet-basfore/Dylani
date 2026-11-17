import sanitizeHtml from 'sanitize-html';
import postcss from 'postcss';
export const DEFAULT_TOKENS = Object.freeze({
  color: {brand: '#7966f5', background: '#0e1018', surface: '#191c28', foreground: '#f8f9ff', muted: '#a4a8bf'},
  radius: {card: '18px', button: '12px'}, spacing: {section: '32px'}
});
export const SKILLS = {
  typography: 'Establish a deliberate type scale, readable line lengths, and clear hierarchy.',
  layout: 'Use consistent spacing and alignment; prevent cramped layouts or unnecessary emptiness.',
  responsive: 'Make layouts usable at 390px and 1440px; no horizontal overflow.',
  accessibility: 'Use semantic headings, visible focus indicators, accessible contrast, and descriptive controls.',
  composition: 'Build strong visual hierarchy; vary section density; avoid generic identical cards everywhere.'
};
export function selectSkills(platform, prompt) {
  const base = ['typography', 'layout', 'responsive', 'accessibility'];
  if (/landing|portfolio|marketing|premium|hero|brand/i.test(prompt)) base.push('composition');
  return base.map(id => ({id, rule: SKILLS[id]}));
}
export function normalizeTokens(input) {
  const out = structuredClone(DEFAULT_TOKENS);
  if (!input || typeof input !== 'object') return out;
  // Accept our native format or a small subset of DTCG tokens.
  const get = (group, key) => {
    const raw = input?.[group]?.[key];
    return typeof raw === 'string' ? raw : (typeof raw?.$value === 'string' ? raw.$value : undefined);
  };
  for (const [group, keys] of Object.entries({color:['brand','background','surface','foreground','muted'], radius:['card','button'],spacing:['section']})) {
    for (const key of keys) { const value = get(group,key); if (value) out[group][key] = value; }
  }
  for (const [key,val] of Object.entries(out.color)) if (!/^#[0-9a-f]{6}$/i.test(val)) throw new Error(`Invalid color token: ${key}`);
  for (const group of ['radius','spacing']) for (const [key,val] of Object.entries(out[group])) if (!/^\d{1,3}(?:\.\d+)?(?:px|rem)$/.test(val)) throw new Error(`Invalid ${group} token: ${key}`);
  return out;
}
function decodeCssEscapes(value) {
  return value
    .replace(/\\([0-9a-f]{1,6})(?:\r\n|[\t\n\r\f ])?/gi,(_,hex)=>{
      const codePoint=parseInt(hex,16);
      return codePoint===0 || codePoint>0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint);
    })
    .replace(/\\([^\r\n\f])/g,'$1');
}
function sanitizeStylesheets(html) {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,(_,open,css,close)=>{
    try {
      const root=postcss.parse(decodeCssEscapes(css),{from:undefined});
      root.walkAtRules(rule=>{
        const name=decodeCssEscapes(rule.name).toLowerCase();
        if (['import','font-face','namespace','document'].includes(name)) rule.remove();
      });
      root.walkDecls(declaration=>{
        const property=decodeCssEscapes(declaration.prop).toLowerCase();
        const value=decodeCssEscapes(declaration.value);
        if (['behavior','-moz-binding'].includes(property) || /(?:url|expression|image-set)\s*\(/i.test(value)) declaration.remove();
      });
      return `${open}${root.toString()}${close}`;
    } catch {
      // Invalid CSS is not needed for a preview; dropping the stylesheet is safer than passing it through.
      return `${open}${close}`;
    }
  });
}
export function cleanPrototype(raw) {
  const noMarkdown = raw.trim().replace(/^```(?:html)?\s*/i,'').replace(/\s*```$/,'');
  const html = sanitizeHtml(noMarkdown, {
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'html','head','body','main','section','article','header','footer','nav','aside','button','input','label','form','style','svg','path','circle','rect','line','polyline','span','div','h1','h2','img'],
    allowedAttributes: { '*':['class','id','role','aria-*','title','style'], a:['href','target','rel','class'], img:['src','alt','width','height','class'], input:['type','placeholder','aria-label','value'], svg:['viewBox','width','height','fill','stroke','stroke-width'],path:['d','fill','stroke','stroke-width'],circle:['cx','cy','r','fill'],rect:['x','y','width','height','rx','fill'],line:['x1','y1','x2','y2','stroke'],polyline:['points','stroke','fill'] },
    allowedSchemes:['https','mailto'],
    allowedSchemesByTag: {img:[]},
    allowedStyles: {'*': {'color': [/^#[0-9a-f]{3,8}$/i,/^rgba?\([^)]{1,60}\)$/i,/^[a-z-]{1,20}$/i], 'background-color':[/^#[0-9a-f]{3,8}$/i], 'font-size':[/^[\d.]+(?:px|rem|em|%)$/], 'padding':[/^[\w\d\s.%()-]{1,80}$/], 'margin':[/^[\w\d\s.%()-]{1,80}$/] }},
    disallowedTagsMode:'discard',
    enforceHtmlBoundary:false,
    parseStyleAttributes:true,
    // Style elements are kept for prototypes; their CSS is parsed and resource-loading constructs are removed below.
    allowVulnerableTags:true
  });
  return sanitizeStylesheets(html);
}
export function buildPrompt({prompt,platform,stack,tokens,mode}) {
  const skills = mode==='optimized' ? selectSkills(platform,prompt) : [];
  const extra = mode==='optimized' ? `\nDESIGN RULES:\n${skills.map(s=>`- ${s.rule}`).join('\n')}` : '';
  return `You are a UI prototyping engine. Generate ONE polished, usable, responsive ${platform} prototype as a complete self-contained HTML document.\nTarget stack selected for later export: ${stack}. Current milestone supports HTML/CSS previews only.\nUser request: ${prompt}\nDesign tokens (use exact colors): ${JSON.stringify(tokens)}\nImportant constraints:\n- Return raw HTML only. No markdown fences, explanation, JavaScript, external fonts, remote images, external resources, iframes, or external stylesheets.\n- Put all CSS inside one <style> in <head>.\n- Semantic HTML and functional visual states. Prototype-only controls need not have application logic.\n- Responsive design for narrow mobile and wide desktop viewports.\n- Use CSS gradients or inline CSS illustrations instead of external images.\n- Avoid CSS url(), @import, and script tags.\n- Do not emit secrets or private information.\n${extra}`;
}
export function wrapPreview(html) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, match=>match+csp);
  return `<!doctype html><html><head>${csp}<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
}
