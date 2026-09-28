// Tiny A4 layout helper on top of pdf-lib: firm letterhead, wrapped text, tables that break across
// pages (header row repeated), and "Page x of y" footers. Standard Helvetica only (WinAnsi):
// no ₹ glyph — money is written "Rs." — and other non-Latin characters are replaced.
import { degrees, PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib';
import type { Billing } from '../billing';

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;
export const M = 40; // margin
export const CONTENT_W = PAGE_W - 2 * M;
const FOOTER_H = 36;

export const INK = rgb(0.1, 0.1, 0.12);
export const GREY = rgb(0.42, 0.42, 0.46);
export const LINE = rgb(0.78, 0.78, 0.8);
export const FILL = rgb(0.93, 0.92, 0.89);
export const RED = rgb(0.75, 0.12, 0.12);

// WinAnsi extras above 0x7F that Helvetica can draw.
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

/** Make text drawable with the standard fonts. */
export function safe(v: unknown): string {
  const s = String(v ?? '').replace(/₹\s?/g, 'Rs. ').replace(/[\t\r]/g, ' ').replace(/ /g, ' ');
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\n' || (c >= 32 && c <= 126) || (c >= 161 && c <= 255) || WIN_ANSI_EXTRA.has(ch)) out += ch;
    else if (c === 0x2212) out += '-';
    else out += '?';
  }
  return out;
}

export interface TextOpts { size?: number; bold?: boolean; color?: RGB; align?: 'left' | 'right' | 'center'; width?: number }
export interface Col { label: string; width: number; align?: 'left' | 'right' | 'center' }

export class Pdf {
  doc!: PDFDocument;
  font!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  private constructor(public title: string, public billing: Billing, public subtitle: string | null) {}

  static async create(title: string, billing: Billing, subtitle: string | null = null): Promise<Pdf> {
    const p = new Pdf(title, billing, subtitle);
    p.doc = await PDFDocument.create();
    p.doc.setTitle(safe(`${title}${subtitle ? ` ${subtitle}` : ''}`));
    p.doc.setAuthor(safe(billing.legalName));
    p.doc.setCreator('Textile ops');
    p.font = await p.doc.embedFont(StandardFonts.Helvetica);
    p.bold = await p.doc.embedFont(StandardFonts.HelveticaBold);
    p.addPage(true);
    return p;
  }

  fontOf(bold?: boolean) { return bold ? this.bold : this.font; }
  widthOf(s: string, size: number, bold?: boolean) { return this.fontOf(bold).widthOfTextAtSize(safe(s), size); }

  /** First page: full letterhead. Later pages: one compact line. */
  addPage(first = false) {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - M;
    const b = this.billing;
    if (first) {
      this.text(b.legalName, M, this.y - 14, { size: 16, bold: true });
      this.text(this.title, PAGE_W - M, this.y - 12, { size: 13, bold: true, align: 'right' });
      if (this.subtitle) this.text(this.subtitle, PAGE_W - M, this.y - 26, { size: 8.5, color: GREY, align: 'right' });
      this.y -= 22;
      const addr = [b.address, [b.gstin ? `GSTIN: ${b.gstin}` : null, b.phone ? `Phone: ${b.phone}` : null].filter(Boolean).join('   ·   ')].filter(Boolean) as string[];
      for (const line of addr) for (const w of this.wrap(line, CONTENT_W * 0.62, 9)) { this.text(w, M, this.y - 9, { size: 9, color: GREY }); this.y -= 12; }
      this.y -= 6;
    } else {
      this.text(b.legalName, M, this.y - 10, { size: 10, bold: true });
      this.text(`${this.title}${this.subtitle ? ` · ${this.subtitle}` : ''} (continued)`, PAGE_W - M, this.y - 10, { size: 9, color: GREY, align: 'right' });
      this.y -= 18;
    }
    this.hline(this.y, M, PAGE_W - M, 1);
    this.y -= 12;
  }

  get bottom() { return M + FOOTER_H; }

  /** Start a new page unless h points still fit. */
  ensure(h: number): boolean {
    if (this.y - h < this.bottom) { this.addPage(); return true; }
    return false;
  }

