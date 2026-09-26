// Shared client-side types for API responses

export interface Lot {
  lot_id: string;
  quality: string;
  design: string;
  grade: string;
  status: string;
  balance: number;
  location: string | null; // current physical location (latest lot_locations row)
  location_stage: LocationStage | null;
  location_ts: string | null;
}

export type LocationStage = 'arrival' | 'job_card' | 'returned' | 'dispatch' | 'moved';

export interface LotLocationEntry {
  id: number;
  lot_id: string;
  location: string;
  stage: LocationStage;
  note: string | null;
  job_card_id: number | null;
  stock_movement_id: number | null;
  moved_by_name: string | null;
  ts: string;
}

export interface KnownNames {
  mills: string[];
  weavers: string[];
  parties: string[];
}

export interface LedgerEntry {
  id: number;
  lot_id: string;
  direction: 'IN' | 'OUT';
  meters: number; // stock quantity (IN: finished if known, else grey)
  grey_meters: number | null; // IN only
  finished_meters: number | null; // IN only
  mill_name: string | null; // IN only
  weaver_name: string | null; // IN only
  party: string | null; // OUT only: destination client (older IN rows may hold a legacy supplier)
  source_doc_id: string | null;
  capture_event_id: number | null;
  ts: string;
  quality?: string;
  design?: string;
}

export interface FlowDay {
  day: string; // YYYY-MM-DD
  in_m: number;
  out_m: number;
}

export interface JobCard {
  id: number;
  lot_id: string;
  process: string;
  worker_id: string;
  worker_name: string;
  worker_section: string;
  meters_in: number;
  meters_out: number | null;
  shortage: number | null;
  shortage_pct: number;
  status: 'open' | 'in-process' | 'folded' | 'closed';
  ts_created: string;
  ts_closed: string | null;
  quality: string;
  design: string;
  flagged: boolean;
}

export interface Allotment {
  id: number;
  worker_id: string;
  worker_name: string;
  job_card_id: number;
  meters_allotted: number;
  shift: string;
  date: string;
  date_str?: string;
  is_today?: boolean;
  process: string;
  lot_id: string;
}

export interface Worker {
  id: string;
  name: string;
  section: string;
  role: string;
}

export interface EfficiencyRecord {
  id: number;
  worker_id: string;
  name: string;
  section: string;
  date: string;
  date_str?: string;
  allotted: number;
  done: number;
  efficiency_pct: number;
  flagged: boolean;
}

export interface CctvActivity {
  id: number;
  worker_id: string;
  name: string;
  station: string;
  active_pct: number;
  idle_min: number;
  ts: string;
}

export type CaptureType = 'incoming_stock' | 'outgoing_stock' | 'job_card_folding';

export interface CaptureEvent {
  id: number;
  photo_url: string;
  type: CaptureType;
  ai_json: Record<string, unknown> | null;
  confidence: number;
  status: 'pending' | 'confirmed' | 'corrected' | 'rejected';
  confirmed_by: string | null;
  confirmed_by_name: string | null;
  ts: string;
}

export interface ChatMessage {
  sender: 'user' | 'bot';
  text: string;
  sql?: string;
  rows?: Record<string, unknown>[];
  timestamp: Date;
  loading?: boolean;
  error?: boolean;
}

export type ToastTone = 'success' | 'danger' | 'warning';
export interface Toast {
  text: string;
  tone: ToastTone;
}
