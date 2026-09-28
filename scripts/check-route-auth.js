// Fails when an API route handler has no server-side auth check.
// Every exported GET/POST/PUT/PATCH/DELETE in src/app/api/**/route.ts must call one of the guards below,
// or be marked public with a "// PUBLIC" comment right above it (login, sign up, refresh, cron…).
// Usage: npm run lint:auth
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'app', 'api');
const GUARDS = /\b(requireUser|requireCap|requireRole|requireDeveloper|readSession|refreshSession|passwordLogin|cronAllowed)\s*\(/;
const HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'route.ts') out.push(p);
  }
  return out;
}

const problems = [];
let handlers = 0;
for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const matches = [...src.matchAll(HANDLER)];
  matches.forEach((m, i) => {
    handlers++;
    const body = src.slice(m.index, i + 1 < matches.length ? matches[i + 1].index : src.length);
    const before = src.slice(Math.max(0, m.index - 400), m.index);
    const comment = before.slice(before.lastIndexOf('\n\n') + 1);
    if (!GUARDS.test(body) && !/\/\/\s*PUBLIC\b/.test(comment)) problems.push(`${path.relative(process.cwd(), file)} → ${m[1]}`);
  });
}

if (problems.length) {
  console.error(`[check-route-auth] ${problems.length} handler(s) without an auth check:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`[check-route-auth] OK — ${handlers} handlers checked.`);
