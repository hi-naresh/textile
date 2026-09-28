// Rates (₹/m selling price) and process costs, shared by inquiries, orders, invoices and costing.
import type { Q } from './db';

/** Selling rate for a quality on a date: the party's own rate wins over the general one; latest valid_from wins. */
export async function rateFor(q: Q, quality: string, partyId: number | null, onDate?: string | null): Promise<number | null> {
  const r = await q(
    `SELECT rate_per_m FROM rates
     WHERE lower(quality) = lower($1) AND (party_id = $2 OR party_id IS NULL) AND valid_from <= COALESCE($3::date, CURRENT_DATE)
     ORDER BY (party_id IS NULL), valid_from DESC, id DESC LIMIT 1`,
    [quality, partyId, onDate ?? null],
  );
  return r.rows[0] ? Number(r.rows[0].rate_per_m) : null;
}

/** Process cost ₹/m for a section on a date (latest valid_from). */
export async function processCostFor(q: Q, section: string, onDate?: string | null): Promise<number | null> {
  const r = await q(
    `SELECT cost_per_m FROM process_costs
     WHERE lower(btrim(regexp_replace(section, '\\s*section\\s*$', '', 'i'))) = lower(btrim(regexp_replace($1, '\\s*section\\s*$', '', 'i')))
       AND valid_from <= COALESCE($2::date, CURRENT_DATE)
     ORDER BY valid_from DESC, id DESC LIMIT 1`,
    [section, onDate ?? null],
  );
  return r.rows[0] ? Number(r.rows[0].cost_per_m) : null;
}
