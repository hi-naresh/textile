import type { Role, Tab } from '@/lib/access';
import type { TextileData } from '@/lib/useTextileData';
import type { WorkerDay } from '@/lib/derive';
import type { CaptureType, Worker } from '@/lib/types';

export type Lang = 'en' | 'hi' | 'gu';
export type SheetKind = 'stock' | 'job' | 'import' | null;
export type ThemePref = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'detailed';

export interface Ctx {
  role: Role;
  d: TextileData;
  go: (t: Tab) => void;
  days: WorkerDay[]; // every active worker, today
  me: Worker | null; // worker being previewed (worker role)
  lang: Lang;
  setLang: (l: Lang) => void;
  rate: number | null; // owner-set average ₹ per meter (this device)
  setRate: (r: number | null) => void;
  openSheet: (s: SheetKind) => void;
  capType: CaptureType; // selected capture type (shared by My shift → Capture)
  setCapType: (t: CaptureType) => void;
  theme: ThemePref;
  setTheme: (t: ThemePref) => void;
  openChat: () => void;
  // Preview controls (Settings → View) until real login exists
  setRole: (r: Role) => void;
  density: Density;
  setDensity: (d: Density) => void;
  workerId: string | null;
  setWorkerId: (id: string) => void;
  supervisorId: string | null;
  setSupervisorId: (id: string) => void;
}
