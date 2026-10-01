import { NextRequest, NextResponse } from 'next/server';
import { readdir } from 'fs/promises';
import path from 'path';
import { query } from '@/lib/db';
import { errorResponseBody } from '@/lib/ledger';
import { requireDeveloper } from '@/lib/apiAuth';
import { APIS, ENV_VARS } from '@/lib/docs/catalog';

// Developer only. GET → the live parts of the Docs tab (the rest is src/lib/docs/catalog.ts, bundled with the page):
//   migrations: applied (schema_migrations) · env: name → set / not set (never the value)
//   routes: API routes found on disk (local / self-hosted only; null on Vercel, where the source isn't deployed),
//           with the ones missing from the catalog and the documented ones no longer on disk.
async function routesOnDisk(): Promise<string[] | null> {
  const root = path.join(process.cwd(), 'src', 'app', 'api');
  const out: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else if (e.name === 'route.ts' || e.name === 'route.js') out.push(`/api${rel}`);
    }
  }
  try {
    await walk(root, '');
    return out.sort();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireDeveloper(req);
    const [mig, routes] = await Promise.all([
      query(`SELECT name, applied_at FROM schema_migrations ORDER BY name`).catch(() => ({ rows: [] as Record<string, unknown>[] })),
      routesOnDisk(),
    ]);
    const env = ENV_VARS.map((v) => ({
      name: v.name,
      set: v.name.split(' / ').some((n) => !!process.env[n.trim()]),
    }));
    const documented = new Set(APIS.map((a) => a.path));
    return NextResponse.json(
      {
        migrations: mig.rows,
        env,
        routes: routes && {
          found: routes.length,
          undocumented: routes.filter((r) => !documented.has(r)),
          missing: [...documented].filter((p) => !routes.includes(p)),
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
