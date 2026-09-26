// Everything that differs from one firm to the next.
// Stored in the database (app_settings, users, sections, supervisor_sections, workers)
// and edited by the owner in Settings. Nothing firm-specific lives in code.

export interface FirmProfile {
  name: string; // shown in the header and browser tab, e.g. "Narmada Group"
  city: string; // shown under the name, e.g. "Surat"
}

export interface Person {
  id: string; // users.id
  name: string;
}

export interface SupervisorProfile extends Person {
  sections: string[]; // section names this supervisor is responsible for
  active: boolean;
}

export interface SectionProfile {
  id: number;
  name: string; // e.g. "Weaving", "Dyeing", "Folding"
  active: boolean;
}

export interface FirmRules {
  shortageLimitPct: number; // job card shortage above this is flagged
  efficiencyTargetPct: number; // worker's day below this is flagged
  aiAutoConfirmPct: number; // photo reads at/above this confidence are saved without review
}

export interface FirmConfig {
  firm: FirmProfile;
  owner: Person;
  supervisors: SupervisorProfile[];
  sections: SectionProfile[];
  rules: FirmRules;
  locationPresets: string[]; // quick-pick lot locations, e.g. Godown, Shop, Floor
}

export const DEFAULT_RULES: FirmRules = { shortageLimitPct: 3, efficiencyTargetPct: 85, aiAutoConfirmPct: 80 };

// Used only until the real settings load (and on a brand-new install).
export const DEFAULT_CONFIG: FirmConfig = {
  firm: { name: 'Your firm', city: '' },
  owner: { id: 'usr-owner', name: 'Owner' },
  supervisors: [],
  sections: [],
  rules: DEFAULT_RULES,
  locationPresets: ['Godown', 'Shop', 'Floor'],
};

export const LIMITS = {
  nameMax: 100,
  shortageLimitPct: { min: 0.1, max: 50 },
  efficiencyTargetPct: { min: 1, max: 100 },
  aiAutoConfirmPct: { min: 50, max: 100 },
  locationPresetsMax: 12,
};
