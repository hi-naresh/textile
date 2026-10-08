// whatsapp_settings (one row): the owner's switches and the developer's template names / language.
import { query, type Q } from '../db';
import { LedgerError } from '../ledger-error';
import { normalizePhone } from '../auth/phone';
import type { TemplateKey } from './templates';

const run: Q = (text, params) => query(text, params as never[]);

export interface WaSettings {
  auto_reminders: boolean; reminder_days: number; dispatch_messages: boolean; morning_summary: boolean; summary_extra: string[];
  lang: string; templates: Record<TemplateKey, string>; updated_at: string | null; updated_by: string | null;
}

export const DEFAULT_SETTINGS: WaSettings = {
  auto_reminders: false, reminder_days: 7, dispatch_messages: false, morning_summary: false, summary_extra: [], lang: 'en',
  templates: { reminder: 'payment_reminder', dispatch: 'dispatch_update', summary: 'daily_summary' }, updated_at: null, updated_by: null,
};

/** Reminders to one party: at most once in this many days (unless the owner sends again on purpose). */
export const REMINDER_GAP_DAYS = 7;
export const MAX_EXTRA_NUMBERS = 5;

export async function readWaSettings(q: Q = run): Promise<WaSettings> {
  let r;
  try { r = await q(`SELECT * FROM whatsapp_settings WHERE id = 1`); } catch { return DEFAULT_SETTINGS; } // before migration 012
  const s = r.rows[0];
  if (!s) return DEFAULT_SETTINGS;
  return {
    auto_reminders: !!s.auto_reminders, reminder_days: Number(s.reminder_days), dispatch_messages: !!s.dispatch_messages,
    morning_summary: !!s.morning_summary, summary_extra: s.summary_extra ?? [], lang: s.lang,
    templates: { reminder: s.tpl_reminder, dispatch: s.tpl_dispatch, summary: s.tpl_summary },
    updated_at: s.updated_at ? new Date(s.updated_at).toISOString() : null, updated_by: s.updated_by ?? null,
  };
}

const bool = (v: unknown, label: string) => {
  if (typeof v !== 'boolean') throw new LedgerError(`${label} must be on or off.`);
  return v;
};

/** Owner switches (My firm → Policy → WhatsApp). Unknown fields are ignored. */
export async function updateOwnerSettings(b: Record<string, unknown>, by: string): Promise<WaSettings> {
  const set: Record<string, unknown> = {};
  if ('auto_reminders' in b) set.auto_reminders = bool(b.auto_reminders, 'Auto reminders');
  if ('dispatch_messages' in b) set.dispatch_messages = bool(b.dispatch_messages, 'Dispatch messages');
  if ('morning_summary' in b) set.morning_summary = bool(b.morning_summary, 'Morning summary');
  if ('reminder_days' in b) {
    const n = Number(b.reminder_days);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new LedgerError('Days overdue must be a whole number from 1 to 365.');
    set.reminder_days = n;
  }
  if ('summary_extra' in b) {
    const raw = Array.isArray(b.summary_extra) ? b.summary_extra : typeof b.summary_extra === 'string' ? b.summary_extra.split(/[,;\n]+/) : null;
    if (!raw) throw new LedgerError('Extra numbers must be a list.');
    const list: string[] = [];
    for (const x of raw) {
      if (typeof x !== 'string' || !x.trim()) continue;
      const p = normalizePhone(x);
      if (!p) throw new LedgerError(`"${x.trim().slice(0, 20)}" is not a 10-digit mobile number.`);
      if (!list.includes(p)) list.push(p);
    }
    if (list.length > MAX_EXTRA_NUMBERS) throw new LedgerError(`At most ${MAX_EXTRA_NUMBERS} extra numbers.`);
    set.summary_extra = list;
  }
  return save(set, by);
}

/** Developer: template names + language (developer console → WhatsApp). */
export async function updateTemplateSettings(b: Record<string, unknown>, by: string): Promise<WaSettings> {
  const set: Record<string, unknown> = {};
  const name = (v: unknown, label: string) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!/^[a-z0-9_]{1,100}$/.test(s)) throw new LedgerError(`${label}: use lowercase letters, numbers and _ only (as in WhatsApp Manager).`);
    return s;
  };
  if ('tpl_reminder' in b) set.tpl_reminder = name(b.tpl_reminder, 'Reminder template');
  if ('tpl_dispatch' in b) set.tpl_dispatch = name(b.tpl_dispatch, 'Dispatch template');
  if ('tpl_summary' in b) set.tpl_summary = name(b.tpl_summary, 'Summary template');
  if ('lang' in b) {
    const l = typeof b.lang === 'string' ? b.lang.trim() : '';
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(l)) throw new LedgerError('Language code like en, en_US or hi.');
    set.lang = l;
  }
  return save(set, by);
}

async function save(set: Record<string, unknown>, by: string): Promise<WaSettings> {
  const keys = Object.keys(set);
  if (!keys.length) throw new LedgerError('Nothing to change.');
  const cols = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await run(`INSERT INTO whatsapp_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  // Column names come from the fixed lists above, never from the request.
  await run(`UPDATE whatsapp_settings SET ${cols}, updated_at = now(), updated_by = $${keys.length + 1} WHERE id = 1`, [...keys.map((k) => set[k]), by.slice(0, 80)]);
  return readWaSettings();
}
