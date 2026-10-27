// Staging-only HTTP driver. Session cookies stay in an operator-supplied local manifest.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runImportWorkload, type WorkloadUser } from './import-workload';

async function main() {
  const manifestArg = process.argv.find((arg) => arg.startsWith('--manifest='))?.slice(11);
  const targetArg = process.argv.find((arg) => arg.startsWith('--target='))?.slice(9);
  if (!manifestArg || !targetArg) throw new Error('Pass --manifest=/private/path/staging.json and --target=https://exact-staging-origin.');
  const manifest = JSON.parse(await readFile(manifestArg, 'utf8'));
  const target = new URL(targetArg);
  if (target.origin !== targetArg || target.username || target.password || target.protocol !== 'https:') {
    throw new Error('--target must be an HTTPS origin with no path, credentials or query.');
  }
  if (manifest.disposable !== true || manifest.origin !== target.origin) {
    throw new Error('Manifest must declare disposable: true and the exact same staging origin. Never use production.');
  }
  if (!Array.isArray(manifest.users) || manifest.users.length < 1 || manifest.users.length > 20) throw new Error('Provide 1..20 distinct staging users.');
  const validationRuns = manifest.validationRuns ?? 5;
  if (!Number.isInteger(validationRuns) || validationRuns < 1 || validationRuns > 20) throw new Error('validationRuns must be 1..20.');
  const users: WorkloadUser[] = [];
  const cookies = new Set<string>();
  const lots = new Set<string>();
  for (const user of manifest.users) {
    if (typeof user.cookie !== 'string' || !user.cookie.startsWith('tb_at=') || /[\r\n]/.test(user.cookie) || cookies.has(user.cookie)) {
      throw new Error('Each user needs a distinct valid staging session cookie.');
    }
    if (typeof user.lot !== 'string' || !user.lot.startsWith('STRESS-') || lots.has(user.lot)) {
      throw new Error('Each user needs a distinct STRESS- prefixed fixture lot.');
    }
    if (typeof user.file !== 'string') throw new Error('Each user needs an .xlsx fixture path.');
    const bytes = await readFile(path.resolve(path.dirname(manifestArg), user.file));
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Fixture files must be non-empty and at most 8 MB.');
    cookies.add(user.cookie);
    lots.add(user.lot);
    users.push({ cookie: user.cookie, lot: user.lot, file: new Uint8Array(bytes) });
  }
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ dry_run: true, origin: target.origin, users: users.length, validation_runs: validationRuns,
      note: 'No requests sent. Confirm this is disposable staging, then add --apply. Imports persist; reset the disposable environment after reconciliation.' }, null, 2));
    return;
  }
  const result = await runImportWorkload((route, init) => fetch(new URL(route, target), {
    ...init, redirect: 'error', signal: AbortSignal.timeout(300_000),
  }), users, validationRuns);
  console.log(JSON.stringify({ environment: 'staging HTTP', origin: target.origin, ...result,
    note: 'Collect server memory, function timeouts, DB connections and fixture reconciliation separately. No automatic deletion.' }, null, 2));
  if (result.failed_users) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
