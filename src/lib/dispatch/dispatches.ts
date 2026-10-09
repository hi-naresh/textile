// Dispatches: one truck / parcel = one dispatches row + one OUT stock movement per lot.
// Stock checks, lot location and the Logistics hook all run through recordOutgoing.
import type { Q } from '../db';
import type { Dispatch } from '../domain';
import { LedgerError } from '../ledger-error';
import { recordOutgoing } from '../ledger';
import { lotStock, reservedForOthers } from '../stock';
import { challanCode, lotCode, metersValue } from '../normalize';
import { partyByName } from '../parties';
import { textOrNull, validActor } from './common';

export interface DispatchLine { movement_id: number; lot_id: string; quality: string; design: string; meters: number; order_id: number | null }

const LIST_SQL = `
  SELECT d.id, d.order_id, d.party_id, p.name AS party_name, p.address AS party_address, p.gstin AS party_gstin, p.state_code AS party_state,
         p.city AS party_city, d.challan_no, d.transporter, d.lr_no, d.vehicle_no, d.packages, d.dispatched_at,
         COALESCE(m.meters, 0) AS meters, COALESCE(m.lots, ARRAY[]::text[]) AS lots, COALESCE(m.qualities, ARRAY[]::text[]) AS qualities,
         inv.id AS invoice_id, inv.invoice_no, (p.phone IS NOT NULL AND p.phone <> '') AS party_has_phone,
         wa.status AS wa_status, wa.at AS wa_at, wa.error AS wa_error
  FROM dispatches d
  LEFT JOIN parties p ON p.id = d.party_id
  LEFT JOIN LATERAL (
    SELECT SUM(sm.meters) AS meters, array_agg(DISTINCT sm.lot_id) AS lots, array_agg(DISTINCT l.quality) AS qualities
    FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id
    WHERE sm.dispatch_id = d.id AND sm.direction = 'OUT'
  ) m ON TRUE
  LEFT JOIN LATERAL (SELECT id, invoice_no FROM invoices WHERE dispatch_id = d.id AND status <> 'cancelled' ORDER BY id DESC LIMIT 1) inv ON TRUE
  LEFT JOIN LATERAL (SELECT status, GREATEST(created_at, updated_at) AS at, error FROM whatsapp_messages
                     WHERE dispatch_id = d.id AND purpose = 'dispatch' AND direction = 'out' ORDER BY id DESC LIMIT 1) wa ON TRUE`;

export type DispatchRow = Dispatch & { qualities: string[]; party_address: string | null; party_gstin: string | null; party_state: string | null; party_city: string | null };

function toDispatch(r: Record<string, unknown>, owner: boolean): DispatchRow {
  return {
    id: Number(r.id), order_id: r.order_id == null ? null : Number(r.order_id), party_id: r.party_id == null ? null : Number(r.party_id),
    party_name: (r.party_name as string) ?? null, challan_no: (r.challan_no as string) ?? null, transporter: (r.transporter as string) ?? null,
    lr_no: (r.lr_no as string) ?? null, vehicle_no: (r.vehicle_no as string) ?? null, packages: r.packages == null ? null : Number(r.packages),
    dispatched_at: new Date(String(r.dispatched_at)).toISOString(), meters: Math.round(Number(r.meters) * 100) / 100,
    lots: (r.lots as string[]) ?? [], qualities: (r.qualities as string[]) ?? [],
    // Invoices are owner-only.
    invoice_id: owner && r.invoice_id != null ? Number(r.invoice_id) : null, invoice_no: owner ? ((r.invoice_no as string) ?? null) : null,
    party_address: (r.party_address as string) ?? null, party_gstin: (r.party_gstin as string) ?? null,
    party_state: (r.party_state as string) ?? null, party_city: (r.party_city as string) ?? null,
    wa: r.wa_status ? { status: r.wa_status as NonNullable<Dispatch['wa']>['status'], at: new Date(String(r.wa_at)).toISOString(), error: (r.wa_error as string) ?? null } : null,
    party_has_phone: !!r.party_has_phone,
  };
}

export async function listDispatches(q: Q, f: { days?: number; party_id?: number | null; owner: boolean }): Promise<DispatchRow[]> {
  const days = Math.min(Math.max(Math.floor(f.days ?? 30), 1), 3650);
  const r = await q(
    `${LIST_SQL} WHERE d.dispatched_at >= NOW() - ($1::int * interval '1 day') AND ($2::int IS NULL OR d.party_id = $2)
     ORDER BY d.dispatched_at DESC, d.id DESC LIMIT 500`,
    [days, f.party_id ?? null],
  );
  return r.rows.map((x) => toDispatch(x, f.owner));
}

export async function getDispatch(q: Q, id: number, owner: boolean): Promise<{ dispatch: DispatchRow; lines: DispatchLine[] }> {
  if (!Number.isInteger(id) || id <= 0) throw new LedgerError('A valid dispatch id is required.');
  const r = await q(`${LIST_SQL} WHERE d.id = $1`, [id]);
  if (!r.rows[0]) throw new LedgerError(`Dispatch #${id} not found.`, 404);
  const l = await q(
    `SELECT sm.id AS movement_id, sm.lot_id, l.quality, l.design, sm.meters, sm.order_id
     FROM stock_movements sm JOIN lots l ON l.lot_id = sm.lot_id WHERE sm.dispatch_id = $1 AND sm.direction = 'OUT' ORDER BY sm.id`,
    [id],
  );
  return {
    dispatch: toDispatch(r.rows[0], owner),
    lines: l.rows.map((x) => ({ movement_id: Number(x.movement_id), lot_id: x.lot_id, quality: x.quality, design: x.design, meters: Number(x.meters), order_id: x.order_id == null ? null : Number(x.order_id) })),
  };
}

