import { NextRequest, NextResponse } from 'next/server';
import { withTransaction } from '@/lib/db';
import { errorResponseBody, LedgerError } from '@/lib/ledger';
import { cleanName, getFirmConfig, invalidateSettings, sectionKey } from '@/lib/settings';

// POST: add a section { name }
export async function POST(request: NextRequest) {
  try {
    const b = await request.json();
    const name = cleanName(b.name, 'Section name', 60);
    await withTransaction(async (q) => {
      const dup = await q(`SELECT 1 FROM sections WHERE lower(name) = lower($1)`, [name]);
      if (dup.rowCount) throw new LedgerError(`Section "${name}" already exists.`);
      await q(`INSERT INTO sections (name, sort_order) VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM sections))`, [name]);
    });
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

// PATCH: rename or (de)activate a section { id, name?, active? }
// Renaming also updates workers and job cards that use the old name, so history stays grouped.
export async function PATCH(request: NextRequest) {
  try {
    const b = await request.json();
    const id = Number(b.id);
    await withTransaction(async (q) => {
      const cur = await q(`SELECT name FROM sections WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rowCount) throw new LedgerError('Section not found.', 404);
      const oldName: string = cur.rows[0].name;
      if ('name' in b) {
        const name = cleanName(b.name, 'Section name', 60);
        if (name !== oldName) {
          const dup = await q(`SELECT 1 FROM sections WHERE lower(name) = lower($1) AND id <> $2`, [name, id]);
          if (dup.rowCount) throw new LedgerError(`Section "${name}" already exists.`);
          await q(`UPDATE sections SET name = $1 WHERE id = $2`, [name, id]);
          const key = sectionKey(oldName);
          await q(`UPDATE workers SET section = $1 WHERE lower(btrim(regexp_replace(section, '\\s*section\\s*$', '', 'i'))) = $2`, [name, key]);
          await q(`UPDATE job_cards SET process = $1 WHERE lower(btrim(process)) = $2`, [name, key]);
        }
      }
      if ('active' in b) await q(`UPDATE sections SET active = $1 WHERE id = $2`, [!!b.active, id]);
    });
    invalidateSettings();
    return NextResponse.json({ success: true, config: await getFirmConfig(true) });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}
