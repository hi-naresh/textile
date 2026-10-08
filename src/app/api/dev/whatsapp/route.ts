import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { readObject, requireDeveloper } from '@/lib/apiAuth';
import { audit } from '@/lib/auth/audit';
import { showNumber, waConnected, waEnv, waEnvStatus } from '@/lib/whatsapp/config';
import { phoneInfo, explain } from '@/lib/whatsapp/client';
import { readWaSettings, updateTemplateSettings } from '@/lib/whatsapp/settings';
import { runWhatsAppDaily } from '@/lib/whatsapp/flows';

// Developer console → WhatsApp.
// GET ?check=1&purpose=&status=&days=14 → { connected, env (names + set / not set), version, base_default, webhook_url,
//     verify_token: { set, length }, settings, check?: phone number info or error, log: last 200 messages, by_day }
// PUT { tpl_reminder?, tpl_dispatch?, tpl_summary?, lang? } → template names / language as created in WhatsApp Manager.
// POST { action: 'run_daily' } → run the daily WhatsApp job now (morning summary + auto reminders; each sent once per day).
const PURPOSES = ['reminder', 'dispatch', 'summary', 'test', 'incoming'];
const STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'received'];

function publicOrigin(req: NextRequest): string {
  const h = req.headers;
  const host = h.get('x-forwarded-host') ?? h.get('host');
  const proto = h.get('x-forwarded-proto') ?? req.nextUrl.protocol.replace(':', '');
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const sp = req.nextUrl.searchParams;
    const purpose = PURPOSES.includes(sp.get('purpose') ?? '') ? sp.get('purpose') : null;
    const status = STATUSES.includes(sp.get('status') ?? '') ? sp.get('status') : null;
    const days = Math.min(Math.max(Number(sp.get('days')) || 14, 1), 90);
    const e = waEnv();
    const [settings, log, byDay] = await Promise.all([
      readWaSettings(),
      query(
        `SELECT m.id, m.direction, m.purpose, m.phone, m.template, m.lang, m.params, m.body, m.status, m.error, m.error_code, m.wa_id,
                m.sent_by, m.created_at, m.sent_at, m.delivered_at, m.read_at, m.failed_at, m.party_id, p.name AS party_name,
                m.dispatch_id, d.challan_no, COALESCE(u.name, m.sent_by) AS sent_by_name
         FROM whatsapp_messages m
         LEFT JOIN parties p ON p.id = m.party_id
         LEFT JOIN dispatches d ON d.id = m.dispatch_id
         LEFT JOIN users u ON u.id = m.sent_by
         WHERE ($1::text IS NULL OR m.purpose = $1) AND ($2::text IS NULL OR m.status = $2) AND m.created_at > now() - ($3::int * interval '1 day')
         ORDER BY m.id DESC LIMIT 200`,
        [purpose, status, days],
      ),
      query(
        `SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE direction = 'out')::int AS out,
                count(*) FILTER (WHERE direction = 'out' AND status IN ('delivered', 'read'))::int AS delivered,
                count(*) FILTER (WHERE status = 'read')::int AS read,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE direction = 'in')::int AS incoming
         FROM whatsapp_messages WHERE created_at > now() - ($1::int * interval '1 day') GROUP BY 1 ORDER BY 1 DESC`,
        [days],
      ),
    ]);
    let check: Record<string, unknown> | null = null;
    if (sp.get('check') === '1') {
      if (!waConnected()) check = { ok: false, error: 'Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID first.' };
      else {
        const r = await phoneInfo();
        check = r.ok ? { ok: true, ...r.data } : { ok: false, error: explain(r.error), http: r.error.http };
      }
    }
    return NextResponse.json({
      connected: waConnected(),
      env: waEnvStatus(),
      version: e.version,
      base_default: e.base === 'https://graph.facebook.com',
      base: e.base,
      webhook_url: `${publicOrigin(req)}/api/whatsapp/webhook`,
      verify_token: { set: !!e.verifyToken, length: e.verifyToken.length },
      app_secret_set: !!e.appSecret,
      settings,
      check,
      log: log.rows.map((r) => ({ ...r, phone_shown: showNumber(String(r.phone)) })),
      by_day: byDay.rows,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    const b = await readObject(req);
    const settings = await updateTemplateSettings(b, s.user.email ?? s.user.id);
    await audit(query, { event: 'whatsapp.settings', actorId: s.user.id, sessionId: s.id, req, detail: b });
    return NextResponse.json({ settings, message: 'Template settings saved.' });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

export async function POST(req: NextRequest) {
  try {
    const s = await requireDeveloper(req);
    const b = await readObject(req);
    if (b.action !== 'run_daily') throw new LedgerError('Unknown action.');
    const result = await runWhatsAppDaily();
    await audit(query, { event: 'whatsapp.run', actorId: s.user.id, sessionId: s.id, req, detail: { result } });
    return NextResponse.json({ result, message: 'Daily WhatsApp job ran.' });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
