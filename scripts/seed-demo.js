// Demo / test accounts + a little sample data, for trying the app end to end.
// Usage: npm run db:seed-demo
//
// - Never drops or empties anything. Safe to run more than once (existing rows are left alone).
// - Adds: 1 owner, 1 supervisor, 1 worker (linked to a worker record), 3 sample lots
//   with challans, 2 job cards (one open for the worker to capture) and 3 knowledge notes for chat.
// - `npm run db:seed-demo -- --history` also adds ~2 years of sample receipts and dispatches across
//   several qualities (for the stock-flow charts) plus a few of today's movements.
// - Phase 2 sample data (once): billing/GST details, party details,
//   purchase rates, a few orders, inquiries, invoices and payments — so the agents have work to show.
// - Refuses to run against a non-local database unless ALLOW_DEMO_SEED=1 is set
//   (so demo data never lands in a firm's live database by accident).
/* eslint-disable @typescript-eslint/no-require-imports -- plain Node script */
require('./load-env');
const { Client } = require('pg');

const url =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  'postgresql://naresh@localhost:5432/textile_db';

function dbConfig(raw) {
  const u = new URL(raw);
  const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  const mode = u.searchParams.get('sslmode');
  u.searchParams.delete('sslmode');
  u.searchParams.delete('sslrootcert');
  return { local, host: u.hostname, config: { connectionString: u.toString(), ssl: !local && mode !== 'disable' ? { rejectUnauthorized: false } : false } };
}

const ACCOUNTS = {
  owner: { id: 'usr-owner', name: 'Mukesh' },
  supervisor: { id: 'usr-demo-sup', name: 'Ramesh Patel', section: 'Folding' },
  worker: { id: 'usr-demo-wrk', name: 'Suresh Rathod', workerId: 'wrk-demo-01', section: 'Folding' },
};

// Sections the firm runs (owner: "just Folding and Packing at the moment").
const DEMO_SECTIONS = ['Folding', 'Packing'];

const LOTS = [
  {
    lot: 'DEMO-101', quality: 'Poly-Crepe', design: 'D-104A', location: 'Godown',
    in: { grey: 1250, finished: 1180, mill: 'Haridwar Textiles', weaver: 'Haridwar Textiles', challan: 'CH-9001', daysAgo: 6 },
    out: { meters: 400, party: 'Shree Balaji Sarees', challan: 'DSP-501', daysAgo: 2 },
    card: { process: 'Folding', metersIn: 500, metersOut: 488, closed: true, daysAgo: 3 },
  },
  {
    lot: 'DEMO-102', quality: 'Georgette', design: 'G-220', location: 'Shop',
    in: { grey: 980, finished: 940, mill: 'Laxmi Weaving Mills', weaver: 'Om Weavers', challan: 'CH-9002', daysAgo: 4 },
    card: { process: 'Folding', metersIn: 600, closed: false, daysAgo: 0 },
  },
  {
    lot: 'DEMO-103', quality: 'Rayon Print', design: 'R-17', location: 'Godown',
    in: { grey: 1500, finished: null, mill: 'Haridwar Textiles', weaver: 'Haridwar Textiles', challan: 'CH-9003', daysAgo: 1 },
  },
];

const KNOWLEDGE = [
  { title: 'Shortage policy', body: 'Folding shortage above the firm limit (Settings → Rules) is checked by the section supervisor the same day. Repeat shortage on the same worker for 3 days is reported to the owner.' },
  { title: 'Dispatch rules', body: 'Goods leave only against a dispatch challan with the party name. Partial dispatch is allowed; the rest of the lot stays at its current location.' },
  { title: 'Receiving challans', body: 'Every incoming challan must show grey meters, finished meters, mill and weaver. If the weaver is the mill itself, write the mill name in both places.' },
];

