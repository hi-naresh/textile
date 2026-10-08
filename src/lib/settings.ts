// Server-side reader/writer for per-firm settings (see src/lib/config.ts for the shape).
import { query, type Q } from './db';
import { DEFAULT_RULES, LIMITS, type AccessOff, type FirmConfig, type FirmRules } from './config';
import { MATRIX, setAccessOff } from './access';
import { LedgerError } from './ledger';
import { loadMarkets } from './markets';

const run: Q = (text, params) => query(text, params as never[]);

let cache: { at: number; config: FirmConfig } | null = null;
const TTL_MS = 30_000;

export function invalidateSettings() { cache = null; }

export async function readRules(q: Q = run): Promise<FirmRules> {
  const r = await q(`SELECT * FROM app_settings WHERE id = 1`);
  const row = r.rows[0];
  if (!row) return DEFAULT_RULES;
  return {
    shortageLimitPct: parseFloat(row.shortage_limit_pct),
    efficiencyTargetPct: parseFloat(row.efficiency_target_pct),
    aiAutoConfirmPct: parseFloat(row.ai_auto_confirm_pct),
    manualChallanMin: parseFloat(row.manual_challan_min ?? DEFAULT_RULES.manualChallanMin),
    manualJobCardMin: parseFloat(row.manual_job_card_min ?? DEFAULT_RULES.manualJobCardMin),
  };
}

/** app_settings.access_overrides → only known capabilities, only for supervisor / worker. */
export function cleanAccessOff(raw: unknown): AccessOff {
  const out: AccessOff = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const role of ['supervisor', 'worker'] as const) {
    const list = (raw as Record<string, unknown>)[role];
    if (Array.isArray(list)) out[role] = [...new Set(list.filter((c): c is string => typeof c === 'string' && MATRIX.some((m) => m.cap === c)))];
  }
  return out;
}

export async function getFirmConfig(fresh = false): Promise<FirmConfig> {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.config;
  const [settings, owner, sups, secs, markets] = await Promise.all([
    run(`SELECT * FROM app_settings WHERE id = 1`),
    run(`SELECT id, name FROM users WHERE role = 'owner' AND deleted_at IS NULL ORDER BY id LIMIT 1`),
    run(`SELECT u.id, u.name, u.active,
                COALESCE(array_agg(s.name ORDER BY s.sort_order, s.name) FILTER (WHERE s.id IS NOT NULL AND s.active), '{}') AS sections
         FROM users u
         LEFT JOIN supervisor_sections ss ON ss.user_id = u.id
         LEFT JOIN sections s ON s.id = ss.section_id
         WHERE u.role = 'supervisor' AND u.deleted_at IS NULL
         GROUP BY u.id, u.name, u.active
         ORDER BY u.active DESC, u.name`),
    run(`SELECT id, name, active FROM sections ORDER BY sort_order, name`),
    loadMarkets(run),
  ]);
  const st = settings.rows[0] ?? {};
  const config: FirmConfig = {
    firm: { name: st.firm_name ?? 'Your firm', city: st.firm_city ?? '' },
    owner: owner.rows[0] ? { id: owner.rows[0].id, name: owner.rows[0].name } : { id: 'usr-owner', name: 'Owner' },
    supervisors: sups.rows.map((r) => ({ id: r.id, name: r.name, active: r.active, sections: r.sections })),
    sections: secs.rows.map((r) => ({ id: r.id, name: r.name, active: r.active })),
    rules: {
      shortageLimitPct: parseFloat(st.shortage_limit_pct ?? DEFAULT_RULES.shortageLimitPct),
      efficiencyTargetPct: parseFloat(st.efficiency_target_pct ?? DEFAULT_RULES.efficiencyTargetPct),
      aiAutoConfirmPct: parseFloat(st.ai_auto_confirm_pct ?? DEFAULT_RULES.aiAutoConfirmPct),
      manualChallanMin: parseFloat(st.manual_challan_min ?? DEFAULT_RULES.manualChallanMin),
      manualJobCardMin: parseFloat(st.manual_job_card_min ?? DEFAULT_RULES.manualJobCardMin),
    },
    markets,
    accessOff: cleanAccessOff(st.access_overrides),
  };
  setAccessOff(config.accessOff ?? {});
  cache = { at: Date.now(), config };
  return config;
}

// ---------- validation helpers ----------
export function cleanName(v: unknown, label: string, max: number = LIMITS.nameMax): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new LedgerError(`${label} is required.`);
  if (s.length > max) throw new LedgerError(`${label} must be ${max} characters or fewer.`);
  return s;
}

export function pct(v: unknown, label: string, range: { min: number; max: number }): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n) || n < range.min || n > range.max) throw new LedgerError(`${label} must be between ${range.min} and ${range.max}.`);
  return Math.round(n * 100) / 100;
}

/** "Folding Section" / " folding " → "Folding" style match key */
export const sectionKey = (s: string) => s.replace(/\s*section\s*$/i, '').trim().toLowerCase();
