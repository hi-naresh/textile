// Shared contracts for the Phase 2 agents. See docs/AGENTS_PHASE2.md.
// An "agent" is deterministic code first: a scan that raises alerts / suggestions, optional
// event hooks, and an accept handler for its one-tap suggested actions. LLM use is limited to
// reading free text (inquiries) and phrasing drafts, always on the low tier and logged.
import type { Q } from '../db';

export type AgentKey =
  | 'inquiry' | 'orders' | 'allocation' | 'inventory' | 'logistics'
  | 'documents' | 'costing' | 'reports' | 'credit';

export type Severity = 'info' | 'warn' | 'bad';

export interface SuggestionInput {
  agent: AgentKey;
  kind: string; // e.g. 'allocate_order', 'low_stock', 'overdue'
  severity?: Severity;
  title: string; // one line, plain English, shown in "Needs your attention"
  detail?: string | null;
  payload?: Record<string, unknown> | null; // what accept() needs
  target?: { type: string; id: string | number } | null; // e.g. { type: 'order', id: 41 } — screens link to it
  actionLabel?: string | null; // set when accept() can act on it ("Allocate", "Send reminder")
  ownerOnly?: boolean; // money-related → never shown to supervisors
  dedupeKey: string; // stable per real-world problem, e.g. `low_stock:Georgette`
}

export interface Suggestion {
  id: number;
  agent: AgentKey;
  kind: string;
  severity: Severity;
  title: string;
  detail: string | null;
  payload: Record<string, unknown> | null;
  target_type: string | null;
  target_id: string | null;
  action_label: string | null;
  owner_only: boolean;
  created_at: string;
}

export interface AgentModule {
  /** Periodic check (throttled, runs in its own transaction). Raise/resolve suggestions via suggest.ts. */
  scan?: (q: Q) => Promise<void>;
  /** One-tap accept of a suggestion. Returns a short confirmation for the toast. Throw LedgerError for user errors. */
  accept?: (s: Suggestion, q: Q, actor: string | null) => Promise<string>;
}
