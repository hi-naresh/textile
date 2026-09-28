// Session lengths and cookie settings. Every value can be overridden with an environment variable.

function num(name: string, fallback: number, min: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

export const AUTH = {
  /** Access token lifetime. Short: it is re-issued from the refresh token in the background. */
  accessMinutes: num('AUTH_ACCESS_MINUTES', 15, 1, 60),
  /** Client (owner / supervisor / worker) session: sliding, every use pushes it forward. */
  clientSessionDays: num('AUTH_CLIENT_SESSION_DAYS', 60, 1, 365),
  /** Developer session: much shorter than client sessions. */
  developerSessionHours: num('AUTH_DEVELOPER_SESSION_HOURS', 12, 1, 168),
  /** A just-rotated refresh token is still accepted this long (two tabs refreshing at the same moment). */
  refreshGraceSeconds: 30,
  /** Failed logins for one phone/email in the window before login is paused. */
  maxFailedLogins: 5,
  failedLoginWindowMinutes: 15,
  /** A rejected phone number may sign up again this many times. */
  maxSignupRetries: 3,
  /** Developer "View as": writes allowed only when explicitly switched on. */
  viewAsWrite: process.env.DEV_VIEW_AS_WRITE === '1',
};

export const COOKIE = {
  access: 'tb_at',
  refresh: 'tb_rt',
  // Only the refresh endpoints ever receive the refresh token.
  refreshPath: '/api/auth',
  secure: process.env.NODE_ENV === 'production' || process.env.AUTH_COOKIE_SECURE === '1',
};

export function sessionMs(kind: 'client' | 'developer'): number {
  return kind === 'developer' ? AUTH.developerSessionHours * 3_600_000 : AUTH.clientSessionDays * 86_400_000;
}
