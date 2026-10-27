import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lotSHint, statusFromLotS } from '../../src/lib/registers';

test('confirmed LOT S codes map to Running or End', () => {
  assert.equal(statusFromLotS('S'), 'running');
  assert.equal(statusFromLotS('r'), 'running');
  assert.equal(statusFromLotS('E'), 'end');
});

test('unconfirmed and unknown LOT S codes stay unmapped', () => {
  assert.equal(statusFromLotS('A'), null);
  assert.equal(statusFromLotS('X'), null);
  assert.equal(statusFromLotS(null), null);
  assert.match(lotSHint('A'), /not confirmed/);
});
