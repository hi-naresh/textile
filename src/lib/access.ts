// Role hierarchy, data scope and control permissions.
// Single source of truth: the Access & roles screen renders MATRIX,
// and every screen gates data/actions through can() and the scope helpers.
//
// NOTE: there is no login yet, so the active role is chosen with the
// "Preview as" switch. These rules shape the UI; enforce the same rules
// in the API routes once real authentication is added.

import type { CaptureType, JobCard } from './types';
import { DEFAULT_CONFIG, type FirmConfig, type SupervisorProfile } from './config';

export type Role = 'owner' | 'supervisor' | 'worker';

export const ROLES: Role[] = ['owner', 'supervisor', 'worker'];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  supervisor: 'Supervisor',
  worker: 'Worker',
};

// ---------- Firm configuration (loaded from /api/settings) ----------
// Screens read the current firm's names, sections and rules through these getters.
// page.tsx calls setFirmConfig() when settings load or change, then re-renders.
let current: FirmConfig = DEFAULT_CONFIG;
let previewSupervisorId: string | null = null;

export function setFirmConfig(c: FirmConfig) { current = c; }
export function firmConfig(): FirmConfig { return current; }
export function firm() { return current.firm; }
export function owner() { return current.owner; }
export function rules() { return current.rules; }
export function locationPresets() { return current.locationPresets; }
/** Locations a person can pick: the firm's fixed list (+ Floor, used by job cards). */
export function allLocations(): string[] {
  const l = current.locationPresets;
  return l.some((x) => x.toLowerCase() === 'floor') ? l : [...l, 'Floor'];
}
export function activeSupervisors() { return current.supervisors.filter((s) => s.active); }
export function sectionNames(): string[] { return current.sections.filter((s) => s.active).map((s) => s.name); }

/** Supervisor used when previewing the Supervisor role. */
export function setPreviewSupervisor(id: string | null) { previewSupervisorId = id; }
export function activeSupervisor(): SupervisorProfile {
  const list = activeSupervisors();
  return list.find((s) => s.id === previewSupervisorId) ?? list[0] ?? { id: '', name: 'Supervisor', sections: [], active: true };
}

/** "Folding Section" → "Folding" */
export function sectionName(raw: string | null | undefined): string {
  if (!raw) return '—';
  return raw.replace(/\s*section\s*$/i, '').trim();
}

export function supervisorFor(section: string): string {
  const s = activeSupervisors().find((x) => x.sections.includes(sectionName(section)));
  return s ? s.name : '—';
}

/** Section a capture read belongs to (used to scope the review queue). */
export function captureSection(type: CaptureType): string {
  if (type === 'job_card_folding') return 'Folding';
  if (type === 'incoming_stock') return 'Stores';
  return 'Dispatch';
}

// ---------- Capture rights ----------
// Owner: any capture. Supervisor: incoming + outgoing challans. Worker: job card (cut) only.
export const CAPTURE_TYPES: Record<Role, CaptureType[]> = {
  owner: ['incoming_stock', 'outgoing_stock', 'job_card_folding'],
  supervisor: ['incoming_stock', 'outgoing_stock'],
  worker: ['job_card_folding'],
};
export function canCapture(role: Role, type: CaptureType): boolean {
  return CAPTURE_TYPES[role].includes(type);
}

export function inSupervisorScope(section: string): boolean {
  return activeSupervisor().sections.includes(sectionName(section));
}

export function jobInScope(role: Role, jc: JobCard, workerId?: string): boolean {
  if (role === 'owner') return true;
  if (role === 'supervisor') return inSupervisorScope(jc.process) || inSupervisorScope(jc.worker_section);
  return jc.worker_id === workerId;
}

/** Review queue scope: supervisors review the challans they capture + job card reads from their sections. */
export function captureInScope(role: Role, type: CaptureType): boolean {
  if (role === 'owner') return true;
  if (role === 'supervisor') return canCapture('supervisor', type) || inSupervisorScope(captureSection(type));
  return false;
}

