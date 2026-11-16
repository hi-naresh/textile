import { moduleUrl, artifact, chromeOptions } from './browser-env.mjs';
// Build first; fresh disposable local database. Set PLAYWRIGHT_PACKAGE_JSON if Playwright is installed outside the repo.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
const root = process.cwd();
async function main() {
  const { createDisposableDatabase } = await import(moduleUrl('scripts/stress/disposable-database.ts'));
  const isolated = await createDisposableDatabase('saveperf');
  process.env.DATABASE_URL = isolated.url; process.env.DB_QUIET = '1';
  const db = await import(moduleUrl('src/lib/db.ts'));
  const { recordIncoming, recordOutgoing } = await import(moduleUrl('src/lib/ledger.ts'));
  const { createSession } = await import(moduleUrl('src/lib/auth/session.ts'));
  const { NextRequest } = createRequire(root + '/package.json')('next/server');
  const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || root + '/package.json')('playwright');
  let server, browser;
  const log = createWriteStream(artifact('textile-five-browser-server.log'));
  try {
    await db.query("INSERT INTO users (id, name, role) VALUES ('browser-owner', 'Browser Owner', 'owner')");
    for (const lot_id of ['9028', 'FP-K-91']) await db.withTransaction(q => recordIncoming(q, { lot_id, quality: 'Browser cotton', design: 'Plain', finished_meters: lot_id === '9028' ? 10000 : 1500, mill_name: 'Browser mill', weaver_name: 'Weaver Acceptance', sr_no: lot_id === '9028' ? 902801 : 902802 }, { requireLotDetails: true }));
    const movement = await db.withTransaction(q => recordOutgoing(q, { lot_id: '9028', meters: 1999.25, party: 'Browser client', sr_no: 10, bill_pct: 99, date: '2026-10-29' }));
    await db.withTransaction(q => recordOutgoing(q, { lot_id: 'FP-K-91', meters: 1401.5, party: 'Browser client', entry_status: 'end', moved_by: 'browser-owner' }, { endAllowed: true }));
    const { createDispatch } = await import(moduleUrl('src/lib/dispatch/dispatches.ts'));
    const dispatch = await db.withTransaction(q => createDispatch(q, { party: 'Browser client', lines: [{ lot_id: '9028', meters: 10 }] }, 'browser-owner'));
    const session = await createSession(db.query, 'browser-owner', 'client', new NextRequest('http://127.0.0.1:3157/'));
    server = spawn(process.execPath, [root + '/node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', '3157'], { cwd: root, env: { ...process.env, DATABASE_URL: isolated.url, NODE_ENV: 'production', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', OPENAI_API_KEY: '', DB_QUIET: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.pipe(log); server.stderr.pipe(log);
    for (let i=0; i<60; i++) { try { const r=await fetch('http://127.0.0.1:3157/login'); if(r.ok) break; } catch {} await new Promise(r=>setTimeout(r,250)); }
    browser = await chromium.launch(chromeOptions());
    const context = await browser.newContext({ viewport: { width:1366, height:768 }, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    await context.addCookies([{ name:'tb_at', value:session.tokens.access, url:'http://127.0.0.1:3157', httpOnly:true, sameSite:'Lax' }]);
    await context.addInitScript(() => { if (!localStorage.getItem('tb-tab')) localStorage.setItem('tb-tab', 'stock'); });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto('http://127.0.0.1:3157/#stock');
    await page.getByRole('button', { name:'Manual entry', exact:true }).waitFor();
    console.log(JSON.stringify({ platform: process.platform, browser: await browser.version(), locale: 'en-IN', timezone: 'Asia/Kolkata' }));
    console.log('app loaded');

    const samples=[];
    for(let i=0;i<11;i++) {
      await page.getByRole('button',{name:'Manual entry',exact:true}).click();
      await page.getByRole('button',{name:'Outgoing (OUT)',exact:true}).click();
      await page.locator('input[list="lot-list"]').fill('9028');
      await page.getByLabel('Meters',{exact:true}).fill('1');
      await page.locator('input[list="party-list"]').fill('Browser client');
      await page.getByRole('textbox',{name:'Date of entry'}).fill('29-10-2026');
      if(i===10) await page.route('**/api/stock',async route=>{
        if(route.request().method()==='GET') await new Promise(r=>setTimeout(r,800));
        await route.continue();
      });
      const posted=page.waitForResponse(r=>r.url().endsWith('/api/stock')&&r.request().method()==='POST');
      const t=Date.now(); await page.getByRole('button',{name:'Record dispatch',exact:true}).click();
      const response=await posted; assert.equal(response.status(),200);
      const apiMs=Date.now()-t;
      const saved = await response.json();
      await page.locator('.toast').filter({hasText:`SR ${saved.movement.sr_no} ·`}).waitFor();
      const toastMs=Date.now()-t;
      await page.getByRole('textbox',{name:'Date of entry'}).waitFor({state:'detached'});
      const readyMs=Date.now()-t;
      samples.push({apiMs,toastMs,readyMs,slowRefresh:i===10,serverTiming:response.headers()['server-timing']});
      // Ensure refresh is complete before the next sample; do not time this wait.
      await page.waitForTimeout(i===10?1000:100);
    }
    console.log(JSON.stringify({samples}));
    await page.unroute('**/api/stock');
    // A slow earlier refresh must not replace the snapshot from a later save.
    let releaseOld, capturedOld;
    const oldGate = new Promise(resolve => { releaseOld = resolve; });
    const captured = new Promise(resolve => { capturedOld = resolve; });
    let delayOne = true;
    await page.route('**/api/stock', async route => {
      if (route.request().method() === 'GET' && delayOne) {
        delayOne = false;
        const response = await route.fetch(); capturedOld();
        await oldGate; await route.fulfill({response});
      } else await route.continue();
    });
    const saveParty = async (party) => {
      await page.getByRole('button',{name:'Manual entry',exact:true}).click();
      await page.getByRole('button',{name:'Outgoing (OUT)',exact:true}).click();
      await page.locator('input[list="lot-list"]').fill('9028');
      await page.getByLabel('Meters',{exact:true}).fill('1');
      await page.locator('input[list="party-list"]').fill(party);
      await page.getByRole('textbox',{name:'Date of entry'}).fill('29-10-2026');
      await page.getByRole('button',{name:'Record dispatch',exact:true}).click();
      await page.getByRole('textbox',{name:'Date of entry'}).waitFor({state:'detached'});
    };
    await saveParty('Earlier Buyer'); await captured;
    const latest = page.waitForResponse(r => r.url().endsWith('/api/stock') && r.request().method() === 'GET');
    await saveParty('Latest Buyer'); await (await latest).finished();
    await page.getByRole('button',{name:'Manual entry',exact:true}).click();
    await page.getByRole('button',{name:'Outgoing (OUT)',exact:true}).click();
    await page.waitForFunction(() => !!document.querySelector('#party-list option[value="Latest Buyer"]'));
    const old = page.waitForResponse(r => r.url().endsWith('/api/stock') && r.request().method() === 'GET');
    releaseOld(); await (await old).finished(); await page.waitForTimeout(100);
    assert.equal(await page.locator('#party-list option[value="Latest Buyer"]').count(), 1);
    await page.unroute('**/api/stock'); await page.reload();
    console.log('late stock snapshot cannot replace newer save');
    for (const width of [1366, 390]) {
      await page.setViewportSize({width, height: width === 390 ? 844 : 768});
      await page.getByRole('button',{name:'Manual entry',exact:true}).click();
      await page.locator('input[list="lot-list"]').fill('UNSAVED-NEW-LOT');
      await page.locator('input[name="quality"]').waitFor();
      for (const selector of ['input[list="mill-list"]', '#weaver', 'input[name="quality"]', 'input[name="design"]']) {
        const input = page.locator(selector);
        await input.fill('HARIDWAR TEXTILES PVT');
        assert.ok(await input.evaluate(el => { const s=getComputedStyle(el), c=document.createElement('canvas').getContext('2d'); c.font=s.font; return c.measureText(el.value).width + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) <= el.clientWidth; }), `name fits ${selector} at ${width}`);
      }
      await page.reload();
      await page.getByRole('button',{name:'Edit',exact:true}).click();
      const firstName = page.locator('input[data-c="quality"]').first(); await firstName.waitFor();
      for (const field of ['quality', 'design', 'party', 'mill_name', 'weaver_name']) {
        const input = page.locator(`input[data-c="${field}"]`).first();
        if (!await input.count()) continue;
        await input.fill('HARIDWAR TEXTILES PVT');
        assert.ok(await input.evaluate(el => { const s=getComputedStyle(el), c=document.createElement('canvas').getContext('2d'); c.font=s.font; return c.measureText(el.value).width + parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) <= el.clientWidth; }), `ledger name fits ${field} at ${width}`);
      }
      await page.reload();
      console.log(`name widths verified: ${width}`);
    }
    // Dispatch editor, persisted values, audit and regenerated document routes.
    await page.evaluate(() => localStorage.setItem('tb-tab', 'dispatch'));
    await page.reload();
    const dispatchRow = page.locator(`tr[data-dispatch="${dispatch.id}"]`); await dispatchRow.waitFor();
    await dispatchRow.getByRole('button',{name:'Edit',exact:true}).click();
    await page.getByLabel('Transporter',{exact:true}).fill('HARIDWAR TEXTILES PVT');
    await page.getByLabel('LR no.',{exact:true}).fill('LR-NEW');
    await page.getByLabel('Vehicle no.',{exact:true}).fill('GJ05AB1234');
    await page.getByLabel('Packages',{exact:true}).fill('4');
    await page.getByLabel('9028 · meters',{exact:true}).fill('15.25');
    await page.getByRole('button',{name:'Save dispatch',exact:true}).click();
    await page.getByRole('button',{name:'Save dispatch',exact:true}).waitFor({state:'detached'});
    await page.reload();
    await dispatchRow.getByRole('button',{name:'Edit',exact:true}).click();
    assert.equal(await page.getByLabel('Transporter',{exact:true}).inputValue(),'HARIDWAR TEXTILES PVT');
    assert.equal(await page.getByLabel('9028 · meters',{exact:true}).inputValue(),'15.25');
    await page.getByText('Edit history (1)',{exact:true}).click();
    assert.ok(await page.getByText('Transporter: empty → HARIDWAR TEXTILES PVT',{exact:true}).isVisible());
    for (const kind of ['challan','packing-list']) {
      const response = await context.request.get(`http://127.0.0.1:3157/api/docs/${kind}?dispatch_id=${dispatch.id}`);
      assert.equal(response.status(),200); assert.match(response.headers()['content-type'],/application\/pdf/);
      assert.ok((await response.body()).length > 1000);
    }
    console.log('dispatch editor persistence, audit and PDFs passed');
    const apiSamples = [];
    for (let i = 0; i < 5; i++) {
      for (const kind of ['dispatch', 'edit']) {
        const start = Date.now();
        const response = kind === 'dispatch'
          ? await context.request.post('http://127.0.0.1:3157/api/dispatches', { data: { party: 'Browser client', lines: [{ lot_id: '9028', meters: 1 }] } })
          : await context.request.patch('http://127.0.0.1:3157/api/stock/edit', { data: { changes: [{ target: 'movement', id: Number(movement.id), field: 'meters', value: 1999.25 + i }] } });
        assert.ok(response.ok(), await response.text());
        assert.match(response.headers()['server-timing'], /auth;dur=.*write;dur=.*total;dur=/);
        apiSamples.push({kind, ms:Date.now()-start, serverTiming:response.headers()['server-timing']});
      }
    }
    console.log(JSON.stringify({apiSamples}));
  } finally {
    if(browser) await browser.close();
    if(server) { server.kill('SIGTERM'); await new Promise(r=>server.once('exit',r)); }
    log.end(); await db.default.end(); await isolated.cleanup();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
