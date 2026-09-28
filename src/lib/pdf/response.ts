// PDF download response (inline, so phones open it in the viewer).
import { NextResponse } from 'next/server';
import { fileSafe } from '../dispatch/common';

export function pdfResponse(bytes: Uint8Array, name: string): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${fileSafe(name)}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
