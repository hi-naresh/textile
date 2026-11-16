'use client';

import React from 'react';
import { displayEntryDate, entryDateError, entryDateValue } from '@/lib/entry-date';

/** Plain text avoids native date segments changing order with browser/Windows locale. */
export function EntryDateInput({ value, onChange, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: string; onChange: (value: string) => void;
}) {
  return <input {...props} type="text" inputMode="numeric" autoComplete="off" placeholder="DD-MM-YYYY" maxLength={10}
    value={displayEntryDate(value)} aria-invalid={!!entryDateError(value)}
    onChange={(e) => {
      const next = e.target.value;
      e.target.setCustomValidity(entryDateError(next) ?? '');
      onChange(next);
    }} onBlur={(e) => {
      const error = entryDateError(value);
      e.target.setCustomValidity(error ?? '');
      if (!error) onChange(entryDateValue(value));
      props.onBlur?.(e);
    }} />;
}
