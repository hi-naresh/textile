'use client';

// Status of an outgoing entry (Packed / Running / End, migration 015): the pill on ledger rows and the picker on the
// manual entry and dispatch forms. End is only offered to people with stock.end (owner; supervisors unless switched off).
import React from 'react';
import { Pill, Segmented, type Tone } from './ui';
import { ENTRY_STATUSES, ENTRY_STATUS_HINT, ENTRY_STATUS_LABEL, type EntryStatus } from '@/lib/registers';

const TONE: Record<EntryStatus, Tone> = { packed: 'info', running: 'good', end: 'neutral' };

/** `unset`: an outgoing entry with no status yet (saved before statuses existed) shows "Not set" instead of nothing. */
export function EntryStatusPill({ status, unset = false }: { status: EntryStatus | null | undefined; unset?: boolean }) {
  if (!status) return unset ? <Pill tone="neutral" className="pill-unset" title="No status yet. Set Packed, Running or End in Edit mode.">Not set</Pill> : null;
  return <Pill tone={TONE[status]} title={ENTRY_STATUS_HINT[status]}>{ENTRY_STATUS_LABEL[status]}</Pill>;
}

export function EntryStatusPicker({ value, onChange, canEnd, label = 'Status' }: {
  value: EntryStatus;
  onChange: (v: EntryStatus) => void;
  canEnd: boolean;
  label?: string;
}) {
  const options = ENTRY_STATUSES.filter((s) => canEnd || s !== 'end').map((s) => ({ value: s, label: ENTRY_STATUS_LABEL[s] }));
  return <Segmented label={label} value={value} onChange={onChange} options={options} className="fit" />;
}
