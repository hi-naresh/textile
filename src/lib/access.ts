// Role hierarchy, data scope and control permissions.
// Single source of truth: the Access & roles screen renders MATRIX,
// and every screen gates data/actions through can() and the scope helpers.
//
// NOTE: there is no login yet, so the active role is chosen with the
// "Preview as" switch. These rules shape the UI; enforce the same rules
// in the API routes once real authentication is added.

import type { CaptureType, JobCard } from './types';

export type Role = 'owner' | 'supervisor' | 'worker';

export const ROLES: Role[] = ['owner', 'supervisor', 'worker'];

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  supervisor: 'Supervisor',
  worker: 'Worker',
};

// Users from the `users` table (scripts/db-init.js seed).
export const OWNER = { id: 'usr-owner', name: 'Mukesh' };

// Supervisor → the sections (processes) they are responsible for.
export const SUPERVISORS = [
  { id: 'usr-sup1', name: 'Sanjay Patel', sections: ['Folding', 'Dyeing'] },
  { id: 'usr-sup2', name: 'Kishore Gajiwala', sections: ['Weaving', 'Printing'] },
];

// The supervisor used when previewing the Supervisor role.
export const ACTIVE_SUPERVISOR = SUPERVISORS[0];

export const SECTIONS = ['Weaving', 'Dyeing', 'Printing', 'Folding'];

export const SHORTAGE_LIMIT_PCT = 3; // matches SHORTAGE_THRESHOLD_PCT in /api/job-cards
export const EFFICIENCY_FLAG_PCT = 85; // matches efficiency roll-up flag in /api/job-cards

/** "Folding Section" → "Folding" */
export function sectionName(raw: string | null | undefined): string {
  if (!raw) return '—';
  return raw.replace(/\s*section\s*$/i, '').trim();
}

export function supervisorFor(section: string): string {
  const s = SUPERVISORS.find((x) => x.sections.includes(sectionName(section)));
  return s ? s.name : '—';
}

/** Section a capture read belongs to (used to scope the review queue). */
export function captureSection(type: CaptureType): string {
  if (type === 'job_card_folding') return 'Folding';
  if (type === 'incoming_stock') return 'Stores';
  return 'Dispatch';
}

export function inSupervisorScope(section: string): boolean {
  return ACTIVE_SUPERVISOR.sections.includes(sectionName(section));
}

export function jobInScope(role: Role, jc: JobCard, workerId?: string): boolean {
  if (role === 'owner') return true;
  if (role === 'supervisor') return inSupervisorScope(jc.process) || inSupervisorScope(jc.worker_section);
  return jc.worker_id === workerId;
}

export function captureInScope(role: Role, type: CaptureType): boolean {
  if (role === 'owner') return true;
  if (role === 'supervisor') return inSupervisorScope(captureSection(type));
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
  | 'ledger.edit'
  | 'users.manage';

type Level = 'Full' | 'Full + override' | 'Section' | 'Section lots' | 'Section crew' | 'Meters only' | 'Own cards' | 'Own only' | '—';

export const MATRIX: { layer: 'Data' | 'Control'; cap: Capability; label: string; owner: Level; supervisor: Level; worker: Level }[] = [
  { layer: 'Data', cap: 'stock.quantity', label: 'Stock quantities (meters)', owner: 'Full', supervisor: 'Section lots', worker: '—' },
  { layer: 'Data', cap: 'stock.value', label: 'Stock value, party rates (₹)', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Data', cap: 'jobs.view', label: 'Job cards & shortage', owner: 'Full', supervisor: 'Section', worker: 'Own cards' },
  { layer: 'Data', cap: 'efficiency.view', label: 'Worker efficiency', owner: 'Full', supervisor: 'Section crew', worker: 'Own only' },
  { layer: 'Data', cap: 'cctv.view', label: 'CCTV activity', owner: 'Full', supervisor: 'Section crew', worker: '—' },
  { layer: 'Data', cap: 'chat.use', label: 'Ask Textile Brain + audit log', owner: 'Full', supervisor: 'Meters only', worker: '—' },
  { layer: 'Control', cap: 'capture.create', label: 'Capture photos', owner: 'Full', supervisor: 'Full', worker: 'Full' },
  { layer: 'Control', cap: 'capture.confirm', label: 'Confirm AI reads to ledger', owner: 'Full + override', supervisor: 'Section', worker: '—' },
  { layer: 'Control', cap: 'jobs.manage', label: 'Create / close job cards', owner: 'Full', supervisor: 'Section', worker: '—' },
  { layer: 'Control', cap: 'work.allot', label: 'Allot work', owner: 'Full', supervisor: 'Section crew', worker: '—' },
  { layer: 'Control', cap: 'ledger.edit', label: 'Manual ledger entries', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Control', cap: 'users.manage', label: 'Users, roles & sections', owner: 'Full', supervisor: '—', worker: '—' },
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
  | 'overview' | 'stock' | 'jobs' | 'review' | 'ask' | 'people' | 'access'
  | 'floor' | 'allot'
  | 'shift' | 'capture' | 'history';

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
    { tab: 'ask', label: 'Ask Textile Brain', short: 'Ask', icon: 'chat', group: 'Business' },
    { tab: 'people', label: 'People & CCTV', short: 'People', icon: 'users', group: 'Admin' },
    { tab: 'access', label: 'Access & roles', short: 'Access', icon: 'shield', group: 'Admin' },
  ],
  supervisor: [
    { tab: 'floor', label: 'Floor today', short: 'Floor', icon: 'factory', group: 'My sections' },
    { tab: 'jobs', label: 'Job cards', short: 'Cards', icon: 'card', group: 'My sections' },
    { tab: 'review', label: 'Review queue', short: 'Review', icon: 'scan', group: 'My sections' },
    { tab: 'allot', label: 'Allot work', short: 'Allot', icon: 'userPlus', group: 'My sections' },
    { tab: 'ask', label: 'Ask Textile Brain', short: 'Ask', icon: 'chat', group: 'My sections' },
  ],
  worker: [
    { tab: 'shift', label: 'My shift', short: 'My shift', icon: 'clock', group: 'My work' },
    { tab: 'capture', label: 'Capture photo', short: 'Capture', icon: 'camera', group: 'My work' },
    { tab: 'history', label: 'My history', short: 'History', icon: 'history', group: 'My work' },
  ],
};

// Bottom bar on phones: first N tabs, the rest go in "More".
export const MOBILE_PRIMARY: Record<Role, Tab[]> = {
  owner: ['overview', 'review', 'ask'],
  supervisor: ['floor', 'review', 'allot'],
  worker: ['shift', 'capture', 'history'],
};

export const HOME_TAB: Record<Role, Tab> = { owner: 'overview', supervisor: 'floor', worker: 'shift' };

export function tabAllowed(role: Role, tab: Tab): boolean {
  return NAV[role].some((n) => n.tab === tab);
}

export const SCOPE_TEXT: Record<Role, { scope: string; line: string; chip: string }> = {
  owner: {
    scope: 'Full access · all units',
    line: 'Sees ₹ values, party rates, CCTV and every section. Manages users.',
    chip: 'Viewing all sections',
  },
  supervisor: {
    scope: `${ACTIVE_SUPERVISOR.sections.join(' + ')} · can edit`,
    line: 'Meters, not money. Confirms reads, runs job cards and allots work in own sections.',
    chip: `${ACTIVE_SUPERVISOR.sections.join(' + ')} only`,
  },
  worker: {
    scope: 'Own records · capture',
    line: 'Sees own allotments and history. Can photograph cards and challans.',
    chip: 'My work only',
  },
};
