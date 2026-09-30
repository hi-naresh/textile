import type { Role, Tab } from '@/lib/access';
import type { TextileData } from '@/lib/useTextileData';
import type { WorkerDay } from '@/lib/derive';
import type { CaptureType, Worker } from '@/lib/types';
import type { Me, MeUser } from '@/lib/authClient';
import type { AgentFeed } from './AgentInbox';

export type Lang = 'en' | 'hi' | 'gu';
export type SheetKind = 'stock' | 'job' | 'import' | null;
export type ThemePref = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'detailed';
export type AttentionTab = 'alerts' | 'review';
/** A screen with unsaved work can hold navigation: return true to let it go now, or false and call proceed() later. */
export type LeaveGuard = (proceed: () => void) => boolean;

export interface Ctx {
  role: Role; // from the signed-in account (or the account a developer is viewing as)
  d: TextileData;
  go: (t: Tab) => void;
  days: WorkerDay[]; // every active worker, today
  me: Worker | null; // the signed-in worker's worker record (worker role)
  session: Me; // who is signed in on this device
  account: MeUser; // whose app this is: the signed-in user, or the user being viewed as
  lang: Lang;
  setLang: (l: Lang) => void;
  rate: number | null; // always null: there is no average ₹/m rate (every party gets its own rate)
  setRate: (r: number | null) => void;
  openSheet: (s: SheetKind) => void;
  capType: CaptureType; // selected capture type (shared by My shift → Capture)
  setCapType: (t: CaptureType) => void;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  openChat: () => void;
  density: Density;
  setDensity: (d: Density) => void;
  workerId: string | null;
  agents: AgentFeed; // open agent alerts / suggested actions (shared by Overview, Floor and the bell)
  attention: AttentionTab | null; // which tab of the "Needs your attention" panel is open (null = closed)
  openAttention: (t: AttentionTab | null) => void;
  setLeaveGuard: (g: LeaveGuard | null) => void;
  signups: number; // sign ups waiting for the owner's approval (0 for everyone else)
}