async function main() {
  const db = dbConfig(url);
  if (!db.local && process.env.ALLOW_DEMO_SEED !== '1') {
    console.error(`[seed-demo] Refusing to add demo data to ${db.host} (not a local database). Set ALLOW_DEMO_SEED=1 if this is a test database.`);
    process.exit(1);
  }
  const c = new Client(db.config);
  await c.connect();
  try {
    await c.query('BEGIN');

    // The firm's sections: only Folding and Packing are in use (others stay off, see migration 008).
    for (const [i, name] of DEMO_SECTIONS.entries()) {
      await c.query(`INSERT INTO sections (name, sort_order) SELECT $1::varchar, $2::int WHERE NOT EXISTS (SELECT 1 FROM sections WHERE lower(name) = lower($1::varchar))`, [name, i + 1]);
    }
    await c.query(`UPDATE sections SET active = (lower(name) = ANY($1::text[])) WHERE active IS DISTINCT FROM (lower(name) = ANY($1::text[]))`, [DEMO_SECTIONS.map((x) => x.toLowerCase())]);
    const secs = await c.query(`SELECT id FROM sections WHERE lower(name) = ANY($1::text[])`, [DEMO_SECTIONS.map((x) => x.toLowerCase())]);

    // Owner (keeps a name already set in Settings)
    await c.query(`INSERT INTO users (id, name, role) VALUES ($1, $2, 'owner') ON CONFLICT (id) DO NOTHING`, [ACCOUNTS.owner.id, ACCOUNTS.owner.name]);
    await c.query(`UPDATE users SET name = $2 WHERE id = $1 AND name = 'Owner'`, [ACCOUNTS.owner.id, ACCOUNTS.owner.name]);

    // Supervisor
    await c.query(`INSERT INTO users (id, name, role) VALUES ($1, $2, 'supervisor') ON CONFLICT (id) DO NOTHING`, [ACCOUNTS.supervisor.id, ACCOUNTS.supervisor.name]);
    for (const r of secs.rows) {
      await c.query(`INSERT INTO supervisor_sections (user_id, section_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [ACCOUNTS.supervisor.id, r.id]);
    }

    // Worker: a worker record + an app account linked to it
    await c.query(`INSERT INTO workers (id, name, section) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [ACCOUNTS.worker.workerId, ACCOUNTS.worker.name, ACCOUNTS.worker.section]);
    await c.query(`INSERT INTO users (id, name, role, worker_id) VALUES ($1, $2, 'worker', $3) ON CONFLICT (id) DO NOTHING`, [ACCOUNTS.worker.id, ACCOUNTS.worker.name, ACCOUNTS.worker.workerId]);

    let newLots = 0;
    for (const l of LOTS) {
      const ins = await c.query(`INSERT INTO lots (lot_id, quality, design) VALUES ($1, $2, $3) ON CONFLICT (lot_id) DO NOTHING RETURNING lot_id`, [l.lot, l.quality, l.design]);
      if (!ins.rowCount) continue; // already seeded
      newLots++;
      const at = (days) => `NOW() - INTERVAL '${Number(days)} days'`;
      const stock = l.in.finished ?? l.in.grey;
      const mvIn = await c.query(
        `INSERT INTO stock_movements (lot_id, direction, meters, grey_meters, finished_meters, mill_name, weaver_name, source_doc_id, ts)
         VALUES ($1, 'IN', $2, $3, $4, $5, $6, $7, ${at(l.in.daysAgo)}) RETURNING id`,
        [l.lot, stock, l.in.grey, l.in.finished, l.in.mill, l.in.weaver, l.in.challan],
      );
      await c.query(
        `INSERT INTO lot_locations (lot_id, location, stage, note, stock_movement_id, moved_by, ts) VALUES ($1, $2, 'arrival', $3, $4, $5, ${at(l.in.daysAgo)})`,
        [l.lot, l.location, `${stock} m received on challan ${l.in.challan}`, mvIn.rows[0].id, ACCOUNTS.supervisor.id],
      );
      if (l.out) {
        const mvOut = await c.query(
          `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, ts) VALUES ($1, 'OUT', $2, $3, $4, ${at(l.out.daysAgo)}) RETURNING id`,
          [l.lot, l.out.meters, l.out.party, l.out.challan],
        );
        await c.query(
          `INSERT INTO lot_locations (lot_id, location, stage, note, stock_movement_id, moved_by, ts) VALUES ($1, $2, 'dispatch', $3, $4, $5, ${at(l.out.daysAgo)})`,
          [l.lot, l.location, `${l.out.meters} m to ${l.out.party}`, mvOut.rows[0].id, ACCOUNTS.supervisor.id],
        );
      }
      if (l.card) {
        const jc = await c.query(
          `INSERT INTO job_cards (lot_id, process, worker_id, meters_in, meters_out, status, ts_created, ts_closed)
           VALUES ($1, $2, $3, $4, $5, $6, ${at(l.card.daysAgo)}, ${l.card.closed ? at(l.card.daysAgo) : 'NULL'}) RETURNING id`,
          [l.lot, l.card.process, ACCOUNTS.worker.workerId, l.card.metersIn, l.card.closed ? l.card.metersOut : null, l.card.closed ? 'closed' : 'in-process'],
        );
        await c.query(
          `INSERT INTO allotments (worker_id, job_card_id, meters_allotted, shift, date) VALUES ($1, $2, $3, 'Morning', (${at(l.card.daysAgo)})::date)`,
          [ACCOUNTS.worker.workerId, jc.rows[0].id, l.card.metersIn],
        );
        if (!l.card.closed) {
          await c.query(
            `INSERT INTO lot_locations (lot_id, location, stage, note, job_card_id, moved_by) VALUES ($1, 'Floor', 'job_card', $2, $3, $4)`,
            [l.lot, `JC-${jc.rows[0].id} · ${l.card.process} · ${ACCOUNTS.worker.name}`, jc.rows[0].id, ACCOUNTS.supervisor.id],
          );
        }
      }
    }

    if (process.argv.includes('--history')) await seedHistory(c);
    await seedPhase2(c);

    for (const k of KNOWLEDGE) {
      await c.query(`INSERT INTO knowledge_docs (title, body) SELECT $1::varchar, $2::text WHERE NOT EXISTS (SELECT 1 FROM knowledge_docs WHERE lower(title) = lower($1::varchar))`, [k.title, k.body]);
    }

    await c.query('COMMIT');
    console.log(`[seed-demo] Done. Accounts: owner ${ACCOUNTS.owner.id}, supervisor ${ACCOUNTS.supervisor.id} (${ACCOUNTS.supervisor.name}), worker ${ACCOUNTS.worker.id} (${ACCOUNTS.worker.name}). New sample lots: ${newLots}.`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

// ---------- optional history for charts ----------
const H_QUALITIES = [
  { q: 'Poly-Crepe', base: 1400 }, { q: 'Georgette', base: 1100 }, { q: 'Rayon Print', base: 900 },
  { q: 'Chiffon', base: 700 }, { q: 'Satin', base: 500 },
];
const H_MILLS = ['Haridwar Textiles', 'Laxmi Weaving Mills', 'Om Weavers', 'Shree Ram Mills'];
const H_PARTIES = ['Shree Balaji Sarees', 'Mumbai Retailers', 'Kolkata Fashion House', 'Jaipur Prints', 'Delhi Cloth Store', 'Chennai Silks'];

function rng(seed) { // small deterministic PRNG so the history is the same every run
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
}

async function seedHistory(c) {
  const done = await c.query(`SELECT 1 FROM lots WHERE lot_id = 'H-2401' LIMIT 1`);
  if (done.rowCount) { console.log('[seed-demo] History already added.'); return; }
  const rand = rng(2026);
  const months = 24;
  let n = 0;
  for (let m = months - 1; m >= 0; m--) {
    const season = 1 + 0.35 * Math.sin(((months - m) / 12) * 2 * Math.PI); // festival-season swing
    for (let qi = 0; qi < H_QUALITIES.length; qi++) {
      const { q, base } = H_QUALITIES[qi];
      const lot = `H-${String(2401 + n).padStart(4, '0')}`;
      n++;
      const grey = Math.round(base * season * (0.8 + rand() * 0.4));
      const fin = Math.round(grey * (0.9 + rand() * 0.06));
      const inDay = 1 + Math.floor(rand() * 10);
      const inAt = `date_trunc('month', now()) - interval '${m} months' + interval '${inDay} days' + interval '${9 + Math.floor(rand() * 8)} hours'`;
      await c.query(`INSERT INTO lots (lot_id, quality, design) VALUES ($1, $2, $3)`, [lot, q, `D-${100 + qi}`]);
      const mill = H_MILLS[Math.floor(rand() * H_MILLS.length)];
      const mv = await c.query(
        `INSERT INTO stock_movements (lot_id, direction, meters, grey_meters, finished_meters, mill_name, weaver_name, source_doc_id, ts)
         VALUES ($1, 'IN', $2, $3, $2, $4, $4, $5, ${inAt}) RETURNING id`,
        [lot, fin, grey, mill, `CH-H${lot.slice(2)}`],
      );
      await c.query(`INSERT INTO lot_locations (lot_id, location, stage, note, stock_movement_id, ts) VALUES ($1, 'Godown', 'arrival', 'history', $2, ${inAt})`, [lot, mv.rows[0].id]);
      // Dispatch most of it over the following weeks (the current month keeps some stock)
      const parts = 2 + Math.floor(rand() * 3);
      let left = fin;
      for (let p = 0; p < parts; p++) {
        const share = m === 0 ? 0.2 : 0.8 / parts + rand() * 0.05;
        const meters = Math.min(left, Math.round(fin * share));
        if (meters <= 0) break;
        left -= meters;
        const outDays = inDay + 3 + p * 6 + Math.floor(rand() * 4);
        const outAt = m === 0
          ? `LEAST(now() - interval '${1 + p} hours', ${inAt} + interval '${outDays - inDay} days')`
          : `${inAt} + interval '${outDays - inDay} days'`;
        const party = H_PARTIES[Math.floor(rand() * H_PARTIES.length)];
        await c.query(
          `INSERT INTO stock_movements (lot_id, direction, meters, party, source_doc_id, ts) VALUES ($1, 'OUT', $2, $3, $4, ${outAt})`,
          [lot, meters, party, `DSP-H${lot.slice(2)}-${p + 1}`],
        );
      }
    }
  }
  console.log(`[seed-demo] History: ${n} lots over ${months} months.`);
}

// ---------- Phase 2 sample data ----------
const GST_CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(stateCode, pan) { // valid check digit (mod 36)
  const s = `${stateCode}${pan}1Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) { const p = GST_CH.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  return s + GST_CH[(36 - (sum % 36)) % 36];
}

async function seedPhase2(c) {
  const ready = await c.query(`SELECT to_regclass('public.orders') AS t`);
  if (!ready.rows[0].t) return; // migration 005 not applied yet
  const done = await c.query(`SELECT 1 FROM inquiries LIMIT 1`);
  if (done.rowCount) { console.log('[seed-demo] Phase 2 sample data already added.'); return; }

  await c.query(
    `UPDATE app_settings SET legal_name = COALESCE(legal_name, firm_name || ' Pvt Ltd'), gstin = COALESCE(gstin, $1),
       address = COALESCE(address, 'Ring Road, Surat 395002, Gujarat'), state_code = COALESCE(state_code, '24'), phone = COALESCE(phone, '9825000000'),
       bank_name = COALESCE(bank_name, 'HDFC Bank, Ring Road'), bank_account = COALESCE(bank_account, '50200012345678'), bank_ifsc = COALESCE(bank_ifsc, 'HDFC0001234')
     WHERE id = 1`,
    [gstin('24', 'AABCN1234F')],
  );
  const PARTIES = [
    ['Shree Balaji Sarees', '24', 'AAFCS5821K', 'Surat', '9825011111', 300000, 30],
    ['Mumbai Retailers', '27', 'AAGCM4410L', 'Mumbai', '9820022222', 500000, 45],
    ['Kolkata Fashion House', '19', 'AAHFK7713P', 'Kolkata', '9830033333', 250000, 30],
    ['Jaipur Prints', '08', 'AAJFJ2290R', 'Jaipur', '9829044444', 200000, 30],
    ['Delhi Cloth Store', '07', 'AAKFD6632S', 'Delhi', '9810055555', 150000, 21],
    ['Chennai Silks', '33', 'AALFC1187T', 'Chennai', '9840066666', 400000, 60],
  ];
  for (const [name, st, pan, city, phone, limit, days] of PARTIES) {
    await c.query(`INSERT INTO parties (name) VALUES ($1) ON CONFLICT (name_key) DO NOTHING`, [name]);
    await c.query(
      `UPDATE parties SET gstin = COALESCE(gstin, $2), state_code = COALESCE(state_code, $3), city = COALESCE(city, $4), phone = COALESCE(phone, $5),
         credit_limit = COALESCE(credit_limit, $6), credit_days = $7 WHERE name_key = regexp_replace(lower($1), '[^a-z0-9]', '', 'g')`,
      [name, gstin(st, pan), st, city, phone, limit, days],
    );
  }
  // Grey purchase rates ₹/m by quality (selling rates are typed per order: every party gets its own rate).
  const BUY = { 'Poly-Crepe': 41, Georgette: 58, 'Rayon Print': 45, Chiffon: 52, Satin: 70, 'DON-2': 13.5 };
  for (const [q, buy] of Object.entries(BUY)) {
    await c.query(
      `UPDATE stock_movements sm SET purchase_rate = $2 FROM lots l
       WHERE l.lot_id = sm.lot_id AND sm.direction = 'IN' AND sm.purchase_rate IS NULL AND lower(l.quality) = lower($1)`,
      [q, buy],
    );
  }
  // Orders (one due tomorrow, one overdue, one comfortable) + inquiries
  const pid = async (name) => (await c.query(`SELECT id FROM parties WHERE name = $1`, [name])).rows[0].id;
  const ORDERS = [
    ['Shree Balaji Sarees', 'Georgette', 800, 92, 1],
    ['Mumbai Retailers', 'Poly-Crepe', 1500, 68, 6],
    ['Jaipur Prints', 'Rayon Print', 600, 74, -1],
  ];
  for (const [party, quality, meters, rate, due] of ORDERS) {
    await c.query(`INSERT INTO orders (party_id, quality, meters, rate_per_m, promise_date, created_by) VALUES ($1, $2, $3, $4, CURRENT_DATE + $5::int, 'usr-owner')`, [await pid(party), quality, meters, rate, due]);
  }
  await c.query(
    `INSERT INTO inquiries (party_id, party_name, source, raw_text, quality, meters, target_rate, needed_by, status, created_at) VALUES
     ($1, 'Kolkata Fashion House', 'whatsapp', 'Need 1200 mtr Chiffon @82 by next week', 'Chiffon', 1200, 82, CURRENT_DATE + 7, 'new', NOW() - interval '30 hours'),
     ($2, 'Chennai Silks', 'phone', 'सैटिन 500 मीटर चाहिए, रेट बताइए', 'Satin', 500, NULL, NULL, 'quoted', NOW() - interval '3 hours')`,
    [await pid('Kolkata Fashion House'), await pid('Chennai Silks')],
  );
  // Invoices for past months' dispatches (some paid, some overdue) + payments
  const INV = [
    ['Mumbai Retailers', 70, 185000, 45], ['Mumbai Retailers', 25, 96000, 45], ['Shree Balaji Sarees', 50, 64000, 30],
    ['Jaipur Prints', 40, 52000, 30], ['Chennai Silks', 20, 138000, 60], ['Delhi Cloth Store', 35, 41000, 21],
  ];
  let n = (await c.query(`SELECT next_invoice_no FROM app_settings WHERE id = 1`)).rows[0].next_invoice_no;
  for (const [party, daysAgo, taxable, credit] of INV) {
    const st = (await c.query(`SELECT state_code FROM parties WHERE name = $1`, [party])).rows[0].state_code;
    const intra = st === '24';
    const tax = Math.round(taxable * 0.05 * 100) / 100;
    const total = Math.round(taxable + tax);
    await c.query(
      `INSERT INTO invoices (invoice_no, party_id, invoice_date, due_date, taxable_amount, cgst, sgst, igst, total, lines, created_by)
       VALUES ($1, $2, CURRENT_DATE - $3::int, CURRENT_DATE - $3::int + $4::int, $5, $6, $6, $7, $8, '[]'::jsonb, 'usr-owner')`,
      [`INV/2026-27/${String(n).padStart(4, '0')}`, await pid(party), daysAgo, credit, taxable, intra ? tax / 2 : 0, intra ? 0 : tax, total],
    );
    n++;
  }
  await c.query(`UPDATE app_settings SET next_invoice_no = $1 WHERE id = 1`, [n]);
  const PAY = [['Mumbai Retailers', 194250, 30, 'bank', 'NEFT 88121'], ['Shree Balaji Sarees', 30000, 10, 'upi', 'UPI 4411'], ['Chennai Silks', 144900, 5, 'cheque', 'CHQ 000512']];
  for (const [party, amount, daysAgo, mode, ref] of PAY) {
    await c.query(`INSERT INTO payments (party_id, amount, paid_on, mode, reference, created_by) VALUES ($1, $2, CURRENT_DATE - $3::int, $4, $5, 'usr-owner')`, [await pid(party), amount, daysAgo, mode, ref]);
  }
  // Payments cover the oldest invoices first (same rule as the app)
  await c.query(`UPDATE invoices i SET status = 'paid' WHERE status = 'open' AND total <= (SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.party_id = i.party_id)
    - (SELECT COALESCE(SUM(total), 0) FROM invoices o WHERE o.party_id = i.party_id AND o.status <> 'cancelled' AND (o.invoice_date, o.id) < (i.invoice_date, i.id))`);
  console.log('[seed-demo] Phase 2 sample data added (billing, parties, purchase rates, 3 orders, 2 inquiries, 6 invoices, 3 payments).');
}

main().catch((e) => {
  console.error('[seed-demo] Failed:', e.message);
  process.exit(1);
});
