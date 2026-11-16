// Isolate unfiltered totals from leftover local fixtures; never reset the supplied database.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
async function main() {
  const { createDisposableDatabase } = await import('./stress/disposable-database');
  const isolated = await createDisposableDatabase('fullbatch');
  try {
    const files = ['tests/chat/regression.test.tsx'];
    for (const dir of ['tests/stock', 'tests/stress']) for (const file of await readdir(dir)) if (file.endsWith('.test.ts')) files.push(`${dir}/${file}`);
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: isolated.url, DB_QUIET: '1' } });
    process.exitCode = await new Promise<number>(resolve => child.once('exit', code => resolve(code ?? 1)));
  } finally { await isolated.cleanup(); }

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
