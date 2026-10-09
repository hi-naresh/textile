import { can, tabAllowed, type Role } from '../access';
import { FEATURES, FEATURE_GUIDES } from '../docs/catalog';


export function appHelp(role: Role, topic = '') {
  const guides = FEATURES.flatMap((f) => {
    const g = FEATURE_GUIDES[f.id];
    if (!g || !f.roles.includes(role) || (g.cap && !can(role, g.cap))) return [];
    if (g.tab !== 'review' && !tabAllowed(role, g.tab)) return [];
    return [{ id: f.id, title: f.title, description: g.description, steps: g.steps, link: `#app=${g.tab}` }];
  });
  if (!topic.trim()) return guides;
  if (FEATURES.some((f) => f.id === topic)) return guides.filter((g) => g.id === topic);
  const words = topic.toLowerCase().match(/[a-z]{3,}/g) ?? [];
  return guides.map((g) => ({ g, score: words.filter((w) => `${g.id} ${g.description}`.toLowerCase().includes(w)).length }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.g);
}