// ---------- Capabilities ----------
export type Capability =
  | 'stock.quantity'
  | 'stock.value'
  | 'jobs.view'
  | 'efficiency.view'
  | 'cctv.view'
  | 'chat.use'
  | 'capture.create'
  | 'capture.confirm'
  | 'jobs.manage'
  | 'work.allot'
  | 'lots.move'
  | 'ledger.edit'
  | 'users.manage'
  | 'settings.manage'
  // Phase 2
  | 'orders.view'
  | 'orders.manage'
  | 'orders.allocate'
  | 'inquiry.handle'
  | 'dispatch.manage'
  | 'finance.view'
  | 'master.manage'
  | 'reports.view';

type Level = 'Full' | 'View' | 'Full + override' | 'Via job cards' | 'Section' | 'Section lots' | 'Section crew' | 'Meters only' | 'In + out challans' | 'Job card (cut)' | 'Own cards' | 'Own only' | '—';

export const MATRIX: { layer: 'Data' | 'Control'; cap: Capability; label: string; owner: Level; supervisor: Level; worker: Level }[] = [
  { layer: 'Data', cap: 'stock.quantity', label: 'Stock quantities (meters)', owner: 'Full', supervisor: 'Section lots', worker: '—' },
  { layer: 'Data', cap: 'stock.value', label: 'Stock value, party rates (₹)', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Data', cap: 'jobs.view', label: 'Job cards & shortage', owner: 'Full', supervisor: 'Section', worker: '—' },
  { layer: 'Data', cap: 'efficiency.view', label: 'Worker efficiency', owner: 'Full', supervisor: 'Section crew', worker: '—' },
  { layer: 'Data', cap: 'cctv.view', label: 'CCTV activity', owner: 'Full', supervisor: 'Section crew', worker: '—' },
  { layer: 'Data', cap: 'chat.use', label: 'Chat', owner: 'Full', supervisor: 'Meters only', worker: '—' },
  { layer: 'Control', cap: 'capture.create', label: 'Capture photos', owner: 'Full', supervisor: 'In + out challans', worker: 'Job card (cut)' },
  { layer: 'Control', cap: 'capture.confirm', label: 'Confirm AI reads to ledger', owner: 'Full + override', supervisor: 'Section', worker: '—' },
  { layer: 'Control', cap: 'jobs.manage', label: 'Create / close job cards', owner: 'Full', supervisor: 'Section', worker: '—' },
  { layer: 'Control', cap: 'work.allot', label: 'Allot work', owner: 'Full', supervisor: 'Section crew', worker: '—' },
  { layer: 'Control', cap: 'lots.move', label: 'Move lots (godown / shop / floor)', owner: 'Full', supervisor: 'Via job cards', worker: '—' },
  { layer: 'Control', cap: 'ledger.edit', label: 'Manual ledger entries', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Control', cap: 'settings.manage', label: 'Firm settings & rules', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Control', cap: 'users.manage', label: 'Users, roles & sections', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Data', cap: 'orders.view', label: 'Orders & allocations', owner: 'Full', supervisor: 'Meters only', worker: '—' },
  { layer: 'Data', cap: 'finance.view', label: 'Invoices, payments, credit, margin (₹)', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Data', cap: 'reports.view', label: 'Reports', owner: 'Full', supervisor: 'Meters only', worker: '—' },
  { layer: 'Control', cap: 'inquiry.handle', label: 'Log inquiries, draft replies', owner: 'Full', supervisor: 'Full', worker: '—' },
  { layer: 'Control', cap: 'orders.allocate', label: 'Reserve / release lots for orders', owner: 'Full', supervisor: 'Meters only', worker: '—' },
  { layer: 'Control', cap: 'orders.manage', label: 'Create orders, set rates', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Control', cap: 'dispatch.manage', label: 'Record dispatches, print challans', owner: 'Full', supervisor: 'Full', worker: '—' },
  { layer: 'Control', cap: 'master.manage', label: 'Parties, rates, costs, billing', owner: 'Full', supervisor: '—', worker: '—' },
];

export function can(role: Role, cap: Capability): boolean {
  const row = MATRIX.find((m) => m.cap === cap);
  return !!row && row[role] !== '—';
}

export function levelTone(level: string): 'good' | 'warn' | 'info' | 'neutral' {
  if (level.startsWith('Full')) return 'good';
  if (level === '—') return 'neutral';
  if (level.startsWith('Own') || level.startsWith('Section') || level.startsWith('Meters')) return 'warn';
  return 'info';
}

// ---------- Navigation ----------
export type Tab =
  | 'overview' | 'stock' | 'jobs' | 'review' | 'capture' | 'people' | 'access' | 'settings'
  | 'floor' | 'allot'
  | 'orders' | 'dispatch' | 'money' | 'reports';

export interface NavItem {
  tab: Tab;
  label: string;
  short: string; // bottom bar label
  icon: string;
  group: string;
}

export const NAV: Record<Role, NavItem[]> = {
  owner: [
    { tab: 'overview', label: 'Overview', short: 'Home', icon: 'grid', group: 'Business' },
    { tab: 'stock', label: 'Stock ledger', short: 'Stock', icon: 'box', group: 'Business' },
    { tab: 'jobs', label: 'Job cards', short: 'Cards', icon: 'card', group: 'Business' },
    { tab: 'review', label: 'Review queue', short: 'Review', icon: 'scan', group: 'Business' },
    { tab: 'capture', label: 'Capture', short: 'Capture', icon: 'camera', group: 'Business' },
    { tab: 'orders', label: 'Orders & inquiries', short: 'Orders', icon: 'cart', group: 'Sales' },
    { tab: 'dispatch', label: 'Dispatch & documents', short: 'Dispatch', icon: 'truck', group: 'Sales' },
    { tab: 'money', label: 'Money', short: 'Money', icon: 'rupee', group: 'Sales' },
    { tab: 'reports', label: 'Reports', short: 'Reports', icon: 'chart', group: 'Sales' },
    { tab: 'people', label: 'People & CCTV', short: 'People', icon: 'users', group: 'Admin' },
    { tab: 'access', label: 'Access & roles', short: 'Access', icon: 'shield', group: 'Admin' },
    { tab: 'settings', label: 'Settings', short: 'Settings', icon: 'settings', group: 'Admin' },
  ],
  supervisor: [
    { tab: 'floor', label: 'Floor today', short: 'Floor', icon: 'factory', group: 'My sections' },
    { tab: 'capture', label: 'Capture challan', short: 'Capture', icon: 'camera', group: 'My sections' },
    { tab: 'review', label: 'Review queue', short: 'Review', icon: 'scan', group: 'My sections' },
    { tab: 'jobs', label: 'Job cards', short: 'Cards', icon: 'card', group: 'My sections' },
    { tab: 'allot', label: 'Allot work', short: 'Allot', icon: 'userPlus', group: 'My sections' },
    { tab: 'orders', label: 'Orders & inquiries', short: 'Orders', icon: 'cart', group: 'Sales' },
    { tab: 'dispatch', label: 'Dispatch', short: 'Dispatch', icon: 'truck', group: 'Sales' },
    { tab: 'settings', label: 'Settings', short: 'Settings', icon: 'settings', group: 'Me' },
  ],
  worker: [
    { tab: 'capture', label: 'Capture job card', short: 'Capture', icon: 'camera', group: 'My work' },
    { tab: 'settings', label: 'Settings', short: 'Settings', icon: 'settings', group: 'Me' },
  ],
};

// Bottom bar on phones: these tabs, the rest go in "More".
export const MOBILE_PRIMARY: Record<Role, Tab[]> = {
  owner: ['overview', 'capture', 'review', 'stock'],
  supervisor: ['floor', 'capture', 'review', 'jobs'],
  worker: ['capture', 'settings'],
};

export const HOME_TAB: Record<Role, Tab> = { owner: 'overview', supervisor: 'floor', worker: 'capture' };

export function tabAllowed(role: Role, tab: Tab): boolean {
  return NAV[role].some((n) => n.tab === tab);
}

/** Labels may contain {firm}, replaced with the firm's name. */
export function withFirm(label: string): string {
  return label.replace('{firm}', firm().name);
}
