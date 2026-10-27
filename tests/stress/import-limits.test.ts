import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toBuffer } from '../../src/lib/excel';
import { ImportFileError, IMPORT_SHEET, MAX_IMPORT_ROWS, TEMPLATE_COLUMNS, newBook, validateImport } from '../../src/lib/stock-import';
import type { Q } from '../../src/lib/db';

async function workbookWithRows(rowCount: number): Promise<Buffer> {
  const wb = newBook('Stress import test');
  const ws = wb.addWorksheet(IMPORT_SHEET);
  ws.columns = TEMPLATE_COLUMNS.map((column) => ({ header: column.header, key: column.key }));
  for (let i = 1; i <= rowCount; i++) {
    ws.addRow({
      direction: 'IN',
      lot_id: `STRESS-IMPORT-${i}`,
      quality: 'Stress test',
      design: 'Synthetic',
      finished_meters: 1,
      mill_name: 'Stress test mill',
    });
  }
  return toBuffer(wb);
}

const noDatabaseRows: Q = async () => ({
  rows: [],
  rowCount: 0,
  command: 'SELECT',
  oid: 0,
  fields: [],
});

test('stock import accepts exactly the configured per-file row limit', async () => {
  const result = await validateImport(noDatabaseRows, await workbookWithRows(MAX_IMPORT_ROWS));
  assert.equal(result.ok, true);
  assert.equal(result.total, MAX_IMPORT_ROWS);
  assert.equal(result.rows?.length, MAX_IMPORT_ROWS);
});

test('stock import rejects one row above the configured limit before database lookups', async () => {
  const failIfQueried: Q = async () => {
    throw new Error('Oversized import should be rejected before database lookups.');
  };
  await assert.rejects(
    validateImport(failIfQueried, await workbookWithRows(MAX_IMPORT_ROWS + 1)),
    (error: unknown) => error instanceof ImportFileError && /20,000 rows per file/.test(error.message),
  );
});

test('stock import reports a corrupt workbook as a user-facing file error', async () => {
  await assert.rejects(
    validateImport(noDatabaseRows, Buffer.from('not an Excel workbook')),
    (error: unknown) => error instanceof ImportFileError && /Could not open this file/.test(error.message),
  );
});

test('stock import reports an unrecognized sheet and an empty template without writing', async () => {
  const wrongSheet = newBook('Wrong sheet');
  wrongSheet.addWorksheet('Other').addRow(['Not', 'a', 'register']);
  const wrongResult = await validateImport(noDatabaseRows, await toBuffer(wrongSheet));
  assert.equal(wrongResult.ok, false);
  assert.match(wrongResult.headerProblems[0]?.message ?? '', /Could not tell what this file is/);

  const empty = newBook('Empty template');
  const ws = empty.addWorksheet(IMPORT_SHEET);
  ws.addRow(TEMPLATE_COLUMNS.map((column) => column.header));
  const emptyResult = await validateImport(noDatabaseRows, await toBuffer(empty));
  assert.equal(emptyResult.ok, false);
  assert.match(emptyResult.headerProblems[0]?.message ?? '', /No filled rows/);
});

test('stock import preserves unicode text and reports oversized text cells as row problems', async () => {
  const wb = newBook('Edge cases');
  const ws = wb.addWorksheet(IMPORT_SHEET);
  ws.columns = TEMPLATE_COLUMNS.map((column) => ({ header: column.header, key: column.key }));
  ws.addRow({
    direction: 'IN', lot_id: 'STRESS-UNICODE-1', quality: 'कपास 🌿', design: 'आकाश',
    finished_meters: 1, mill_name: 'Mill',
  });
  ws.addRow({
    direction: 'IN', lot_id: 'STRESS-LONG-1', quality: 'Q'.repeat(101), design: 'Long name',
    finished_meters: 1, mill_name: 'Mill',
  });
  const result = await validateImport(noDatabaseRows, await toBuffer(wb));
  assert.equal(result.ok, false);
  assert.equal(result.rows, undefined);
  assert.ok(result.problems.some((problem) => problem.row === 3 && /100 characters or fewer/.test(problem.message)), JSON.stringify(result.problems));
});
