// Lot locations: a fixed place from the firm's list (Godown, Floor, …) or a market address
// "<market> <shop no.> · Pipe <pipe no.>", e.g. "RRTM 245 · Pipe 3" (pipe optional). Shared by browser and server.

export interface MarketLocation { market: string; shop: string; pipe: string | null }

const PART = /^[A-Za-z0-9][A-Za-z0-9/-]{0,11}$/; // shop / pipe numbers like 245, B-12, 3A

export function formatMarketLocation(market: string, shop: string, pipe?: string | null): string {
  const p = pipe?.trim();
  return `${market.trim()} ${shop.trim()}${p ? ` · Pipe ${p}` : ''}`;
}

/** "RRTM 245 · Pipe 3" → parts when the market is in the list (case-insensitive); otherwise null. */
export function parseMarketLocation(v: string, markets: string[]): MarketLocation | null {
  const m = /^(.+?)\s+([A-Za-z0-9][A-Za-z0-9/-]{0,11})(?:\s*·\s*Pipe\s+([A-Za-z0-9][A-Za-z0-9/-]{0,11}))?$/i.exec(v.trim());
  if (!m) return null;
  const market = markets.find((x) => x.toLowerCase() === m[1].trim().toLowerCase());
  if (!market || !PART.test(m[2]) || (m[3] && !PART.test(m[3]))) return null;
  return { market, shop: m[2].toUpperCase(), pipe: m[3] ? m[3].toUpperCase() : null };
}

export function validPart(v: string): boolean { return PART.test(v.trim()); }
