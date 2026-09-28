// Tiny helpers shared by the money / master-data route handlers.
import { NextResponse } from 'next/server';
import { errorResponseBody, LedgerError } from '../ledger';

export async function respond(fn: () => Promise<unknown>): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = errorResponseBody(error);
    return NextResponse.json(body, { status });
  }
}

/** JSON body as an object (400 on anything else). */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new LedgerError('Send a JSON object.');
  return b as Record<string, unknown>;
}
