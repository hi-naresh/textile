// Document Generation agent. PDFs are made on request (/api/docs/*); this scan reminds the owner about
// dispatches that went out more than a day ago without an invoice, and makes the invoice on accept when
// every line has a rate on its order (there is no rate list any more).
import { LedgerError } from '../ledger-error';
import { createInvoiceForDispatch } from '../dispatch/invoices';
import { rupees } from '../money/validate';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';

export const agent: AgentModule = {
  async scan(q) {
    // Selling-rate lists are off: a one-tap invoice is only possible when every line's order has a rate.
    const r = await q(
      `SELECT d.id, d.challan_no, to_char(d.dispatched_at, 'DD Mon') AS day, p.name AS party,
              SUM(sm.meters) AS meters,
              bool_and(o.rate_per_m IS NOT NULL AND o.rate_per_m > 0) AS priced,
              MIN(o.rate_per_m) AS rate_min, MAX(o.rate_per_m) AS rate_max
       FROM dispatches d JOIN parties p ON p.id = d.party_id
       JOIN stock_movements sm ON sm.dispatch_id = d.id AND sm.direction = 'OUT'
       LEFT JOIN orders o ON o.id = COALESCE(sm.order_id, d.order_id)
       WHERE d.dispatched_at < NOW() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.dispatch_id = d.id AND i.status <> 'cancelled')
       GROUP BY d.id, d.challan_no, d.dispatched_at, p.name
       ORDER BY d.dispatched_at LIMIT 200`,
    );
    const keys: string[] = [];
    for (const d of r.rows) {
      const key = `invoice_missing:${d.id}`;
      keys.push(key);
      const m = Number(d.meters).toLocaleString('en-IN', { maximumFractionDigits: 1 });
      const priced = !!d.priced;
      const rate = priced ? (Number(d.rate_min) === Number(d.rate_max) ? `${rupees(Number(d.rate_min))}/m` : `${rupees(Number(d.rate_min))}–${rupees(Number(d.rate_max))}/m`) : null;
      await suggest(q, {
        agent: 'documents', kind: 'invoice_missing', severity: 'info', ownerOnly: true,
        title: `Challan ${d.challan_no ?? `#${d.id}`} to ${d.party} (${m} m, ${d.day}) has no invoice yet`,
        detail: 'Until it is invoiced the party is not billed: it doesn\'t show in Money → Outstanding and no reminder can be sent for it.',
        hint: priced
          ? `"Make invoice" creates the GST invoice at the order's rate (${rate}); print it from Dispatch → Invoices. If you bill in Tally, dismiss this and record the Tally bill no. instead.`
          : 'No rate on the order yet — open the dispatch, type the ₹/m rate and make the invoice, or record the Tally bill no.',
        payload: { dispatch_id: Number(d.id) },
        target: { type: 'dispatch', id: Number(d.id) },
        actionLabel: priced ? 'Make invoice' : null,
        dedupeKey: key,
      });
    }
    await resolveMissing(q, 'documents', 'invoice_missing', keys);
  },

  async accept(s, q, actor) {
    if (s.kind !== 'invoice_missing') throw new LedgerError('Nothing to do for this one — dismiss it instead.');
    const dispatchId = Number(s.payload?.dispatch_id);
    const { invoice } = await createInvoiceForDispatch(q, dispatchId, { actor });
    return `Invoice ${invoice.invoice_no} made (${rupees(Number(invoice.total))}) — print it from Dispatch → Invoices`;
  },
};
