// Phone number = username for owner, supervisors and workers. Stored as 10 digits (Indian mobile).
// Shared by the browser and the server.

/** "+91 98250 12345", "098250-12345", "9825012345" → "9825012345"; anything else → null. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let d = raw.replace(/[\s\-().]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.startsWith('0091')) d = d.slice(4);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

/** "9825012345" → "98250 12345" */
export function formatPhone(p: string | null | undefined): string {
  return p && p.length === 10 ? `${p.slice(0, 5)} ${p.slice(5)}` : p ?? '';
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}
