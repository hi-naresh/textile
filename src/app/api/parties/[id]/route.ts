import { NextRequest } from 'next/server';
import { withTransaction } from '@/lib/db';
import { requireCap } from '@/lib/apiAuth';
import { updateParty } from '@/lib/money/master';
import { jsonBody, respond } from '@/lib/money/http';

// PATCH { any party field } → { party }. Owner only.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    await requireCap(req, 'master.manage');
    const { id } = await params;
    const b = await jsonBody(req);
    return { party: await withTransaction((q) => updateParty(q, id, b)) };
  });
}
