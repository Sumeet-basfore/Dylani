import {test,expect} from '@playwright/test';
import {comparisonHTML} from '../../benchmarks/src/pipeline.mjs';

const manifest={runId:'review-fixture-run',results:[{
  promptId:'pilot-01',category:'saas-dashboard',title:'Review fixture',requirements:['Show a clear project summary'],reviewOrder:['B','A'],
  variants:[{variant:'baseline',arm:'A',screenshots:{mobile:'mobile.png',desktop:'desktop.png'}},{variant:'optimized',arm:'B',screenshots:{mobile:'mobile.png',desktop:'desktop.png'}}
]}]};

test('blind review collects individual scores, supports ties, and downloads a reviewer JSON file',async({page})=>{
  await page.setContent(comparisonHTML(manifest));
  await page.getByLabel('Reviewer ID').fill('reviewer-01');
  await page.locator('[data-rating="A-visual"]').selectOption('4');
  await page.locator('[data-rating="A-task"]').selectOption('3');
  await page.locator('[data-rating="B-visual"]').selectOption('5');
  await page.locator('[data-rating="B-task"]').selectOption('4');
  await page.getByLabel('Tie', {exact:true}).check();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download my ratings'}).click();
  const download=await downloadPromise;
  expect(download.suggestedFilename()).toBe('dylani-review-reviewer-01.json');
  const content=await (await import('node:fs/promises')).readFile(await download.path(),'utf8');
  const ratings=JSON.parse(content);
  expect(ratings).toEqual({
    schemaVersion:1,runId:'review-fixture-run',reviewerId:'reviewer-01',
    ratings:[{promptId:'pilot-01',candidates:{A:{visualQuality:4,taskFulfillment:3},B:{visualQuality:5,taskFulfillment:4}},overallPreference:'tie'}]
  });
});

test('blind review refuses incomplete scores without manufacturing ratings',async({page})=>{
  await page.setContent(comparisonHTML(manifest));
  await page.getByLabel('Reviewer ID').fill('reviewer-02');
  await page.getByRole('button',{name:'Download my ratings'}).click();
  await expect(page.getByRole('status')).toContainText('Complete both candidate ratings');
  expect(await page.locator('select').evaluateAll(items=>items.every(item=>item.value===''))).toBe(true);
});
