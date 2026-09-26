import { NextRequest, NextResponse } from 'next/server';
import { withTransaction, type Q } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, getFirmConfig, invalidateSettings } from '@/lib/settings';

async function setSections(q: Q, userId: string, sections: unknown) {
  if (!Array.isArray(sections)) throw new LedgerError('sections must be a list of section ids.');
  const ids = [...new Set(sections.map((x) => Number(x)))];
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw new LedgerError('Invalid section id.');
  if (ids.length) {
    const found = await q(`SELECT count(*)::int AS n FROM sections WHERE id = ANY($1::int[])`, [ids]);
    if (found.rows[0].n !== ids.length) throw new LedgerError('One of the sections does not exist.');
  }
  await q(`DELETE FROM supervisor_sections WHERE user_id = $1`, [userId]);
  if (ids.length) await q(`INSERT INTO supervisor_sections (user_id, section_id) SELECT $1, unnest($2::int[])`, [userId, ids]);
}

// POST: add a supervisor { name, sections: number[] }
export async function POST(request: NextRequest) {
  try {
    const b = await request.json();
    const name = cleanName(b.name, 'Name');
    await withTransaction(async (q) => {
      const id = `usr-sup-${Date.now().toString(36)}`;
      await q(`INSERT INTO users (id, name, role, locale, active) VALUES ($1, $2, 'supervisor', 'en', true)`, [id, name]);
      await setSections(q, id, b.sections ?? []);
    });
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH: update the owner or a supervisor { id, name?, active?, sections? }
export async function PATCH(request: NextRequest) {
  try {
    const b = await request.json();
    const id = typeof b.id === 'string' ? b.id : '';
    await withTransaction(async (q) => {
      const u = await q(`SELECT role FROM users WHERE id = $1 FOR UPDATE`, [id]);
      if (!u.rowCount) throw new LedgerError('User not found.', 404);
      const role = u.rows[0].role;
      if (role !== 'owner' && role !== 'supervisor') throw new LedgerError('Only the owner and supervisors are managed here.');
      if ('name' in b) await q(`UPDATE users SET name = $1 WHERE id = $2`, [cleanName(b.name, 'Name'), id]);
      if ('active' in b) {
        if (role === 'owner') throw new LedgerError('The owner cannot be deactivated.');
        await q(`UPDATE users SET active = $1 WHERE id = $2`, [!!b.active, id]);
      }
      if ('sections' in b) {
        if (role !== 'supervisor') throw new LedgerError('Only supervisors have sections.');
        await setSections(q, id, b.sections);
      }
    });
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
