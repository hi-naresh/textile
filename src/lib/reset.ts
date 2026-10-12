// Reset data (owner in My firm → Reset data, and the developer console → Reset).
// The firm can wipe one kind of data, several, or everything, to start fresh (e.g. after a trial run or a bad import).
// Always kept: the owner account, the developer, firm details & billing, policy, stock alert levels, firm knowledge,
// markets & shops, sections, agent / WhatsApp / access settings and the sign-in audit trail.
//
// Parts depend on each other through the database (a lot can't go while its job cards stay, a party can't go while its
// orders / bills stay), so choosing a part also includes what it needs — see NEEDS. Everything runs in ONE transaction.
import type { Q } from './db';
import { removePerson } from './auth/users';

export type ResetPart = 'stock' | 'floor' | 'orders' | 'billing' | 'parties' | 'employees' | 'activity';

export const RESET_PARTS: { key: ResetPart; label: string; what: string }[] = [
  { key: 'stock', label: 'Stock', what: 'All lots, IN / OUT entries, lot locations, the edit log and photo reads of challans. Floor work and stock kept aside for orders go too (they point at lots).' },
  { key: 'floor', label: 'Floor work', what: 'Job cards, worker allotments, daily efficiency and camera activity. Workers themselves stay.' },
  { key: 'orders', label: 'Orders & inquiries', what: 'All orders, inquiries and stock kept aside for orders. Stock entries stay, without their order link.' },
  { key: 'billing', label: 'Dispatches, bills & payments', what: 'All dispatches, invoices and payments received.' },
  { key: 'parties', label: 'Parties', what: 'All parties (buyers) and their rates. Their orders, bills and payments go too.' },
  { key: 'employees', label: 'Employees', what: 'All supervisors and workers, their sign-ins and sign ups waiting for approval. They are signed out at once. Old records keep their names.' },
  { key: 'activity', label: 'Alerts & activity', what: 'Alerts and suggestions, agent runs, chat history, AI usage, app errors, WhatsApp message log and generated documents.' },
];

/** Choosing a part also includes these (database links). */
export const NEEDS: Partial<Record<ResetPart, ResetPart[]>> = {
  stock: ['floor'],
  parties: ['orders', 'billing'],
};

export function isResetPart(v: unknown): v is ResetPart {
  return RESET_PARTS.some((p) => p.key === v);
}

/** The chosen parts plus everything they need, in a stable order. */
export function expandParts(parts: ResetPart[]): ResetPart[] {
  const out = new Set<ResetPart>();
  const add = (p: ResetPart) => { if (out.has(p)) return; out.add(p); (NEEDS[p] ?? []).forEach(add); };
  parts.forEach(add);
  return RESET_PARTS.map((p) => p.key).filter((k) => out.has(k));
}

/** Tables each part empties (used for the backup file). */
export const PART_TABLES: Record<ResetPart, string[]> = {
  stock: ['lots', 'stock_movements', 'lot_locations', 'allocations', 'ledger_edits', 'capture_events'],
  floor: ['job_cards', 'allotments', 'efficiency_daily', 'cctv_activity'],
  orders: ['orders', 'inquiries', 'allocations'],
  billing: ['dispatches', 'invoices', 'payments'],
  parties: ['parties', 'rates'],
  employees: ['users', 'workers', 'supervisor_sections'],
  activity: ['agent_suggestions', 'agent_runs', 'chat_audit', 'llm_usage', 'app_errors', 'whatsapp_messages', 'generated_docs'],
};

/** Rows of a table that a part removes (employees: only supervisors / workers / sign ups, never the owner; no password hashes). */
export function partRowsSql(part: ResetPart, table: string): string {
  if (part === 'employees') {
    if (table === 'users') return `SELECT id, name, role, phone, status, requested_role, worker_id, active, created_at, last_login_at FROM users
      WHERE deleted_at IS NULL AND role IS DISTINCT FROM 'owner' AND role IS DISTINCT FROM 'developer' AND role IS DISTINCT FROM 'admin'`;
    if (table === 'workers') return `SELECT * FROM workers w WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.worker_id = w.id AND u.role = 'owner')`;
  }
  return `SELECT * FROM ${table}`;
}

export type ResetCounts = Record<ResetPart, { label: string; n: number; detail: string }>;

