// Master data for money: parties, selling rates, process costs and firm billing settings.
// Route handlers stay thin; all validation + SQL lives here so it can be tested directly.
import { markAgentsStale } from '../agents/stale';
import type { Q } from '../db';
import type { Party } from '../domain';
import { LedgerError } from '../ledger-error';
import { nameKey, nameValue } from '../normalize';
import { sectionKey } from '../settings';
import { dateValue, gstinValue, idValue, intValue, numValue, phoneValue, rupeeValue, seq, stateCodeValue, textValue } from './validate';

// ---------- parties ----------
const PARTY_COLS = `id, name, phone, gstin, address, city, state_code, credit_limit, credit_days, active`;

export function toParty(r: Record<string, unknown>): Party {
  return {
    id: Number(r.id), name: String(r.name), phone: (r.phone as string) ?? null, gstin: (r.gstin as string) ?? null,
    address: (r.address as string) ?? null, city: (r.city as string) ?? null, state_code: (r.state_code as string) ?? null,
    credit_limit: r.credit_limit == null ? null : Number(r.credit_limit), credit_days: Number(r.credit_days ?? 30), active: !!r.active,
  };
}

export type PublicParty = Pick<Party, 'id' | 'name' | 'phone' | 'city' | 'active'>;

export async function listParties(q: Q, opts: { search?: string | null; includeInactive?: boolean } = {}): Promise<Party[]> {
  const s = (opts.search ?? '').trim();
  const r = await q(
    `SELECT ${PARTY_COLS} FROM parties
     WHERE ($1::boolean OR active)
       AND ($2::text = '' OR name ILIKE '%' || $2 || '%' OR name_key LIKE '%' || $3 || '%' OR city ILIKE '%' || $2 || '%' OR phone LIKE '%' || $2 || '%' OR gstin ILIKE '%' || $2 || '%')
     ORDER BY active DESC, name LIMIT 500`,
    [!!opts.includeInactive, s, nameKey(s)],
  );
  return r.rows.map(toParty);
}

/** Validate the editable party fields present in `b` (all optional for PATCH). */
function partyFields(b: Record<string, unknown>, isCreate: boolean): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (isCreate || 'name' in b) {
    const n = nameValue(b.name, 'Party name', 150);
    if (!n) throw new LedgerError('Party name is required.');
    if (n.length < 2) throw new LedgerError('Party name is too short.');
    f.name = n;
  }
  if ('phone' in b) f.phone = phoneValue(b.phone);
  if ('gstin' in b) f.gstin = gstinValue(b.gstin);
  if ('address' in b) f.address = textValue(b.address, 'Address', 400, true);
  if ('city' in b) f.city = textValue(b.city, 'City', 100);
  if ('state_code' in b) f.state_code = stateCodeValue(b.state_code);
  if (f.gstin) f.state_code = String(f.gstin).slice(0, 2); // GSTIN decides the state
  if ('credit_limit' in b) f.credit_limit = rupeeValue(b.credit_limit, 'Credit limit', { allowZero: true, nullable: true, max: 1e10 });
  if ('credit_days' in b) f.credit_days = intValue(b.credit_days, 'Credit days', 0, 365);
  if ('active' in b) {
    if (typeof b.active !== 'boolean') throw new LedgerError('active must be true or false.');
    f.active = b.active;
  }
  return f;
}

async function assertNameFree(q: Q, name: string, exceptId: number | null) {
  const r = await q(`SELECT id, name FROM parties WHERE name_key = $1 AND ($2::int IS NULL OR id <> $2)`, [nameKey(name), exceptId]);
  if (r.rows[0]) throw new LedgerError(`A party named "${r.rows[0].name}" already exists. Edit that one instead.`, 409);
}

async function assertGstinFree(q: Q, gstin: string | null | undefined, exceptId: number | null) {
  if (!gstin) return;
  const r = await q(`SELECT name FROM parties WHERE gstin = $1 AND ($2::int IS NULL OR id <> $2)`, [gstin, exceptId]);
  if (r.rows[0]) throw new LedgerError(`GSTIN ${gstin} is already used by "${r.rows[0].name}".`, 409);
}

function uniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505';
}

export async function createParty(q: Q, b: Record<string, unknown>): Promise<Party> {
  const f = partyFields(b, true);
  await assertNameFree(q, String(f.name), null);
  await assertGstinFree(q, f.gstin as string | null, null);
  const cols = Object.keys(f);
  try {
    const r = await q(`INSERT INTO parties (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${PARTY_COLS}`, cols.map((c) => f[c]));
    return toParty(r.rows[0]);
  } catch (e) {
    if (uniqueViolation(e)) throw new LedgerError(`A party named "${f.name}" already exists.`, 409);
    throw e;
  }
}

export async function updateParty(q: Q, idRaw: unknown, b: Record<string, unknown>): Promise<Party> {
  await markAgentsStale(q);
  const id = idValue(idRaw, 'party');
  const cur = await q(`SELECT ${PARTY_COLS} FROM parties WHERE id = $1 FOR UPDATE`, [id]);
  if (!cur.rows[0]) throw new LedgerError('Party not found.', 404);
  const f = partyFields(b, false);
  // Clearing the GSTIN keeps the state unless one is given.
  if ('gstin' in f && !f.gstin && !('state_code' in f)) delete f.state_code;
  if (!Object.keys(f).length) throw new LedgerError('Nothing to update.');
  if (f.name) await assertNameFree(q, String(f.name), id);
  if (f.gstin) await assertGstinFree(q, String(f.gstin), id);
  const cols = Object.keys(f);
  try {
    const r = await q(`UPDATE parties SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING ${PARTY_COLS}`, [id, ...cols.map((c) => f[c])]);
    return toParty(r.rows[0]);
  } catch (e) {
    if (uniqueViolation(e)) throw new LedgerError(`A party named "${f.name}" already exists.`, 409);
    throw e;
  }
}

/** Party by id (number / numeric string) or by name (ignoring case, spaces, dots). */
export async function findParty(q: Q, ref: unknown, refId?: unknown): Promise<Party | null> {
  const idRaw = refId ?? (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref.trim())) ? ref : null);
  if (idRaw != null && String(idRaw).trim() !== '') {
    const r = await q(`SELECT ${PARTY_COLS} FROM parties WHERE id = $1`, [idValue(idRaw, 'party')]);
    return r.rows[0] ? toParty(r.rows[0]) : null;
  }
  const n = nameValue(ref, 'Party', 150);
  if (!n) return null;
  const r = await q(`SELECT ${PARTY_COLS} FROM parties WHERE name_key = $1`, [nameKey(n)]);
  return r.rows[0] ? toParty(r.rows[0]) : null;
}

// ---------- qualities ----------
/** Every quality the firm deals in: lots ∪ orders, one spelling per case-insensitive name. */
export async function listQualities(q: Q): Promise<string[]> {
  const r = await q(
    `SELECT DISTINCT ON (lower(btrim(quality))) btrim(quality) AS quality FROM (
       SELECT quality FROM lots UNION ALL SELECT quality FROM orders UNION ALL SELECT quality FROM rates
     ) x WHERE btrim(quality) <> '' ORDER BY lower(btrim(quality)), quality`,
  );
  return r.rows.map((x) => String(x.quality)).sort((a, b) => a.localeCompare(b));
}

// ---------- selling rates ----------
export interface RateRow { id: number; quality: string; party_id: number | null; party_name: string | null; rate_per_m: number; valid_from: string; created_at: string }
export interface QualityRate {
  quality: string;
  rate_per_m: number | null; valid_from: string | null; // current general rate
  upcoming: { rate_per_m: number; valid_from: string } | null; // next general rate already set for a later date
  overrides: { party_id: number; party_name: string; rate_per_m: number; valid_from: string }[]; // current party rates
}

