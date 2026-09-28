import type { Role, Tab } from '@/lib/access';
import type { TextileData } from '@/lib/useTextileData';
import type { WorkerDay } from '@/lib/derive';
import type { CaptureType, Worker } from '@/lib/types';
import type { Me, MeUser } from '@/lib/authClient';

export type Lang = 'en' | 'hi' | 'gu';
export type SheetKind = 'stock' | 'job' | 'import' | null;
export type ThemePref = 'light' | 'dark' | 'system';
export type Density = 'compact' | 'detailed';

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
  rate: number | null; // owner-set average ₹ per meter (this device)
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
}
