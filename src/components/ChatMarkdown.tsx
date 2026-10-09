'use client';

import { Fragment, type ReactNode } from 'react';
import { type Role, type Tab } from '@/lib/access';
import { appLinkTab } from '@/lib/chat/links';

/** Small, deliberately text-only Markdown subset: no HTML, images or arbitrary URLs. */
export function ChatMarkdown({ text, role, navigate }: { text: string; role: Role; navigate: (tab: Tab) => void }) {
  const inline = (value: string): ReactNode[] => value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const tab = appLinkTab(link[2], role);
      return tab ? <a key={i} href={link[2]} onClick={(e) => { e.preventDefault(); navigate(tab); }}>{link[1]}</a> : <Fragment key={i}>{link[1]}</Fragment>;
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((v) => v.trim());
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[i + 1] ?? '')) {
      const header = cells(line); const rows: string[][] = []; const key = i;
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(<div key={key} className="chat-table"><table><thead><tr>{header.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr></thead><tbody>{rows.map((r, n) => <tr key={n}>{header.map((_, k) => <td key={k}>{inline(r[k] ?? '')}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const list = /^\s*(?:([-*]) |(\d+)\. )/.exec(line);
    if (list) {
      const ordered = !!list[2]; const items: ReactNode[] = []; const key = i;
      const pattern = ordered ? /^\s*\d+\. / : /^\s*[-*] /;
      while (i < lines.length && pattern.test(lines[i])) items.push(<li key={i}>{inline(lines[i++].replace(pattern, ''))}</li>);
      blocks.push(ordered ? <ol key={key} start={Number(list[2])}>{items}</ol> : <ul key={key}>{items}</ul>);
      continue;
    }
    if (/^#{1,6} /.test(line)) { blocks.push(<p key={i}><strong>{inline(line.replace(/^#{1,6} /, ''))}</strong></p>); i++; continue; }
    const paragraph: string[] = [line]; const key = i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(?:[-*] |\d+\. |#{1,6} )/.test(lines[i]) && !lines[i].includes('|')) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{paragraph.map((p, n) => <Fragment key={n}>{n > 0 && <br />}{inline(p)}</Fragment>)}</p>);
  }
  return <div className="chat-markdown">{blocks}</div>;
}

export function spokenText(text: string) {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`#|]/g, '').replace(/^\s*[-:]\s*[-: ]+$/gm, '').trim();
}
