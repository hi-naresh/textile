// Showcase data on top of `npm run db:seed-demo -- --history`: a busy, realistic month for demos.
// Usage: ALLOW_DEMO_SEED=1 npx tsx scripts/seed-showcase.ts   (after db:migrate + db:seed-demo -- --history)
//
// Writes through the app's own ledger / sales / dispatch / money functions, so every business rule
// (stock balance, reservations, GST, FIFO payments, order status) holds exactly as in real use.
// Never deletes anything. Six stages, each its own transaction and skipped once done — on a slow link, just run it again.
import { Client } from 'pg';
import type { Q } from '../src/lib/db';
import { closeJobCard, createJobCard, recordIncoming } from '../src/lib/ledger';
import { createInquiry, updateInquiry, convertInquiry } from '../src/lib/sales/inquiries';
import { createOrder } from '../src/lib/sales/orders';
import { autoAllocate } from '../src/lib/sales/allocate';
import { createDispatch } from '../src/lib/dispatch/dispatches';
import { createInvoiceForDispatch, recordTallyInvoice } from '../src/lib/dispatch/invoices';
import { recordPayment } from '../src/lib/money/payments';

const OWNER = 'usr-owner';
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL || 'postgresql://naresh@localhost:5432/textile_db';

function cfg(raw: string) {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  const mode = u.searchParams.get('sslmode');
  for (const k of ['sslmode', 'sslrootcert', 'supa']) u.searchParams.delete(k);
  return { local, host: u.hostname, connectionString: u.toString(), ssl: !local && mode !== 'disable' ? { rejectUnauthorized: false } : false };
}

let seed = 4242;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rand() * a.length)];
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (daysAgo: number) => { const d = new Date(Date.now() + 5.5 * 3600e3 - daysAgo * 86400e3); return d.toISOString().slice(0, 10); };