  text(s: unknown, x: number, y: number, o: TextOpts = {}) {
    const size = o.size ?? 10;
    const f = this.fontOf(o.bold);
    let str = safe(s).replace(/\n/g, ' ');
    if (o.width) str = this.fit(str, o.width, size, o.bold);
    const w = f.widthOfTextAtSize(str, size);
    const dx = o.align === 'right' ? -w : o.align === 'center' ? -w / 2 : 0;
    this.page.drawText(str, { x: x + dx, y, size, font: f, color: o.color ?? INK });
  }

  /** Cut text to a width with "...". */
  fit(s: string, width: number, size: number, bold?: boolean): string {
    const f = this.fontOf(bold);
    if (f.widthOfTextAtSize(s, size) <= width) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (f.widthOfTextAtSize(`${s.slice(0, mid)}...`, size) <= width) lo = mid; else hi = mid - 1;
    }
    return `${s.slice(0, lo)}...`;
  }

  wrap(s: unknown, width: number, size: number, bold?: boolean): string[] {
    const f = this.fontOf(bold);
    const out: string[] = [];
    for (const para of safe(s).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(t, size) <= width) { line = t; continue; }
        if (line) out.push(line);
        line = f.widthOfTextAtSize(word, size) <= width ? word : this.fit(word, width, size, bold);
      }
      out.push(line);
    }
    return out;
  }

  /** Wrapped paragraph at the cursor. */
  para(s: unknown, o: TextOpts & { x?: number; gap?: number } = {}) {
    const size = o.size ?? 10;
    const x = o.x ?? M;
    const width = o.width ?? CONTENT_W;
    for (const line of this.wrap(s, width, size, o.bold)) {
      this.ensure(size + 4);
      this.text(line, x, this.y - size, { size, bold: o.bold, color: o.color });
      this.y -= size + (o.gap ?? 3);
    }
  }

  hline(y: number, x1: number, x2: number, thickness = 0.6, color = LINE) {
    this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  }

  box(x: number, yTop: number, w: number, h: number, fill?: RGB) {
    this.page.drawRectangle({ x, y: yTop - h, width: w, height: h, borderColor: LINE, borderWidth: 0.6, color: fill });
  }

  /** Label/value pairs in a bordered box; returns the height used. Moves the cursor below the box. */
  infoBoxes(boxes: { title: string; lines: (string | [string, string])[] }[], gap = 10) {
    const w = (CONTENT_W - gap * (boxes.length - 1)) / boxes.length;
    const size = 9;
    const lw = 70;
    const rendered = boxes.map((b) => {
      // In a box that has label/value rows, a leading plain line is its heading (e.g. the party name): bold.
      const headed = b.lines.some(Array.isArray) && !Array.isArray(b.lines[0]);
      const rows: { label?: string; text: string; bold?: boolean }[] = [];
      b.lines.forEach((l, li) => {
        if (Array.isArray(l)) {
          this.wrap(l[1] || '—', w - 16 - lw, size).forEach((p, i) => rows.push({ label: i === 0 ? l[0] : '', text: p }));
        } else {
          const bold = headed && li === 0;
          this.wrap(l, w - 16, size, bold).forEach((p) => rows.push({ text: p, bold }));
        }
      });
      return { title: b.title, rows };
    });
    const h = 22 + Math.max(...rendered.map((r) => r.rows.length)) * 12 + 6;
    this.ensure(h + 6);
    const top = this.y;
    rendered.forEach((r, i) => {
      const x = M + i * (w + gap);
      this.box(x, top, w, h);
      this.text(r.title.toUpperCase(), x + 8, top - 14, { size: 7.5, bold: true, color: GREY });
      r.rows.forEach((row, j) => {
        const yy = top - 28 - j * 12;
        if (row.label !== undefined) {
          this.text(row.label, x + 8, yy, { size, color: GREY });
          this.text(row.text, x + 8 + lw, yy, { size });
        } else this.text(row.text, x + 8, yy, { size, bold: row.bold });
      });
    });
    this.y = top - h - 12;
  }

  /** Table with a repeated header row on every page. Cells wrap up to 3 lines. */
  table(cols: Col[], rows: { cells: string[]; bold?: boolean; fill?: RGB }[], o: { size?: number } = {}) {
    const size = o.size ?? 9;
    const pad = 5;
    const scale = CONTENT_W / cols.reduce((s, c) => s + c.width, 0);
    const widths = cols.map((c) => c.width * scale);
    const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const lineH = size + 3;
    const drawHeader = () => {
      const h = lineH + 2 * pad;
      this.page.drawRectangle({ x: M, y: this.y - h, width: CONTENT_W, height: h, color: FILL });
      cols.forEach((c, i) => {
        const x = c.align === 'right' ? xs[i] + widths[i] - pad : c.align === 'center' ? xs[i] + widths[i] / 2 : xs[i] + pad;
        this.text(c.label, x, this.y - pad - size + 1, { size, bold: true, align: c.align, width: widths[i] - 2 * pad });
      });
      this.y -= h;
      this.hline(this.y, M, PAGE_W - M, 0.8, GREY);
    };
    this.ensure(lineH * 3 + 4 * pad);
    drawHeader();
    for (const r of rows) {
      const cellLines = r.cells.map((c, i) => this.wrap(c ?? '', widths[i] - 2 * pad, size, r.bold).slice(0, 3));
      const h = Math.max(1, ...cellLines.map((l) => l.length)) * lineH + 2 * pad - 2;
      if (this.ensure(h)) drawHeader();
      if (r.fill) this.page.drawRectangle({ x: M, y: this.y - h, width: CONTENT_W, height: h, color: r.fill });
      cellLines.forEach((lines, i) => {
        const c = cols[i];
        const x = c.align === 'right' ? xs[i] + widths[i] - pad : c.align === 'center' ? xs[i] + widths[i] / 2 : xs[i] + pad;
        lines.forEach((l, j) => this.text(l, x, this.y - pad - size + 1 - j * lineH, { size, bold: r.bold, align: c.align }));
      });
      this.y -= h;
      this.hline(this.y, M, PAGE_W - M);
    }
    this.y -= 10;
  }

  /** Right-aligned label: value rows (totals). */
  totals(rows: { label: string; value: string; bold?: boolean; size?: number }[], width = 240) {
    const x2 = PAGE_W - M;
    const x1 = x2 - width;
    for (const r of rows) {
      const size = r.size ?? 10;
      this.ensure(size + 8);
      this.text(r.label, x1, this.y - size, { size, bold: r.bold, color: r.bold ? INK : GREY });
      this.text(r.value, x2, this.y - size, { size, bold: r.bold, align: 'right' });
      this.y -= size + 7;
    }
    this.y -= 4;
  }

  /** Signature boxes side by side at the cursor. */
  signatures(labels: string[], h = 64) {
    this.ensure(h + 10);
    const gap = 20;
    const w = (CONTENT_W - gap * (labels.length - 1)) / labels.length;
    const top = this.y;
    labels.forEach((l, i) => {
      const x = M + i * (w + gap);
      this.box(x, top, w, h);
      this.text(l, x + 8, top - h + 8, { size: 8.5, color: GREY, width: w - 16 });
    });
    this.y = top - h - 10;
  }

  stamp(text: string) {
    for (const p of this.doc.getPages()) {
      p.drawText(safe(text), { x: 150, y: 380, size: 64, font: this.bold, color: RED, opacity: 0.18, rotate: degrees(30) });
    }
  }

  async save(): Promise<Uint8Array> {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: M + 16 }, end: { x: PAGE_W - M, y: M + 16 }, thickness: 0.5, color: LINE });
      p.drawText(safe(`${this.billing.legalName} · ${this.title}${this.subtitle ? ` ${this.subtitle}` : ''}`), { x: M, y: M + 4, size: 7.5, font: this.font, color: GREY });
      const t = `Page ${i + 1} of ${pages.length}`;
      p.drawText(t, { x: PAGE_W - M - this.font.widthOfTextAtSize(t, 7.5), y: M + 4, size: 7.5, font: this.font, color: GREY });
    });
    return this.doc.save();
  }
}
