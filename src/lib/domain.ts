// Row shapes for Phase 2 data (as returned by the APIs; numbers already parsed).
export interface Party {
  id: number; name: string; phone: string | null; gstin: string | null; address: string | null; city: string | null;
  state_code: string | null; credit_limit: number | null; credit_days: number; active: boolean;
}
export interface Inquiry {
  id: number; party_id: number | null; party_name: string | null; source: 'whatsapp' | 'phone' | 'visit' | 'other';
  raw_text: string; parsed: Record<string, unknown> | null; quality: string | null; meters: number | null;
  target_rate: number | null; needed_by: string | null; quoted_rate: number | null; reply_draft: string | null;
  status: 'new' | 'quoted' | 'won' | 'lost'; order_id: number | null; created_at: string;
}
export interface Order {
  id: number; party_id: number; party_name: string; quality: string; design: string | null; meters: number;
  rate_per_m: number | null; promise_date: string | null; status: 'open' | 'partly_dispatched' | 'dispatched' | 'cancelled';
  allocated_m: number; dispatched_m: number; inquiry_id: number | null; notes: string | null; created_at: string;
}
export interface Allocation {
  id: number; order_id: number; lot_id: string; meters: number; dispatched_m: number; status: 'reserved' | 'released' | 'dispatched'; created_at: string;
}
export interface Dispatch {
  id: number; order_id: number | null; party_id: number | null; party_name: string | null; challan_no: string | null;
  transporter: string | null; lr_no: string | null; vehicle_no: string | null; packages: number | null; dispatched_at: string;
  meters: number; lots: string[]; invoice_id: number | null; invoice_no: string | null;
  /** Last WhatsApp dispatch message to the party (null = none sent) and whether the party has a mobile number. */
  wa?: { status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed'; at: string; error: string | null } | null;
  party_has_phone?: boolean;
}
export interface InvoiceLine { lot_id: string; quality: string; hsn: string; meters: number; rate: number; amount: number }
export interface Invoice {
  id: number; invoice_no: string; party_id: number; party_name: string; dispatch_id: number | null; order_id: number | null;
  invoice_date: string; due_date: string; taxable_amount: number; cgst: number; sgst: number; igst: number; total: number;
  lines: InvoiceLine[]; status: 'open' | 'part_paid' | 'paid' | 'cancelled'; source: 'app' | 'tally'; paid: number; balance: number;
}
export interface Payment {
  id: number; party_id: number; party_name: string; invoice_id: number | null; amount: number; paid_on: string;
  mode: 'cash' | 'bank' | 'upi' | 'cheque' | 'other'; reference: string | null;
}
