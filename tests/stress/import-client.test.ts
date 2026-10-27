import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commitImport } from '../../src/lib/stockImportClient';
import type { ImportRow } from '../../src/lib/stock-import';

const row: ImportRow = {
  row: 2, direction: 'IN', sr_no: null, lot_id: 'STRESS-IMPORT-1', challan: null, quality: null, design: null,
  grey_meters: null, finished_meters: 1, pieces: null, mill_name: null, weaver_name: null, location: null, meters: null, party: null,
};

test('import client retries 429 and 5xx responses then reports the saved chunk once', async () => {
  const originalFetch = globalThis.fetch;
  const statuses = [503, 429, 200];
  let calls = 0;
  globalThis.fetch = async () => {
    const status = statuses[calls++];
    return new Response(JSON.stringify({ saved: 1, skipped: 0, in: 1, out: 0 }), {
      status,
      headers: status === 429 ? { 'Retry-After': '0' } : undefined,
    });
  };
  try {
    const result = await commitImport('0123456789abcdef', [row], () => {});
    assert.equal(result.ok, true);
    assert.equal(result.saved, 1);
    assert.equal(result.done, 1);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('import client does not retry non-transient client errors', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: 'Invalid row.' }), { status: 422 });
  };
  try {
    const result = await commitImport('0123456789abcdef', [row], () => {});
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Invalid row.');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a lost response can be retried without duplicating an already committed row', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('Connection dropped after the server committed.');
    return new Response(JSON.stringify({ saved: 0, skipped: 1, in: 0, out: 0 }), { status: 200 });
  };
  try {
    const result = await commitImport('0123456789abcdef', [row], () => {});
    assert.equal(result.ok, true);
    assert.equal(result.saved, 0);
    assert.equal(result.skipped, 1);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
