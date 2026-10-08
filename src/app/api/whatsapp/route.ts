import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { readObject, requireCap } from '@/lib/apiAuth';
import { respond } from '@/lib/money/http';
import { showNumber, waConnected, waNumber } from '@/lib/whatsapp/config';
import { readWaSettings, REMINDER_GAP_DAYS, updateOwnerSettings, type WaSettings } from '@/lib/whatsapp/settings';

// Owner: My firm → Policy → WhatsApp.
// GET → { connected, settings, owner_phone, gap_days, incoming: last replies from parties }
// PUT { auto_reminders?, reminder_days?, dispatch_messages?, morning_summary?, summary_extra?: string[] } → same as GET
async function view(s: WaSettings) {
  const [owner, inc] = await Promise.all([
    query(`SELECT phone FROM users WHERE role = 'owner' AND deleted_at IS NULL ORDER BY id LIMIT 1`),
    query(`SELECT m.id, m.phone, m.body, m.params->>'name' AS name, p.name AS party_name, m.created_at
           FROM whatsapp_messages m LEFT JOIN parties p ON p.id = m.party_id
           WHERE m.direction = 'in' ORDER BY m.id DESC LIMIT 5`).catch(() => ({ rows: [] as Record<string, unknown>[] })),
  ]);
  const op = owner.rows[0]?.phone ?? null;
  return {
    connected: waConnected(),
    settings: { auto_reminders: s.auto_reminders, reminder_days: s.reminder_days, dispatch_messages: s.dispatch_messages, morning_summary: s.morning_summary, summary_extra: s.summary_extra },
    owner_phone: waNumber(op ?? '') ? showNumber(waNumber(op)) : null,
    gap_days: REMINDER_GAP_DAYS,
    incoming: inc.rows.map((r) => ({ id: Number(r.id), from: showNumber(String(r.phone)), name: (r.party_name ?? r.name ?? null) as string | null, body: String(r.body ?? ''), at: new Date(String(r.created_at)).toISOString() })),
  };
}

export async function GET(req: NextRequest) {
  return respond(async () => {
    await requireCap(req, 'settings.manage');
    return view(await readWaSettings());
  });
}

export async function PUT(req: NextRequest) {
  return respond(async () => {
    const a = await requireCap(req, 'settings.manage');
    const b = await readObject(req);
    return view(await updateOwnerSettings(b, a.by));
  });
}
