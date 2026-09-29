/* eslint-disable @typescript-eslint/no-require-imports -- plain Node script */
// Auto-loads .env.local and .env into process.env if present.
// Plain Node CLI scripts do not automatically load .env files like Next.js does.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(path.resolve(process.cwd(), '.env.local')); } catch {}
    try { process.loadEnvFile(path.resolve(process.cwd(), '.env')); } catch {}
    return;
  }
  for (const f of ['.env.local', '.env']) {
    try {
      const p = path.resolve(process.cwd(), f);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
          process.env[key] = val;
        }
      }
    } catch {}
  }
}

loadEnv();