/** What each part would remove right now. */
export async function resetCounts(q: Q): Promise<ResetCounts> {
  const r = await q(`SELECT
      (SELECT count(*) FROM lots)::int AS lots,
      (SELECT count(*) FROM stock_movements)::int AS moves,
      (SELECT count(*) FROM capture_events)::int AS reads,
      (SELECT count(*) FROM job_cards)::int AS jobs,
      (SELECT count(*) FROM orders)::int AS orders,
      (SELECT count(*) FROM inquiries)::int AS inquiries,
      (SELECT count(*) FROM dispatches)::int AS dispatches,
      (SELECT count(*) FROM invoices)::int AS invoices,
      (SELECT count(*) FROM payments)::int AS payments,
      (SELECT count(*) FROM parties)::int AS parties,
      (SELECT count(*) FROM users WHERE deleted_at IS NULL AND role = 'supervisor' AND status = 'approved')::int AS sups,
      (SELECT count(*) FROM workers WHERE deleted_at IS NULL)::int AS workers,
      (SELECT count(*) FROM users WHERE deleted_at IS NULL AND status <> 'approved' AND role IS DISTINCT FROM 'owner' AND role IS DISTINCT FROM 'developer')::int AS signups,
      (SELECT count(*) FROM agent_suggestions)::int AS alerts,
      (SELECT count(*) FROM chat_audit)::int AS chats,
      (SELECT count(*) FROM whatsapp_messages)::int AS wa`);
  const c = r.rows[0];
  const f = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
  const label = (k: ResetPart) => RESET_PARTS.find((p) => p.key === k)!.label;
  return {
    stock: { label: label('stock'), n: c.lots + c.moves + c.reads, detail: `${f(c.lots, 'lot')}, ${f(c.moves, 'entry', 'entries')}, ${f(c.reads, 'photo read')}` },
    floor: { label: label('floor'), n: c.jobs, detail: f(c.jobs, 'job card') },
    orders: { label: label('orders'), n: c.orders + c.inquiries, detail: `${f(c.orders, 'order')}, ${f(c.inquiries, 'inquiry', 'inquiries')}` },
    billing: { label: label('billing'), n: c.dispatches + c.invoices + c.payments, detail: `${f(c.dispatches, 'dispatch', 'dispatches')}, ${f(c.invoices, 'bill')}, ${f(c.payments, 'payment')}` },
    parties: { label: label('parties'), n: c.parties, detail: f(c.parties, 'party', 'parties') },
    employees: { label: label('employees'), n: c.sups + c.workers + c.signups, detail: `${f(c.sups, 'supervisor')}, ${f(c.workers, 'worker')}, ${f(c.signups, 'sign up')} waiting` },
    activity: { label: label('activity'), n: c.alerts + c.chats + c.wa, detail: `${f(c.alerts, 'alert')}, ${f(c.chats, 'chat message')}, ${f(c.wa, 'WhatsApp message')}` },
  };
}

/** Restart a table's id numbers at 1 when it is empty (e.g. order #1 again after a full reset). */
async function restartIds(q: Q, tables: string[]) {
  for (const t of tables) {
    const s = await q(`SELECT pg_get_serial_sequence($1, 'id') AS seq, NOT EXISTS (SELECT 1 FROM ${t}) AS empty`, [t]);
    const seq = s.rows[0]?.seq as string | null;
    if (seq && s.rows[0].empty) await q(`SELECT setval($1::regclass, 1, false)`, [seq]);
  }
}

/**
 * Wipes the given parts (already expanded). Runs inside the caller's transaction.
 * Returns how many rows each part removed. `by` = the user doing it (never removed).
 */
export async function runReset(q: Q, parts: ResetPart[], by: string): Promise<Record<string, number>> {
  const has = (p: ResetPart) => parts.includes(p);
  const done: Record<string, number> = {};
  const del = async (key: string, sql: string) => { const r = await q(sql); done[key] = (done[key] ?? 0) + (r.rowCount ?? 0); };
  await q(`SET LOCAL lock_timeout = '10s'`);
  await q(`SET LOCAL statement_timeout = '10min'`);

  if (has('activity')) {
    for (const t of PART_TABLES.activity) await del('activity', `DELETE FROM ${t}`);
  } else {
    // Open alerts may point at things that are about to go; the agents raise fresh ones on their next run.
    await del('alerts_cleared', `DELETE FROM agent_suggestions WHERE status = 'open'`);
  }

  if (has('billing')) {
    await del('billing', `DELETE FROM payments`);
    await del('billing', `DELETE FROM invoices`);
    await del('billing', `DELETE FROM dispatches`); // stock entries / WhatsApp log keep their rows, the link is emptied
  }
  if (has('orders')) {
    await del('orders', `DELETE FROM allocations`);
    await del('orders', `DELETE FROM orders`); // stock entries, dispatches, bills: the order link is emptied
    await del('orders', `DELETE FROM inquiries`);
  }
  if (has('parties')) {
    await del('parties', `DELETE FROM rates`);
    await del('parties', `DELETE FROM parties`);
  }

  if (has('stock')) {
    // Whole stock in one go. TRUNCATE is instant even with millions of rows; it skips the row triggers,
    // so the derived lists (names, quality / design pairs) are emptied here too and the stock version is bumped.
    const n = await q(`SELECT (SELECT count(*) FROM lots) + (SELECT count(*) FROM stock_movements) + (SELECT count(*) FROM capture_events) + (SELECT count(*) FROM job_cards) AS n`);
    await q(`TRUNCATE allotments, job_cards, lot_locations, allocations, stock_movements, lots, ledger_edits, capture_events, known_names, lot_facets`);
    await q(`DELETE FROM efficiency_daily`);
    await q(`DELETE FROM cctv_activity`);
    await q(`SELECT nextval('stock_rev')`);
    done.stock = Number(n.rows[0].n);
  } else if (has('floor')) {
    await del('floor', `DELETE FROM allotments`);
    await del('floor', `DELETE FROM job_cards`); // lot locations keep their place, the job card link is emptied
    await del('floor', `DELETE FROM efficiency_daily`);
    await del('floor', `DELETE FROM cctv_activity`);
  }

  if (has('employees')) {
    // Soft remove (same as My firm → Team → Remove): history keeps names, phone numbers can be used again.
    const people = await q(`SELECT id, worker_id FROM users
       WHERE deleted_at IS NULL AND role IS DISTINCT FROM 'owner' AND role IS DISTINCT FROM 'developer' AND role IS DISTINCT FROM 'admin' AND id <> $1
       FOR UPDATE`, [by]);
    for (const u of people.rows) await removePerson(q, u, by);
    const w = await q(`UPDATE workers w SET deleted_at = now(), active = false
       WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.worker_id = w.id AND u.deleted_at IS NULL)`);
    done.employees = people.rows.length + (w.rowCount ?? 0);
  }

  await restartIds(q, ['orders', 'inquiries', 'dispatches', 'invoices', 'payments', 'parties', 'stock_movements', 'lot_locations', 'job_cards', 'allocations', 'capture_events', 'ledger_edits', 'agent_suggestions']);
  return done;
}
