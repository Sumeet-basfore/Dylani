import {test,expect,chromium,firefox,webkit} from '@playwright/test';

async function launchOrSkip(testContext,browserType,name) {
  try { return await browserType.launch({headless:true}); }
  catch { testContext.skip(true,`${name} browser binary or OS dependencies are unavailable`); return null; }
}

async function verifyPreviewIsolation(browserType,name) {
  test(`${name}: React works while the preview remains isolated`,async ({},testContext)=>{
    const browser=await launchOrSkip(testContext,browserType,name);
    if (!browser) return;
    const context=await browser.newContext({viewport:{width:1280,height:800}});
    const page=await context.newPage();
    const topLevelRequests=[];
    const diagnostics=[];
    const responses=[];
    page.on('request',request=>{if(request.url().includes('top-navigation-canary'))topLevelRequests.push(request.url());});
    page.on('response',response=>responses.push({url:response.url(),status:response.status()}));
    page.on('console',message=>diagnostics.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror',error=>diagnostics.push(`pageerror: ${error.message}`));
    page.on('requestfailed',request=>diagnostics.push(`${request.url()}: ${request.failure()?.errorText||'failed'}`));
    try {
      await page.goto('http://127.0.0.1:4173/');
      if (await page.locator('body').getAttribute('data-runner-available')==='false') testContext.skip(true,'Bubblewrap user namespaces or cgroup limits are unavailable');
      const iframe=page.locator('iframe[title="Untrusted generated React preview"]');
      await expect(iframe).toHaveAttribute('sandbox','allow-scripts');
      try { await expect(iframe.contentFrame().getByRole('heading',{name:'React runtime is active'})).toBeVisible({timeout:8000}); }
      catch {
        const frameInfo=await page.frames().at(-1).evaluate(()=>({origin:location.origin,text:document.body?.innerText,root:document.getElementById('root')?.innerHTML,resources:performance.getEntriesByType('resource').map(item=>item.name),html:document.documentElement.outerHTML.slice(0,1000)})).catch(error=>({error:error.message}));
        throw new Error(JSON.stringify({frames:page.frames().map(frame=>frame.url()),diagnostics,responses,frameInfo}));
      }
      await expect.poll(()=>page.evaluate(()=>window.__probe)).toMatchObject({
        type:'dylani-security-probe',parentDocumentBlocked:true,parentStorageBlocked:true,ownCookie:'blocked',ownOrigin:'null'
      });
      expect(page.url()).toBe('http://127.0.0.1:4173/');
      expect(topLevelRequests).toEqual([]);
      expect(await page.evaluate(()=>document.cookie)).toContain('dylani_app_secret=fixture-cookie');
      expect(await page.evaluate(()=>localStorage.getItem('dylani-app-secret'))).toBe('fixture-storage-value');
      await expect.poll(async()=> (await (await page.request.get('http://127.0.0.1:4173/api/canary-count')).json()).count).toBe(0);
    } finally { await context.close(); await browser.close(); }
  });
}

verifyPreviewIsolation(chromium,'Chromium');
verifyPreviewIsolation(firefox,'Firefox');
verifyPreviewIsolation(webkit,'WebKit');

test('expired preview artifacts return 404',async ({},testContext)=>{
  const browser=await launchOrSkip(testContext,chromium,'Chromium');
  if (!browser) return;
  const page=await browser.newPage();
  try {
    const response=await page.request.get('http://127.0.0.1:4173/api/expired-preview',{timeout:30_000});
    if (response.status()===503) testContext.skip(true,'Bubblewrap user namespaces or cgroup limits are unavailable');
    expect(response.status()).toBe(200);
    const result=await response.json();
    expect(result.status).toBe('built');
    await page.waitForTimeout(1200);
    expect((await page.request.get(result.previewUrl)).status()).toBe(404);
  } finally { await browser.close(); }
});