const toRate = (r: Record<string, unknown>): RateRow => ({
  id: Number(r.id), quality: String(r.quality), party_id: r.party_id == null ? null : Number(r.party_id), party_name: (r.party_name as string) ?? null,
  rate_per_m: Number(r.rate_per_m), valid_from: String(r.valid_from), created_at: String(r.created_at),
});

export async function ratesOverview(q: Q): Promise<{ qualities: QualityRate[]; history: RateRow[] }> {
  const [quals, all] = await seq([
    () => listQualities(q),
    () => q(`SELECT r.id, r.quality, r.party_id, p.name AS party_name, r.rate_per_m, to_char(r.valid_from, 'YYYY-MM-DD') AS valid_from, r.created_at
       FROM rates r LEFT JOIN parties p ON p.id = r.party_id
       ORDER BY r.valid_from DESC, r.id DESC`)]);
  const rows = all.rows.map(toRate);
  const today = (await q(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0].d as string;
  const out: QualityRate[] = quals.map((quality) => {
    const mine = rows.filter((r) => r.quality.toLowerCase() === quality.toLowerCase());
    const general = mine.filter((r) => r.party_id == null);
    const cur = general.find((r) => r.valid_from <= today) ?? null; // rows are newest first
    const next = general.filter((r) => r.valid_from > today).at(-1) ?? null;
    const seen = new Set<number>();
    const overrides: QualityRate['overrides'] = [];
    for (const r of mine) {
      if (r.party_id == null || r.valid_from > today || seen.has(r.party_id)) continue;
      seen.add(r.party_id);
      overrides.push({ party_id: r.party_id, party_name: r.party_name ?? `#${r.party_id}`, rate_per_m: r.rate_per_m, valid_from: r.valid_from });
    }
    return {
      quality, rate_per_m: cur?.rate_per_m ?? null, valid_from: cur?.valid_from ?? null,
      upcoming: next ? { rate_per_m: next.rate_per_m, valid_from: next.valid_from } : null,
      overrides: overrides.sort((a, b) => a.party_name.localeCompare(b.party_name)),
    };
  });
  return { qualities: out, history: rows.slice(0, 300) };
}

export async function addRate(q: Q, b: Record<string, unknown>, actor: string | null): Promise<RateRow> {
  await markAgentsStale(q);
  const raw = nameValue(b.quality, 'Quality');
  if (!raw) throw new LedgerError('Quality is required.');
  const known = (await listQualities(q)).find((x) => x.toLowerCase() === raw.toLowerCase());
  const quality = known ?? raw;
  let partyId: number | null = null;
  if (b.party_id != null && b.party_id !== '') {
    partyId = idValue(b.party_id, 'party');
    const p = await q(`SELECT id FROM parties WHERE id = $1`, [partyId]);
    if (!p.rows[0]) throw new LedgerError('Party not found.', 404);
  }
  const rate = rupeeValue(b.rate_per_m, 'Rate ₹/m', { max: 100_000 })!;
  const validFrom = dateValue(b.valid_from, 'Valid from');
  const r = await q(
    `INSERT INTO rates (quality, party_id, rate_per_m, valid_from, created_by)
     VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5)
     RETURNING id, quality, party_id, rate_per_m, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, created_at`,
    [quality, partyId, rate, validFrom, await knownUser(q, actor)],
  );
  const row = toRate(r.rows[0]);
  if (partyId) row.party_name = (await q(`SELECT name FROM parties WHERE id = $1`, [partyId])).rows[0]?.name ?? null;
  return row;
}

// ---------- process costs ----------
export interface CostRow { id: number; section: string; cost_per_m: number; valid_from: string; created_at: string }
export interface SectionCost { section: string; active: boolean; cost_per_m: number | null; valid_from: string | null; upcoming: { cost_per_m: number; valid_from: string } | null; job_cards: number }

export async function costsOverview(q: Q): Promise<{ sections: SectionCost[]; history: CostRow[] }> {
  const [secs, all, jc, today] = await seq([
    () => q(`SELECT name, active FROM sections ORDER BY sort_order, name`),
    () => q(`SELECT id, section, cost_per_m, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, created_at FROM process_costs ORDER BY valid_from DESC, id DESC`),
    () => q(`SELECT process, COUNT(*)::int AS n FROM job_cards GROUP BY process`),
    () => q(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)]);
  const d = today.rows[0].d as string;
  const rows: CostRow[] = all.rows.map((r) => ({ id: Number(r.id), section: r.section, cost_per_m: Number(r.cost_per_m), valid_from: r.valid_from, created_at: String(r.created_at) }));
  const cards = new Map<string, number>();
  for (const r of jc.rows) cards.set(sectionKey(r.process), (cards.get(sectionKey(r.process)) ?? 0) + Number(r.n));
  const list: { name: string; active: boolean }[] = secs.rows.map((s) => ({ name: s.name, active: s.active }));
  // Sections used on job cards but missing from the sections list still need a cost.
  for (const [k] of cards) if (!list.some((s) => sectionKey(s.name) === k)) {
    const raw = jc.rows.find((r) => sectionKey(r.process) === k)!.process as string;
    list.push({ name: raw.replace(/\s*section\s*$/i, '').trim(), active: false });
  }
  const sections = list.map((s) => {
    const mine = rows.filter((r) => sectionKey(r.section) === sectionKey(s.name));
    const cur = mine.find((r) => r.valid_from <= d) ?? null;
    const next = mine.filter((r) => r.valid_from > d).at(-1) ?? null;
    return { section: s.name, active: s.active, cost_per_m: cur?.cost_per_m ?? null, valid_from: cur?.valid_from ?? null, upcoming: next ? { cost_per_m: next.cost_per_m, valid_from: next.valid_from } : null, job_cards: cards.get(sectionKey(s.name)) ?? 0 };
  });
  return { sections, history: rows.slice(0, 300) };
}

export async function addCost(q: Q, b: Record<string, unknown>, actor: string | null): Promise<CostRow> {
  await markAgentsStale(q);
  const raw = nameValue(b.section, 'Section', 60);
  if (!raw) throw new LedgerError('Section is required.');
  const secs = await q(`SELECT name FROM sections UNION SELECT DISTINCT process FROM job_cards`);
  const match = secs.rows.map((r) => String(r.name)).find((n) => sectionKey(n) === sectionKey(raw));
  if (!match) throw new LedgerError(`"${raw}" is not a section. Add it under Sections first.`);
  const section = match.replace(/\s*section\s*$/i, '').trim();
  const cost = rupeeValue(b.cost_per_m, 'Cost ₹/m', { allowZero: true, max: 10_000 })!;
  const validFrom = dateValue(b.valid_from, 'Valid from');
  const r = await q(
    `INSERT INTO process_costs (section, cost_per_m, valid_from, created_by) VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4)
     RETURNING id, section, cost_per_m, to_char(valid_from, 'YYYY-MM-DD') AS valid_from, created_at`,
    [section, cost, validFrom, await knownUser(q, actor)],
  );
  const x = r.rows[0];
  return { id: Number(x.id), section: x.section, cost_per_m: Number(x.cost_per_m), valid_from: x.valid_from, created_at: String(x.created_at) };
}

// ---------- billing settings ----------
export interface BillingSettings {
  legal_name: string | null; gstin: string | null; address: string | null; state_code: string | null; phone: string | null;
  bank_name: string | null; bank_account: string | null; bank_ifsc: string | null; invoice_prefix: string; next_invoice_no: number;
  hsn_code: string; gst_rate_pct: number; low_stock_m: number; ageing_days: number; firm_name: string;
}

export async function readBillingSettings(q: Q): Promise<BillingSettings> {
  const r = await q(`SELECT * FROM app_settings WHERE id = 1`);
  const s = r.rows[0];
  if (!s) throw new LedgerError('Firm settings are missing.', 500);
  return {
    firm_name: s.firm_name ?? '', legal_name: s.legal_name || null, gstin: s.gstin || null, address: s.address || null, state_code: s.state_code || null,
    phone: s.phone || null, bank_name: s.bank_name || null, bank_account: s.bank_account || null, bank_ifsc: s.bank_ifsc || null,
    invoice_prefix: s.invoice_prefix ?? 'INV', next_invoice_no: Number(s.next_invoice_no ?? 1), hsn_code: s.hsn_code ?? '5407',
    gst_rate_pct: Number(s.gst_rate_pct ?? 5), low_stock_m: Number(s.low_stock_m ?? 200), ageing_days: Number(s.ageing_days ?? 60),
  };
}

export async function updateBillingSettings(q: Q, b: Record<string, unknown>): Promise<BillingSettings> {
  const cur = await q(`SELECT next_invoice_no FROM app_settings WHERE id = 1 FOR UPDATE`);
  if (!cur.rows[0]) throw new LedgerError('Firm settings are missing.', 500);
  const f: Record<string, unknown> = {};
  if ('legal_name' in b) f.legal_name = textValue(b.legal_name, 'Legal name', 150);
  if ('gstin' in b) f.gstin = gstinValue(b.gstin);
  if ('address' in b) f.address = textValue(b.address, 'Address', 400, true);
  if ('state_code' in b) f.state_code = stateCodeValue(b.state_code);
  if (f.gstin) f.state_code = String(f.gstin).slice(0, 2);
  if ('phone' in b) f.phone = phoneValue(b.phone);
  if ('bank_name' in b) f.bank_name = textValue(b.bank_name, 'Bank name', 100);
  if ('bank_account' in b) {
    const a = b.bank_account == null ? '' : String(b.bank_account).replace(/[\s-]/g, '');
    if (a && !/^[0-9]{9,18}$/.test(a)) throw new LedgerError('Bank account number should be 9–18 digits.');
    f.bank_account = a || null;
  }
  if ('bank_ifsc' in b) {
    const i = b.bank_ifsc == null ? '' : String(b.bank_ifsc).replace(/\s+/g, '').toUpperCase();
    if (i && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(i)) throw new LedgerError('IFSC should look like HDFC0001234 (4 letters, 0, then 6 letters/digits).');
    f.bank_ifsc = i || null;
  }
  if ('invoice_prefix' in b) {
    const p = String(b.invoice_prefix ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(p)) throw new LedgerError('Invoice prefix: 1–12 letters, digits or "-", e.g. INV or NG.');
    f.invoice_prefix = p;
  }
  if ('next_invoice_no' in b) {
    const n = intValue(b.next_invoice_no, 'Next invoice number', 1, 99_999_999);
    const now = Number(cur.rows[0].next_invoice_no);
    if (n < now) throw new LedgerError(`Next invoice number can only go up (it is ${now} now), so numbers are never reused.`);
    f.next_invoice_no = n;
  }
  if ('hsn_code' in b) {
    const h = String(b.hsn_code ?? '').replace(/\s+/g, '');
    if (!/^[0-9]{4,8}$/.test(h)) throw new LedgerError('HSN code should be 4 to 8 digits, e.g. 5407.');
    f.hsn_code = h;
  }
  if ('gst_rate_pct' in b) f.gst_rate_pct = numValue(b.gst_rate_pct, 'GST rate %', 0, 28);
  if ('low_stock_m' in b) f.low_stock_m = numValue(b.low_stock_m, 'Low stock (m)', 0, 1_000_000);
  if ('ageing_days' in b) f.ageing_days = intValue(b.ageing_days, 'Ageing days', 1, 730);
  const cols = Object.keys(f);
  if (!cols.length) throw new LedgerError('Nothing to update.');
  await q(`UPDATE app_settings SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, cols.map((c) => f[c]));
  return readBillingSettings(q);
}

/** created_by must reference users(id); unknown ids (preview actors) are stored as NULL. */
export async function knownUser(q: Q, actor: string | null): Promise<string | null> {
  if (!actor) return null;
  const r = await q(`SELECT id FROM users WHERE id = $1`, [actor]);
  return r.rows[0] ? actor : null;
}
