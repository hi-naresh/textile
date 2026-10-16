import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EntryStatusPicker, EntryStatusPill } from '../../src/components/EntryStatus';
import { entryStatusValue } from '../../src/lib/registers';

test('outgoing picker offers Running and manual End, never Packed', () => {
  const html = renderToStaticMarkup(createElement(EntryStatusPicker, {
    value: 'running', canEnd: true, onChange: () => {},
  }));
  assert.match(html, /Running \(R\)/);
  assert.match(html, /End \(E\)/);
  assert.doesNotMatch(html, /Packed/);
});

test('outgoing picker respects the End permission', () => {
  const html = renderToStaticMarkup(createElement(EntryStatusPicker, {
    value: 'running', canEnd: false, onChange: () => {},
  }));
  assert.match(html, /Running \(R\)/);
  assert.doesNotMatch(html, /End \(E\)|Packed/);
});

test('incoming status identifies Packed with the register code P', () => {
  const html = renderToStaticMarkup(createElement(EntryStatusPill, { status: 'packed' }));
  assert.match(html, /Packed \(P\)/);
  assert.match(html, /first sale/);
});

test('server accepts outgoing Running and End but refuses Packed', () => {
  assert.equal(entryStatusValue(' Running '), 'running');
  assert.equal(entryStatusValue('End'), 'end');
  assert.equal(entryStatusValue(null), null);
  assert.throws(() => entryStatusValue('Packed'), /Packed is for incoming/);
  assert.throws(() => entryStatusValue('shipped'), /must be Running or End/);
});