const GST_CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(state: string, pan: string) {
  const s = `${state}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = GST_CH.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return s + GST_CH[(36 - (sum % 36)) % 36];
}

const SECTIONS = ['Weaving', 'Dyeing', 'Printing', 'Folding', 'Packing'];
const SUPERVISORS = [
  { id: 'usr-sup-kiran', name: 'Kiran Desai', sections: ['Dyeing', 'Printing'] },
  { id: 'usr-sup-jignesh', name: 'Jignesh Shah', sections: ['Weaving', 'Packing'] },
];
const WORKERS: [string, string, string][] = [
  ['wrk-s01', 'Dinesh Vaghela', 'Folding'], ['wrk-s02', 'Bharat Gohil', 'Folding'], ['wrk-s03', 'Pravin Chauhan', 'Folding'],
  ['wrk-s04', 'Nilesh Parmar', 'Folding'], ['wrk-s05', 'Mahesh Solanki', 'Dyeing'], ['wrk-s06', 'Rakesh Bhatt', 'Dyeing'],
  ['wrk-s07', 'Vijay Rathod', 'Printing'], ['wrk-s08', 'Harish Joshi', 'Printing'], ['wrk-s09', 'Sanjay Patel', 'Printing'],
  ['wrk-s10', 'Arvind Makwana', 'Weaving'], ['wrk-s11', 'Manoj Thakor', 'Weaving'], ['wrk-s12', 'Ashok Vasava', 'Packing'],
  ['wrk-s13', 'Kamlesh Rana', 'Packing'],
];
const PARTIES: [string, string, string, string, string, number, number][] = [
  ['Ahmedabad Textiles', '24', 'AAMFA3321Q', 'Ahmedabad', '9825077777', 250000, 30],
  ['Hyderabad Sarees', '36', 'AANFH5540U', 'Hyderabad', '9848088888', 300000, 45],
  ['Pune Fabrics', '27', 'AAPFP8812V', 'Pune', '9822099999', 180000, 30],
  ['Lucknow Chikan House', '09', 'AAQFL2231W', 'Lucknow', '9839010101', 120000, 21],
];
const MILLS = ['Haridwar Textiles', 'Laxmi Weaving Mills', 'Om Weavers', 'Shree Ram Mills', 'Radhe Synthetics'];
// quality, design, sell ₹/m, buy ₹/m (grey)
const QUALITIES: [string, string, number, number][] = [
  ['Poly-Crepe', 'D-104A', 68, 41], ['Georgette', 'G-220', 92, 58], ['Rayon Print', 'R-17', 74, 45],
  ['Chiffon', 'C-310', 85, 52], ['Satin', 'S-512', 110, 70], ['Cotton Cambric', 'CC-08', 58, 34],
];

async function main() {
  const c0 = cfg(url);
  if (!c0.local && process.env.ALLOW_DEMO_SEED !== '1') {
    console.error(`[showcase] Refusing to seed ${c0.host} (not local). Set ALLOW_DEMO_SEED=1 for a demo database.`);
    process.exit(1);
  }
  const client = new Client({ connectionString: c0.connectionString, ssl: c0.ssl, connectionTimeoutMillis: 20000 });
  await client.connect();
  const q: Q = (text, params) => client.query(text, params as unknown[]);
  const t0 = Date.now();
  const scLots = async () => (await q(`SELECT lot_id AS id, quality FROM lots WHERE lot_id LIKE 'SC-%' ORDER BY lot_id`)).rows as { id: string; quality: string }[];
  const once = async (m: string, sql: string) => !!(await q(sql)).rowCount;
  const stockLots = async (from: number, to: number) => {
    // ---- current stock: 18 lots received over the last 25 days ----
    for (let i = from; i < to; i++) {
      const [quality, design, , buy] = QUALITIES[i % QUALITIES.length];
      const id = `SC-${301 + i}`;
      const grey = Math.round(900 + rand() * 1400);
      const fin = Math.round(grey * (0.9 + rand() * 0.07));
      const daysAgo = 25 - Math.floor(i * 1.35);
      const mill = pick(MILLS);
      await recordIncoming(q, {
        lot_id: id, quality, design, grey_meters: grey, finished_meters: fin, mill_name: mill, weaver_name: rand() < 0.5 ? mill : 'Om Weavers',
        source_doc: `CH-${7100 + i}`, purchase_rate: buy, location: `${i % 5 === 0 ? 'RS' : 'LM'} ${240 + (i % 8)} · Pipe ${1 + (i % 4)}`, moved_by: OWNER, add_shops_by: OWNER,
      }, { requireLotDetails: true });
      await q(`UPDATE stock_movements SET ts = NOW() - ($2::int * interval '1 day') - interval '3 hours' WHERE lot_id = $1 AND direction = 'IN'`, [id, daysAgo]);
      await q(`UPDATE lot_locations SET ts = NOW() - ($2::int * interval '1 day') - interval '3 hours' WHERE lot_id = $1`, [id, daysAgo]);
    }
  };
  // Each stage is its own transaction and is skipped when already done, so a slow link can simply run the script again.
  const STAGES: [string, string, () => Promise<void>][] = [
    ['people, parties, rates', `SELECT 1 FROM parties WHERE name = 'Lucknow Chikan House'`, async () => {
    // ---- people ----
    for (const [i, s] of SECTIONS.entries()) await q(`INSERT INTO sections (name, sort_order) SELECT $1::varchar, $2 WHERE NOT EXISTS (SELECT 1 FROM sections WHERE lower(name) = lower($1::varchar))`, [s, i]);
    for (const s of SUPERVISORS) {
      await q(`INSERT INTO users (id, name, role) VALUES ($1, $2, 'supervisor') ON CONFLICT (id) DO NOTHING`, [s.id, s.name]);
      for (const sec of s.sections) await q(`INSERT INTO supervisor_sections (user_id, section_id) SELECT $1, id FROM sections WHERE lower(name) = lower($2) ON CONFLICT DO NOTHING`, [s.id, sec]);
    }
    for (const [id, name, section] of WORKERS) await q(`INSERT INTO workers (id, name, section) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [id, name, section]);
    const COSTS: Record<string, number> = { Weaving: 9, Dyeing: 6.5, Printing: 8, Folding: 1.2, Packing: 0.6 };
    for (const [sec, cost] of Object.entries(COSTS)) {
      await q(`INSERT INTO process_costs (section, cost_per_m, valid_from) SELECT $1::varchar, $2, CURRENT_DATE - 400 WHERE NOT EXISTS (SELECT 1 FROM process_costs WHERE lower(section) = lower($1::varchar))`, [sec, cost]);
    }

    // ---- parties + rates ----
    for (const [name, st, pan, city, phone, limit, days] of PARTIES) {
      await q(`INSERT INTO parties (name, gstin, state_code, city, phone, credit_limit, credit_days) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (name_key) DO NOTHING`, [name, gstin(st, pan), st, city, phone, limit, days]);
    }
    for (const [quality, , sell] of QUALITIES) {
      await q(`INSERT INTO rates (quality, rate_per_m, valid_from) SELECT $1::varchar, $2, CURRENT_DATE - 400 WHERE NOT EXISTS (SELECT 1 FROM rates WHERE lower(quality) = lower($1::varchar) AND party_id IS NULL)`, [quality, sell]);
    }
    await q(`INSERT INTO rates (quality, party_id, rate_per_m, valid_from) SELECT 'Satin', id, 104, CURRENT_DATE - 90 FROM parties WHERE name = 'Hyderabad Sarees'`);

    }],
    ['stock lots 1/3', `SELECT 1 FROM lots WHERE lot_id = 'SC-306'`, () => stockLots(0, 6)],
    ['stock lots 2/3', `SELECT 1 FROM lots WHERE lot_id = 'SC-312'`, () => stockLots(6, 12)],
    ['stock lots 3/3', `SELECT 1 FROM lots WHERE lot_id = 'SC-318'`, () => stockLots(12, 18)],
    ['floor history', `SELECT 1 FROM efficiency_daily WHERE worker_id = 'wrk-s02' AND date < CURRENT_DATE`, async () => {
    // ---- floor history: 14 days of job cards + efficiency (bulk inserts: few round trips) ----
    const lots = await scLots();
    const floorWorkers = WORKERS.filter(([, , s]) => s !== 'Packing');
    const target = 85;
    type Card = { lot_id: string; process: string; worker_id: string; meters_in: number; meters_out: number; ts_created: string; ts_closed: string; shift: string; day: number };
    const rows: Card[] = [];
    const eff: { worker_id: string; day: number; allotted: number; done: number; pct: number; flagged: boolean }[] = [];
    const at = (d: number, h: number) => new Date(Date.now() - d * 86400e3 + h * 3600e3).toISOString();
    for (let d = 14; d >= 1; d--) {
      for (const [wid, , section] of floorWorkers) {
        if (rand() < 0.12) continue; // day off
        const skill = 0.8 + (parseInt(wid.slice(-2), 10) % 5) * 0.045; // some workers steadier than others
        const cards = 1 + (rand() < 0.5 ? 1 : 0);
        let allotted = 0, done = 0;
        for (let k = 0; k < cards; k++) {
          const lot = pick(lots);
          const mIn = Math.round(180 + rand() * 320);
          const finished = rand() < skill;
          const mOut = Math.round(mIn * (finished ? 0.975 + rand() * 0.02 : 0.985));
          // Not finished that day: completed the next morning (counts as 0 done for the day).
          rows.push({ lot_id: lot.id, process: section, worker_id: wid, meters_in: mIn, meters_out: mOut, ts_created: at(d, -8), ts_closed: finished ? at(d, -2) : at(d - 1, -18), shift: rand() < 0.7 ? 'Morning' : 'Evening', day: d });
          allotted += mIn;
          done += finished ? mOut : 0;
        }
        const pct = Math.min(999, (done / allotted) * 100);
        eff.push({ worker_id: wid, day: d, allotted, done, pct: r2(pct), flagged: pct < target });
      }
    }
    const ids = await q(
      `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, meters_out, status, ts_created, ts_closed)
       SELECT lot_id, process, worker_id, meters_in, meters_out, 'closed', ts_created, ts_closed
       FROM json_to_recordset($1::json) AS x(lot_id text, process text, worker_id text, meters_in numeric, meters_out numeric, ts_created timestamptz, ts_closed timestamptz)
       RETURNING id`,
      [JSON.stringify(rows)],
    );
    await q(
      `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date)
       SELECT worker_id, job_card_id, meters_in, shift, CURRENT_DATE - day FROM json_to_recordset($1::json) AS x(worker_id text, job_card_id int, meters_in numeric, shift text, day int)`,
      [JSON.stringify(rows.map((r, i) => ({ ...r, job_card_id: ids.rows[i].id })))],
    );
    await q(
      `INSERT INTO efficiency_daily (worker_id, date, allotted, done, efficiency_pct, flagged)
       SELECT worker_id, CURRENT_DATE - day, allotted, done, pct, flagged FROM json_to_recordset($1::json) AS x(worker_id text, day int, allotted numeric, done numeric, pct numeric, flagged boolean)
       ON CONFLICT (worker_id, date) DO NOTHING`,
      [JSON.stringify(eff)],
    );
    }],
    ['today on the floor', `SELECT 1 FROM cctv_activity WHERE worker_id = 'wrk-s01' AND ts::date = CURRENT_DATE`, async () => {
    // ---- today on the floor: every worker finished a morning card; two are on a second card now ----
    const lots = await scLots();
    const floorWorkers = WORKERS.filter(([, , s]) => s !== 'Packing');
    const today = floorWorkers.slice(0, 9);
    for (const [i, [wid, , section]] of today.entries()) {
      const a = lots[(i * 2 + 3) % lots.length];
      const morning = await createJobCard(q, { lot_id: a.id, process: section, worker_id: wid, meters_in: Math.round(220 + rand() * 200), shift: 'Morning', moved_by: 'usr-demo-sup' });
      await q(`UPDATE job_cards SET ts_created = NOW() - interval '6 hours' WHERE id = $1`, [morning.id]);
      await closeJobCard(q, { id: morning.id, meters_out: Math.round(Number(morning.meters_in) * (0.975 + rand() * 0.02)), moved_by: 'usr-demo-sup' });
      if (i === 0 || i === 5) {
        const b = lots[(i * 3 + 7) % lots.length];
        const now = await createJobCard(q, { lot_id: b.id, process: section, worker_id: wid, meters_in: Math.round(110 + rand() * 60), shift: 'Morning', moved_by: 'usr-demo-sup' });
        await q(`UPDATE job_cards SET ts_created = NOW() - interval '90 minutes' WHERE id = $1`, [now.id]);
      }
    }
    for (const [wid, , section] of floorWorkers) {
      await q(`INSERT INTO cctv_activity (worker_id, station, active_pct, idle_min, ts) VALUES ($1, $2, $3, $4, NOW() - interval '1 hour')`,
        [wid, `${section} bench ${1 + Math.floor(rand() * 4)}`, r2(55 + rand() * 40), r2(10 + rand() * 90)]);
    }

    }],
    ['photo reads', `SELECT 1 FROM capture_events WHERE ai_json->>'lot_id' = 'SC-301'`, async () => {
    // ---- photo reads confirmed over the month (drives "time saved") ----
    await q(
      `WITH ev AS (
         INSERT INTO capture_events (type, ai_json, confidence, status, confirmed_by, ts, read_engine, captured_by, capture_seconds, review_seconds, confirmed_at)
         SELECT 'incoming_stock', json_build_object('lot_id', lot_id, 'grey_meters', grey_meters, 'finished_meters', meters, 'mill_name', mill_name, 'source_doc', source_doc_id),
                round((0.9 + random() * 0.08)::numeric, 2), 'confirmed', 'usr-demo-sup', ts, 'ocr', 'usr-demo-sup', round(15 + random() * 25), round(6 + random() * 20), ts
         FROM stock_movements WHERE direction = 'IN' AND lot_id LIKE 'SC-%' AND capture_event_id IS NULL
         RETURNING id, ai_json->>'lot_id' AS lot_id)
       UPDATE stock_movements sm SET capture_event_id = ev.id FROM ev WHERE sm.lot_id = ev.lot_id AND sm.direction = 'IN'`,
    );
    await q(
      `INSERT INTO capture_events (type, ai_json, confidence, status, confirmed_by, ts, read_engine, captured_by, capture_seconds, review_seconds, confirmed_at)
       SELECT 'job_card_folding', json_build_object('job_card_id', id, 'lot_id', lot_id, 'meters_out', meters_out, 'worker_id', worker_id),
              round((0.82 + random() * 0.16)::numeric, 2), CASE WHEN random() < 0.12 THEN 'corrected' ELSE 'confirmed' END, 'usr-demo-sup', ts_closed,
              CASE WHEN random() < 0.8 THEN 'ocr' ELSE 'llm_vision' END, 'usr-demo-wrk', round(10 + random() * 20), round(4 + random() * 18), ts_closed
       FROM (SELECT * FROM job_cards WHERE status = 'closed' AND worker_id LIKE 'wrk-s%' AND ts_closed >= NOW() - interval '14 days' ORDER BY random() LIMIT 60) jc`,
    );
    }],
    ['inquiries', `SELECT 1 FROM inquiries WHERE raw_text LIKE 'Rayon Print 600 m%'`, async () => {
    // ---- inquiries (en / hi / gu) ----
    const INQ: [string, string, string, string | null][] = [
      ['Need 900 m Satin by 15th, best rate?', 'whatsapp', 'Hyderabad Sarees', 'quoted'],
      ['1500 mtr Poly-Crepe chahiye next week, rate batao', 'phone', 'Ahmedabad Textiles', 'won'],
      ['जॉर्जेट 700 मीटर चाहिए, रेट क्या है?', 'whatsapp', 'Lucknow Chikan House', null],
      ['કોટન કેમ્બ્રિક 1200 મીટર જોઈએ છે', 'visit', 'Ahmedabad Textiles', null],
      ['Chiffon 2000 m urgent, can you do 80/m?', 'phone', 'Pune Fabrics', 'lost'],
      ['Rayon Print 600 m for Diwali stock', 'whatsapp', 'Delhi Cloth Store', 'quoted'],
    ];
    for (const [i, [text, source, party, status]] of INQ.entries()) {
      const v = (await createInquiry(q, { raw_text: text, source, party_name: party }, "owner", OWNER)).inquiry;
      await q(`UPDATE inquiries SET created_at = NOW() - ($2::int * interval '1 hour') WHERE id = $1`, [v.id, 3 + i * 9]);
      const rate = QUALITIES.find((x) => text.toLowerCase().includes(x[0].toLowerCase()))?.[2];
      if (status) await updateInquiry(q, v.id, status === 'quoted' && rate ? { status, quoted_rate: rate } : { status }, 'owner');
      if (status === 'won') await convertInquiry(q, v.id, { promise_date: iso(-9) }, OWNER);
    }

    }],
    ['orders + reservations', `SELECT 1 FROM orders o JOIN parties p ON p.id = o.party_id WHERE p.name = 'Lucknow Chikan House'`, async () => {
    // ---- orders: a spread of due dates, most reserved, some partly / fully sent ----
    const ORD: [string, string, number, number][] = [ // party, quality, meters, promise in days
      ['Shree Balaji Sarees', 'Satin', 700, 4], ['Mumbai Retailers', 'Rayon Print', 1200, 10], ['Kolkata Fashion House', 'Chiffon', 900, 2],
      ['Chennai Silks', 'Georgette', 1000, 14], ['Hyderabad Sarees', 'Satin', 600, 7], ['Pune Fabrics', 'Cotton Cambric', 1400, 5],
      ['Delhi Cloth Store', 'Poly-Crepe', 500, -2], ['Jaipur Prints', 'Cotton Cambric', 800, 18], ['Ahmedabad Textiles', 'Georgette', 650, 3],
      ['Lucknow Chikan House', 'Chiffon', 450, 21],
    ];
    for (const [i, [party, quality, meters, due]] of ORD.entries()) {
      const { order } = await createOrder(q, { party, quality, meters, rate_per_m: QUALITIES.find((x) => x[0] === quality)![2], promise_date: iso(-Math.max(due, 1)) }, OWNER);
      if (due < 1) await q(`UPDATE orders SET promise_date = CURRENT_DATE + $2::int WHERE id = $1`, [order.id, due]); // already late
      await q(`UPDATE orders SET created_at = NOW() - ($2::int * interval '1 day') WHERE id = $1`, [order.id, 3 + (i % 6)]);
      if (i !== 7 && i !== 9) await autoAllocate(q, order.id, OWNER);
    }

    }],
    ['dispatches + GST invoices', `SELECT 1 FROM dispatches WHERE transporter IS NOT NULL AND lr_no LIKE 'LR%'`, async () => {
    // ---- dispatches against orders, with GST invoices ----
    // Orders in the same order as ORD above (newest showcase orders).
    const orderIds = (await q(`SELECT id FROM orders WHERE inquiry_id IS NULL ORDER BY id DESC LIMIT 10`)).rows.map((r) => Number(r.id)).reverse();
    const SEND: [number, number, number][] = [[0, 1, 3], [1, 0.5, 6], [3, 0.6, 2], [5, 1, 1], [6, 1, 4]]; // order idx, share of reserved, days ago
    const TRANSPORT = ['VRL Logistics', 'Gati', 'Shree Maruti Courier', 'TCI Freight'];
    for (const [idx, share, daysAgo] of SEND) {
      const oid = orderIds[idx];
      const al = await q(`SELECT lot_id, meters - dispatched_m AS m FROM allocations WHERE order_id = $1 AND status = 'reserved' ORDER BY id`, [oid]);
      const lines = al.rows.map((a) => ({ lot_id: a.lot_id, meters: Math.max(1, Math.round(Number(a.m) * share)) }));
      if (!lines.length) continue;
      const o = await q(`SELECT p.name FROM orders o JOIN parties p ON p.id = o.party_id WHERE o.id = $1`, [oid]);
      const d = await createDispatch(q, {
        party: o.rows[0].name, order_id: oid, lines, transporter: pick(TRANSPORT), lr_no: `LR${Math.floor(100000 + rand() * 899999)}`,
        vehicle_no: `GJ05AB${Math.floor(1000 + rand() * 8999)}`, packages: Math.max(1, Math.round(lines.reduce((s, l) => s + l.meters, 0) / 110)),
      }, 'usr-demo-sup');
      await q(`UPDATE dispatches SET dispatched_at = NOW() - ($2::int * interval '1 day') WHERE id = $1`, [d.id, daysAgo]);
      await q(`UPDATE stock_movements SET ts = NOW() - ($2::int * interval '1 day') WHERE dispatch_id = $1`, [d.id, daysAgo]);
      await createInvoiceForDispatch(q, d.id, { invoice_date: iso(daysAgo), actor: OWNER });
    }

    }],
    ['Tally invoices, payments', `SELECT 1 FROM invoices WHERE invoice_no = 'TLY/26-27/301'`, async () => {
    // ---- older invoices from Tally + payments (ageing buckets, collections) ----
    const TALLY: [string, number, number][] = [ // party, days ago, taxable
      ['Hyderabad Sarees', 95, 142000], ['Ahmedabad Textiles', 80, 58000], ['Pune Fabrics', 62, 76500], ['Lucknow Chikan House', 55, 33800],
      ['Kolkata Fashion House', 48, 91000], ['Chennai Silks', 40, 121000], ['Shree Balaji Sarees', 33, 47500], ['Delhi Cloth Store', 26, 38200],
      ['Hyderabad Sarees', 18, 88000], ['Jaipur Prints', 12, 45600],
    ];
    for (const [i, [party, daysAgo, taxable]] of TALLY.entries()) {
      const total = Math.round(taxable * 1.05);
      await recordTallyInvoice(q, { source: 'tally', invoice_no: `TLY/26-27/${String(301 + i)}`, party, invoice_date: iso(daysAgo), taxable_amount: taxable, total,
        lines: [{ quality: pick(QUALITIES)[0], meters: Math.round(taxable / 80), rate: 80 }] }, OWNER);
    }
    const PAY: [string, number, number, string][] = [ // party, amount, days ago, mode
      ['Hyderabad Sarees', 100000, 50, 'bank'], ['Ahmedabad Textiles', 60900, 35, 'upi'], ['Kolkata Fashion House', 50000, 20, 'cheque'],
      ['Chennai Silks', 127050, 8, 'bank'], ['Shree Balaji Sarees', 25000, 4, 'upi'], ['Mumbai Retailers', 40000, 2, 'bank'],
      ['Pune Fabrics', 30000, 1, 'cash'],
    ];
    for (const [party, amount, daysAgo, mode] of PAY) {
      await recordPayment(q, { party, amount, paid_on: iso(daysAgo), mode, reference: `${mode.toUpperCase()}-${Math.floor(10000 + rand() * 89999)}` }, OWNER);
    }

    }],
  ];
  try {
    if (!(await q(`SELECT 1 FROM users WHERE id = $1`, [OWNER])).rowCount) throw new Error('Run `npm run db:seed-demo -- --history` first.');
    for (const [name, marker, run] of STAGES) {
      if (await once(name, marker)) { console.log(`[showcase] ✓ ${name} (already there)`); continue; }
      if (Date.now() - t0 > 75_000) { console.log('[showcase] Time is up for this run — run the same command again to continue.'); return; }
      const s0 = Date.now();
      await q('BEGIN');
      try {
        await run();
        await q(`UPDATE app_settings SET agents_ran_at = NULL WHERE id = 1`); // agents re-scan on next page load
        await q('COMMIT');
      } catch (e) {
        await q('ROLLBACK').catch(() => {});
        throw e;
      }
      console.log(`[showcase] + ${name} (${Math.round((Date.now() - s0) / 1000)}s)`);
    }
    const n = async (t: string) => Number((await q(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
    console.log('[showcase] All done:', {
      lots: await n('lots'), workers: await n('workers'), job_cards: await n('job_cards'), parties: await n('parties'),
      inquiries: await n('inquiries'), orders: await n('orders'), dispatches: await n('dispatches'), invoices: await n('invoices'), payments: await n('payments'),
    });
  } finally {
    await client.end();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('[showcase] Failed:', e instanceof Error ? e.message : e); process.exit(1); });
