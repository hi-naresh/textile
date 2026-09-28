import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireDeveloper } from '@/lib/apiAuth';
import { connections, systemStatus } from '@/lib/health';
import { AUTH } from '@/lib/auth/config';

const TABLES = ['users', 'workers', 'lots', 'capture_events', 'stock_movements', 'job_cards', 'orders', 'invoices', 'auth_sessions', 'auth_audit', 'app_errors', 'llm_usage'];

// Developer only. GET ?recheck=1 → services (AI, OCR, photo storage), database, migrations, settings present.
export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const services = await systemStatus(req.nextUrl.searchParams.get('recheck') === '1');
    let database: Record<string, unknown>;
    try {
      const [now, migrations] = await Promise.all([
        query(`SELECT now() AS now, current_setting('server_version') AS version`),
        query(`SELECT name, applied_at FROM schema_migrations ORDER BY name`),
      ]);
      const counts: Record<string, number | null> = {};
      for (const t of TABLES) {
        try { counts[t] = Number((await query(`SELECT count(*)::bigint AS n FROM ${t}`)).rows[0].n); } catch { counts[t] = null; }
      }
      database = { ok: true, time: now.rows[0].now, version: now.rows[0].version, migrations: migrations.rows, counts };
    } catch (err) {
      database = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return NextResponse.json(
      {
        services, database, connections: connections(),
        runtime: { node: process.version, vercel: !!process.env.VERCEL, region: process.env.VERCEL_REGION ?? null, commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null },
        auth: { accessMinutes: AUTH.accessMinutes, clientSessionDays: AUTH.clientSessionDays, developerSessionHours: AUTH.developerSessionHours, viewAsWrite: AUTH.viewAsWrite },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
