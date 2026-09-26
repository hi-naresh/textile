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

export function inSupervisorScope(section: string): boolean {
  return activeSupervisor().sections.includes(sectionName(section));
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
  | 'lots.move'
  | 'ledger.edit'
  | 'users.manage'
  | 'settings.manage';

type Level = 'Full' | 'Full + override' | 'Via job cards' | 'Section' | 'Section lots' | 'Section crew' | 'Meters only' | 'Own cards' | 'Own only' | '—';

export const MATRIX: { layer: 'Data' | 'Control'; cap: Capability; label: string; owner: Level; supervisor: Level; worker: Level }[] = [
  { layer: 'Data', cap: 'stock.quantity', label: 'Stock quantities (meters)', owner: 'Full', supervisor: 'Section lots', worker: '—' },
  { layer: 'Data', cap: 'stock.value', label: 'Stock value, party rates (₹)', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Data', cap: 'jobs.view', label: 'Job cards & shortage', owner: 'Full', supervisor: 'Section', worker: 'Own cards' },
  { layer: 'Data', cap: 'efficiency.view', label: 'Worker efficiency', owner: 'Full', supervisor: 'Section crew', worker: 'Own only' },
  { layer: 'Data', cap: 'cctv.view', label: 'CCTV activity', owner: 'Full', supervisor: 'Section crew', worker: '—' },
  { layer: 'Data', cap: 'chat.use', label: 'Ask {firm} + audit log', owner: 'Full', supervisor: 'Meters only', worker: '—' },
  { layer: 'Control', cap: 'capture.create', label: 'Capture photos', owner: 'Full', supervisor: 'Full', worker: 'Full' },
  { layer: 'Control', cap: 'capture.confirm', label: 'Confirm AI reads to ledger', owner: 'Full + override', supervisor: 'Section', worker: '—' },
  { layer: 'Control', cap: 'jobs.manage', label: 'Create / close job cards', owner: 'Full', supervisor: 'Section', worker: '—' },
  { layer: 'Control', cap: 'work.allot', label: 'Allot work', owner: 'Full', supervisor: 'Section crew', worker: '—' },
  { layer: 'Control', cap: 'lots.move', label: 'Move lots (godown / shop / floor)', owner: 'Full', supervisor: 'Via job cards', worker: '—' },
  { layer: 'Control', cap: 'ledger.edit', label: 'Manual ledger entries', owner: 'Full', supervisor: '—', worker: '—' },
  { layer: 'Control', cap: 'settings.manage', label: 'Firm settings & rules', owner: 'Full', supervisor: '—', worker: '—' },
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
  | 'overview' | 'stock' | 'jobs' | 'review' | 'ask' | 'people' | 'access' | 'settings'
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
    { tab: 'ask', label: 'Ask {firm}', short: 'Ask', icon: 'chat', group: 'Business' },
    { tab: 'people', label: 'People & CCTV', short: 'People', icon: 'users', group: 'Admin' },
    { tab: 'access', label: 'Access & roles', short: 'Access', icon: 'shield', group: 'Admin' },
    { tab: 'settings', label: 'Settings', short: 'Settings', icon: 'settings', group: 'Admin' },
  ],
  supervisor: [
    { tab: 'floor', label: 'Floor today', short: 'Floor', icon: 'factory', group: 'My sections' },
    { tab: 'jobs', label: 'Job cards', short: 'Cards', icon: 'card', group: 'My sections' },
    { tab: 'review', label: 'Review queue', short: 'Review', icon: 'scan', group: 'My sections' },
    { tab: 'allot', label: 'Allot work', short: 'Allot', icon: 'userPlus', group: 'My sections' },
    { tab: 'ask', label: 'Ask {firm}', short: 'Ask', icon: 'chat', group: 'My sections' },
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

export function scopeText(role: Role): { scope: string; line: string; chip: string } {
  if (role === 'owner') return { scope: 'Full access · all units', line: 'Sees ₹ values, party rates, CCTV and every section. Manages people and settings.', chip: 'Viewing all sections' };
  if (role === 'supervisor') {
    const secs = activeSupervisor().sections;
    const list = secs.length ? secs.join(' + ') : 'No sections assigned';
    return { scope: `${list} · can edit`, line: 'Meters, not money. Confirms reads, runs job cards and allots work in own sections.', chip: secs.length ? `${list} only` : list };
  }
  return { scope: 'Own records · capture', line: 'Sees own allotments and history. Can photograph cards and challans.', chip: 'My work only' };
}

/** Labels may contain {firm}, replaced with the firm's name. */
export function withFirm(label: string): string {
  return label.replace('{firm}', firm().name);
}
