import { can, tabAllowed, type Role, type Tab } from '../access';

/** Only existing in-app screens; never arbitrary URLs or write actions. */
export function appLinkTab(href: string, role: Role): Tab | null {
  if (!/^#app=[a-z]+$/.test(href)) return null;
  const tab = href.slice(5) as Tab;
  if (tab === 'review') return can(role, 'capture.confirm') ? tab : null;
  return tabAllowed(role, tab) ? tab : null;
}