export interface DispatchInput {
  party?: unknown; order_id?: unknown; lines?: unknown; challan_no?: unknown; transporter?: unknown; lr_no?: unknown; vehicle_no?: unknown; packages?: unknown;
}

/** Validates and writes a dispatch + its OUT movements. Run inside a transaction. */
export async function createDispatch(q: Q, b: DispatchInput, actorRaw: string | null): Promise<{ id: number; challan_no: string }> {
  if (!Array.isArray(b.lines) || !b.lines.length) throw new LedgerError('Add at least one lot with meters.');
  if (b.lines.length > 200) throw new LedgerError('Too many lines in one dispatch (200 max).');
  const lines = b.lines.map((raw, i) => {
    const l = (raw ?? {}) as Record<string, unknown>;
    const lot = lotCode(l.lot_id, false);
    if (!lot) throw new LedgerError(`Line ${i + 1}: lot number is required.`);
    const meters = metersValue(l.meters, `Line ${i + 1} meters`);
    if (meters == null) throw new LedgerError(`Line ${i + 1}: meters are required.`);
    return { lot_id: lot, meters };
  });

  let order: { id: number; party_id: number; party_name: string; status: string } | null = null;
  if (b.order_id != null && b.order_id !== '') {
    const oid = Number(b.order_id);
    if (!Number.isInteger(oid) || oid <= 0) throw new LedgerError('Order id is not valid.');
    const o = await q(`SELECT o.id, o.party_id, o.status, p.name AS party_name FROM orders o JOIN parties p ON p.id = o.party_id WHERE o.id = $1 FOR UPDATE OF o`, [oid]);
    if (!o.rows[0]) throw new LedgerError(`Order #${oid} not found.`, 404);
    order = o.rows[0];
    if (order!.status === 'cancelled') throw new LedgerError(`Order #${oid} is cancelled.`);
  }

  const party = await partyByName(q, textOrNull(b.party, 150) ?? order?.party_name ?? null, true);
  if (!party) throw new LedgerError('Party (the client receiving the goods) is required.');
  if (order && order.party_id !== party.id) throw new LedgerError(`Order #${order.id} is for ${order.party_name}, not ${party.name}.`);

  // Stock reserved for other orders cannot be sent out on this dispatch (release it or dispatch against that order).
  {
    const own = order
      ? [order.id]
      : (await q(`SELECT id FROM orders WHERE party_id = $1 AND status IN ('open', 'partly_dispatched')`, [party.id])).rows.map((r) => Number(r.id));
    const perLot = new Map<string, number>();
    for (const l of lines) perLot.set(l.lot_id, (perLot.get(l.lot_id) ?? 0) + l.meters);
    for (const [lot, m] of perLot) {
      const st = await lotStock(q, lot);
      if (!st) continue; // recordOutgoing reports unknown lots
      const other = await reservedForOthers(q, lot, own);
      const free = Math.round((st.balance - other.meters) * 100) / 100;
      if (other.meters > 0 && m > free + 0.001) {
        throw new LedgerError(`Lot ${lot}: only ${Math.max(0, free)} m can go — ${other.meters} m is reserved for order ${other.orders.map((o) => `#${o}`).join(', ')}. Release it first or dispatch against that order.`, 409);
      }
    }
  }

  let challan = challanCode(b.challan_no);
  if (challan) {
    const dup = await q(`SELECT id FROM dispatches WHERE upper(challan_no) = $1 LIMIT 1`, [challan]);
    if (dup.rows[0]) throw new LedgerError(`Challan ${challan} is already used on dispatch #${dup.rows[0].id}.`, 409);
  }
  let packages: number | null = null;
  if (b.packages != null && b.packages !== '') {
    packages = Number(b.packages);
    if (!Number.isInteger(packages) || packages < 0 || packages > 100_000) throw new LedgerError('Packages must be a whole number.');
  }
  const vehicle = textOrNull(b.vehicle_no, 20)?.toUpperCase() ?? null;
  const actor = await validActor(q, actorRaw);

  const ins = await q(
    `INSERT INTO dispatches (order_id, party_id, challan_no, transporter, lr_no, vehicle_no, packages, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [order?.id ?? null, party.id, challan, textOrNull(b.transporter, 100), textOrNull(b.lr_no, 40), vehicle, packages, actor],
  );
  const id = Number(ins.rows[0].id);
  if (!challan) {
    // Our own delivery challan number when none was written.
    challan = `DC-${id}`;
    await q(`UPDATE dispatches SET challan_no = $2 WHERE id = $1`, [id, challan]);
  }
  for (const l of lines) {
    await recordOutgoing(q, { lot_id: l.lot_id, meters: l.meters, party: party.name, source_doc: challan, order_id: order?.id ?? null, dispatch_id: id, moved_by: actor });
  }
  // The hook may have linked the movements to one order: carry it onto the dispatch.
  if (!order) {
    const o = await q(`SELECT DISTINCT order_id FROM stock_movements WHERE dispatch_id = $1 AND order_id IS NOT NULL`, [id]);
    if (o.rows.length === 1) await q(`UPDATE dispatches SET order_id = $2 WHERE id = $1 AND order_id IS NULL`, [id, o.rows[0].order_id]);
  }
  return { id, challan_no: challan };
}
