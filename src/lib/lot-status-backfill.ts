// One-time backfill (issue #7): sales-register rows imported before migration 015 carry a LOT S code but no status.
//   planBackfill()  → what would change, written nowhere: statuses per code, and every lot an End code would close with
//                     its balance and the meters that would be written off. The owner checks this list first.
//   applyBackfill() → does it, in the caller's transaction. Running it again changes nothing.
// Mapping (registers.ts statusFromLotS): S, R → Running; E, A → End. A is still our guess (docs/AMBIGUOUS.md §1).
// A lot closes on its latest E / A row, dated on that row (closeLot, reason 'register'). A lot with any entry after
// that row is not closed and its E / A rows stay empty: it is listed for the owner to look at instead.
import type { Q } from './db';
import { closeLot, type LotClosed } from './ledger';
import { LOT_S_STATUS } from './registers';

export interface BackfillLot {
  lot_id: string; reg_lot_no: string | null; quality: string;
  end_movement_id: number; end_date: string; end_bill: string | null; end_code: string; end_meters: number;
  balance: number; // now, before the close
  adjustment: number; // + left over written off, − sent beyond the balance written back
  action: 'close' | 'review';
  why: string | null; // review: what to look at
}
export interface BackfillPlan {
  statuses: { code: string; status: string; rows: number }[]; // rows that get a status from their code
  unknown: { code: string; rows: number }[]; // codes with no mapping: left empty
  lots: BackfillLot[];
}

const MAPPED = Object.keys(LOT_S_STATUS);
const END_CODES = MAPPED.filter((c) => LOT_S_STATUS[c] === 'end');
const r2 = (n: number) => Math.round(n * 100) / 100;

export async function planBackfill(q: Q): Promise<BackfillPlan> {
  const codes = await q(
    `SELECT upper(btrim(lot_status_code)) AS code, COUNT(*)::int AS n FROM stock_movements
      WHERE direction = 'OUT' AND kind = 'normal' AND entry_status IS NULL AND lot_status_code IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
  );
  const lots = await q(
    `SELECT e.lot_id, l.reg_lot_no, l.quality, l.bal_m, e.id, to_char(e.ts, 'YYYY-MM-DD') AS d, e.source_doc_id, upper(btrim(e.lot_status_code)) AS code, e.meters,
            (SELECT COUNT(*)::int FROM stock_movements x WHERE x.lot_id = e.lot_id AND x.kind = 'normal' AND (x.ts, x.id) > (e.ts, e.id)) AS after_n
       FROM (SELECT DISTINCT ON (lot_id) id, lot_id, ts, source_doc_id, lot_status_code, meters FROM stock_movements
              WHERE direction = 'OUT' AND kind = 'normal' AND upper(btrim(lot_status_code)) = ANY($1::text[])
                AND (entry_status IS NULL OR entry_status = 'end')
              ORDER BY lot_id, ts DESC, id DESC) e
       JOIN lots l ON l.lot_id = e.lot_id
      WHERE l.closed_at IS NULL
      ORDER BY e.lot_id`,
    [END_CODES],
  );
  return {
    statuses: codes.rows.filter((x) => MAPPED.includes(x.code)).map((x) => ({ code: x.code, status: LOT_S_STATUS[x.code], rows: x.n })),
    unknown: codes.rows.filter((x) => !MAPPED.includes(x.code)).map((x) => ({ code: x.code, rows: x.n })),
    lots: lots.rows.map((x) => {
      const bal = r2(Number(x.bal_m));
      const after = Number(x.after_n);
      return {
        lot_id: x.lot_id, reg_lot_no: x.reg_lot_no ?? null, quality: x.quality,
        end_movement_id: Number(x.id), end_date: x.d, end_bill: x.source_doc_id ?? null, end_code: x.code, end_meters: Number(x.meters),
        balance: bal, adjustment: after ? 0 : bal,
        action: after ? 'review' as const : 'close' as const,
        why: after ? `${after} ${after === 1 ? 'entry comes' : 'entries come'} after the ${x.code} row, so the register may be out of order. Not closed.` : null,
      };
    }),
  };
}

/** Apply the plan (re-read inside the transaction). `by`: who ran it (closed_by / lot_closures). */
export async function applyBackfill(q: Q, by: string | null): Promise<{ statuses: number; closed: LotClosed[]; review: BackfillLot[] }> {
  const plan = await planBackfill(q);
  const review = plan.lots.filter((l) => l.action === 'review');
  const closing = plan.lots.filter((l) => l.action === 'close');
  // S / R rows → Running everywhere. E / A rows: only the row that closes its lot becomes End; the others stay empty
  // (a lot under review, or an earlier E / A in a lot that closes later) so no open lot has a stray End entry.
  const running = MAPPED.filter((c) => LOT_S_STATUS[c] === 'running');
  const r1 = await q(
    `UPDATE stock_movements SET entry_status = 'running'
      WHERE direction = 'OUT' AND kind = 'normal' AND entry_status IS NULL AND upper(btrim(lot_status_code)) = ANY($1::text[])`,
    [running],
  );
  const ends = closing.map((l) => l.end_movement_id);
  const r3 = ends.length ? await q(`UPDATE stock_movements SET entry_status = 'end' WHERE id = ANY($1::int[]) AND entry_status IS NULL`, [ends]) : { rowCount: 0 };
  const closed: LotClosed[] = [];
  for (const l of closing) closed.push(await closeLot(q, l.lot_id, { reason: 'register', by, endMovementId: l.end_movement_id, note: `Sales register: ${l.end_code} on bill ${l.end_bill ?? '—'}` }));
  return { statuses: (r1.rowCount ?? 0) + (r3.rowCount ?? 0), closed, review };
}
