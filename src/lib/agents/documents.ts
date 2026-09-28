// Document Generation agent. PDFs are made on request (/api/docs/*); this scan reminds the owner
// about dispatches that went out more than a day ago without an invoice, and creates it on accept.
import { LedgerError } from '../ledger-error';
import { createInvoiceForDispatch } from '../dispatch/invoices';
import type { AgentModule } from './types';
import { resolveMissing, suggest } from './suggest';

export const agent: AgentModule = {
  async scan(q) {
    const r = await q(
      `SELECT d.id, d.challan_no, to_char(d.dispatched_at, 'DD Mon') AS day, p.name AS party,
              (SELECT SUM(meters) FROM stock_movements sm WHERE sm.dispatch_id = d.id AND sm.direction = 'OUT') AS meters
       FROM dispatches d JOIN parties p ON p.id = d.party_id
       WHERE d.dispatched_at < NOW() - interval '1 day'
         AND EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.dispatch_id = d.id AND sm.direction = 'OUT')
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.dispatch_id = d.id AND i.status <> 'cancelled')
       ORDER BY d.dispatched_at LIMIT 200`,
    );
    const keys: string[] = [];
    for (const d of r.rows) {
      const key = `invoice_missing:${d.id}`;
      keys.push(key);
      await suggest(q, {
        agent: 'documents', kind: 'invoice_missing', severity: 'info', ownerOnly: true,
        title: `No invoice for challan ${d.challan_no ?? `#${d.id}`} to ${d.party}`,
        detail: `Dispatched ${d.day} · ${Number(d.meters).toLocaleString('en-IN', { maximumFractionDigits: 1 })} m. Create the GST invoice, or record the Tally invoice number.`,
        payload: { dispatch_id: Number(d.id) },
        target: { type: 'dispatch', id: Number(d.id) },
        actionLabel: 'Create invoice',
        dedupeKey: key,
      });
    }
    await resolveMissing(q, 'documents', 'invoice_missing', keys);
  },

  async accept(s, q, actor) {
    if (s.kind !== 'invoice_missing') throw new LedgerError('Nothing to do for this one — dismiss it instead.');
    const dispatchId = Number(s.payload?.dispatch_id);
    const { invoice } = await createInvoiceForDispatch(q, dispatchId, { actor });
    return `Invoice ${invoice.invoice_no} created`;
  },
};
