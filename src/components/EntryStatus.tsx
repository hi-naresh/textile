'use client';

// Status of an outgoing entry (Packed / Running / End, migration 015): the pill on ledger rows and the picker on the
// manual entry and dispatch forms. End is only offered to people with stock.end (owner; supervisors unless switched off).
import React from 'react';
import { Pill, Segmented, type Tone } from './ui';
import { ENTRY_STATUSES, ENTRY_STATUS_HINT, ENTRY_STATUS_LABEL, type EntryStatus } from '@/lib/registers';

const TONE: Record<EntryStatus, Tone> = { packed: 'info', running: 'good', end: 'neutral' };

export function EntryStatusPill({ status }: { status: EntryStatus | null | undefined }) {
  if (!status) return null;
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
