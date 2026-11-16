import { moduleUrl, artifact, chromeOptions } from './browser-env.mjs';
// Build first. Requires local _test DATABASE_URL, Playwright, installed Chrome and free port 3157.
// Uses a fresh database and removes it after the browser/server have stopped.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
const root = process.cwd();
async function main() {
  const { createDisposableDatabase } = await import(moduleUrl('scripts/stress/disposable-database.ts'));
  const isolated = await createDisposableDatabase('seriesbrowser');
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
    await db.withTransaction(q => recordOutgoing(q, { lot_id: '9028', meters: 1999.25, party: 'Browser client', sr_no: 10, bill_pct: 99, date: '2026-10-29' }));
    await db.withTransaction(q => recordOutgoing(q, { lot_id: 'FP-K-91', meters: 1401.5, party: 'Browser client', entry_status: 'end', moved_by: 'browser-owner' }, { endAllowed: true }));
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

    await page.evaluate(() => localStorage.setItem('tb-tab', 'firm')); await page.reload();
    await page.getByRole('button', { name: 'SR series', exact: true }).click();
    await page.getByLabel('Prefix', { exact: true }).fill('RS');
    await page.getByLabel('Godown name', { exact: true }).fill('River shop');
    const created = page.waitForResponse(r => r.url().endsWith('/api/stock/series') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save series', exact: true }).click(); assert.equal((await created).status(), 200);
    await page.getByText('RS · River shop', { exact: true }).waitFor();
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
      await page.evaluate(() => localStorage.setItem('tb-tab', 'stock')); await page.reload();
      await page.getByRole('button', { name: 'Manual entry', exact: true }).click();
      await page.getByRole('button', { name: 'Outgoing (OUT)', exact: true }).click();
      const series = page.getByRole('combobox', { name: /SR series/ }); await series.selectOption('RS');
      const sr = page.getByRole('textbox', { name: /SR no/ });
      await page.waitForFunction(() => [...document.querySelectorAll('label')].find(l => l.textContent.startsWith('SR no.'))?.querySelector('input')?.value !== '');
      assert.equal(await sr.inputValue(), width === 1366 ? '1' : '105');
      await sr.fill(width === 1366 ? '104' : 'rs 105');
      await page.locator('input[list="lot-list"]').fill('9028');
      await page.getByLabel('Meters', { exact: true }).fill('1');
      await page.locator('input[list="party-list"]').fill('Browser client');
      const saved = page.waitForResponse(r => r.url().endsWith('/api/stock') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Record dispatch', exact: true }).click();
      const response = await saved; assert.equal(response.status(), 200); const data = await response.json();
      await page.locator('.toast').filter({ hasText: `SR RS-${width === 1366 ? 104 : 105}` }).waitFor();
      await page.getByRole('textbox', { name: 'Date of entry' }).waitFor({ state: 'detached' });
      const row = page.locator(`tr[data-mv="${data.movement.id}"]`); await row.waitFor(); assert.match(await row.innerText(), /RS-10[45]/);
      console.log(`SR series picker, independent next number, prefixed save and ledger: ${width}`);
    }
    await page.getByRole('button', { name: 'Lots & balance', exact: true }).click();
    await page.getByRole('button', { name: 'Other', exact: true }).waitFor();
    await page.getByLabel('Quality', { exact: true }).fill('Browser cotton');
    await page.getByLabel('Design', { exact: true }).fill('Plain');
    await page.getByLabel('Party (lots dispatched to)', { exact: true }).fill('Browser client');
    const total = await context.request.get('http://127.0.0.1:3157/api/inventory?quality=Browser%20cotton&design=Plain&party=Browser%20client');
    assert.equal(total.status(), 200); const { stock } = await total.json();
    assert.equal(stock.on_hand_m, stock.packed_m + stock.running_m + stock.on_hold_m + stock.other_m);
    await page.locator('tr[data-lot="9028"]').waitFor();
    await page.screenshot({ path: artifact('textile-completion-mobile.png'), fullPage: true });
    console.log('quality/design/party filters and four-bucket stock summary passed');
  } finally {
    if(browser) await browser.close();
    if(server) { server.kill('SIGTERM'); await new Promise(r=>server.once('exit',r)); }
    log.end(); await db.default.end(); await isolated.cleanup();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
