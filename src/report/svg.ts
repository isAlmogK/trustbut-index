import type { RateCI } from '../aggregate/stats.js';

export interface Palette {
  bg: string;
  fg: string;
  muted: string;
  grid: string;
  agent: string;
  human: string;
  real: string;
  benign: string;
  false: string;
  pass: string;
  miss: string;
}

export const CSS_PALETTE: Palette = {
  bg: 'var(--bg)', fg: 'var(--fg)', muted: 'var(--muted)', grid: 'var(--grid)', agent: 'var(--agent)', human: 'var(--human)',
  real: 'var(--real)', benign: 'var(--benign)', false: 'var(--false)', pass: 'var(--pass)', miss: 'var(--miss)',
};
export const LIGHT_PALETTE: Palette = {
  bg: '#ffffff', fg: '#1a1a1a', muted: '#6b6b6b', grid: '#e4e4e4', agent: '#2457d6', human: '#b5651d',
  real: '#2e7d32', benign: '#9e9e9e', false: '#c62828', pass: '#2e7d32', miss: '#c62828',
};

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
/** Greedy word wrap, at most `max` characters per line (a single longer word stays whole). */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  for (const w of text.split(' ')) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + w.length <= max) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function frame(width: number, height: number, title: string, body: string, pal: Palette): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" role="img" font-family="system-ui, sans-serif" font-size="13" fill="${pal.fg}"><title>${esc(title)}</title>${body}</svg>`;
}

/** Horizontal bars (0–100%) with a 95% interval whisker per row. */
export function ciBars(rows: { label: string; value: RateCI; color: string }[], pal: Palette, opts: { width?: number; title?: string } = {}): string {
  const width = opts.width ?? 640, left = 140, right = 70, rowH = 34, top = 10;
  const plot = width - left - right;
  const x = (v: number) => r1(left + v * plot);
  const height = top + rows.length * rowH + 24;
  let body = [0, 0.25, 0.5, 0.75, 1].map((t) =>
    `<line x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${height - 20}" stroke="${pal.grid}"/><text x="${x(t)}" y="${height - 6}" text-anchor="middle" fill="${pal.muted}" font-size="11">${t * 100}%</text>`).join('');
  rows.forEach((row, i) => {
    const y = top + i * rowH, mid = y + rowH / 2;
    body += `<text x="${left - 8}" y="${mid + 4}" text-anchor="end">${esc(row.label)}</text>`;
    if (row.value.n === 0) {
      // No data is not a measured 0%: no bar, no whisker.
      body += `<text x="${width - right + 8}" y="${mid + 4}" fill="${pal.muted}">n=0</text>`;
      return;
    }
    body += `<rect x="${left}" y="${y + 8}" width="${r1(row.value.p * plot)}" height="${rowH - 16}" fill="${row.color}" rx="2"/>`;
    body += `<g class="whisker" stroke="${pal.fg}"><line x1="${x(row.value.lo)}" x2="${x(row.value.hi)}" y1="${mid}" y2="${mid}"/><line x1="${x(row.value.lo)}" x2="${x(row.value.lo)}" y1="${mid - 5}" y2="${mid + 5}"/><line x1="${x(row.value.hi)}" x2="${x(row.value.hi)}" y1="${mid - 5}" y2="${mid + 5}"/></g>`;
    body += `<text x="${width - right + 8}" y="${mid + 4}">${pct(row.value.p)}</text>`;
  });
  return frame(width, height, opts.title ?? 'Rates with 95% intervals', body, pal);
}

/** Rows × columns of rates: a dot at the estimate with an interval line, per cell. */
/** A cell with a dot and interval, nothing (null or n=0), or the words "not measured". */
export type DotCell = RateCI | null | 'not-measured';

export function dotPlot(rows: { label: string; dimmed: boolean }[], cols: string[], cells: DotCell[][], pal: Palette, color: (row: number) => string): string {
  const left = 120, colW = 130, rowH = 30, top = 48;
  const width = left + cols.length * colW + 10, height = top + rows.length * rowH + 10;
  let body = cols.map((c, j) => `<text x="${left + j * colW + colW / 2}" y="16" text-anchor="middle" fill="${pal.muted}">${wrap(c, 18).map((ln, k) => `<tspan x="${left + j * colW + colW / 2}" dy="${k ? 16 : 0}">${esc(ln)}</tspan>`).join('')}</text>`).join('');
  rows.forEach((row, i) => {
    const y = top + i * rowH + rowH / 2;
    body += `<g${row.dimmed ? ' opacity="0.35"' : ''}><text x="${left - 8}" y="${y + 4}" text-anchor="end">${esc(row.label)}</text>`;
    cols.forEach((_, j) => {
      const c = cells[i]?.[j];
      const x0 = left + j * colW + 10, w = colW - 20;
      if (c === 'not-measured') {
        body += `<text x="${x0 + w / 2}" y="${y + 4}" text-anchor="middle" fill="${pal.muted}">not measured</text>`;
        return;
      }
      body += `<line x1="${x0}" x2="${x0 + w}" y1="${y}" y2="${y}" stroke="${pal.grid}"/>`;
      if (!c || c.n === 0) return;
      body += `<line x1="${r1(x0 + c.lo * w)}" x2="${r1(x0 + c.hi * w)}" y1="${y}" y2="${y}" stroke="${color(i)}" stroke-width="2"/>`;
      body += `<circle cx="${r1(x0 + c.p * w)}" cy="${y}" r="4" fill="${color(i)}"><title>${esc(`${row.label} · ${cols[j]}: ${pct(c.p)} (${pct(c.lo)}–${pct(c.hi)}), n=${c.n}`)}</title></circle>`;
    });
    body += '</g>';
  });
  return frame(width, height, 'Findings by family and group', body, pal);
}

/** Decreasing bars, each labelled with its count and share of the first stage. */
export function funnel(stages: { label: string; count: number }[], pal: Palette): string {
  const width = 640, left = 160, rowH = 34, top = 6;
  const max = Math.max(1, stages[0]?.count ?? 1), plot = width - left - 120;
  let body = '';
  stages.forEach((s, i) => {
    const y = top + i * rowH;
    body += `<text x="${left - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(s.label)}</text>`;
    body += `<rect x="${left}" y="${y + 6}" width="${r1((s.count / max) * plot)}" height="${rowH - 12}" fill="${i === stages.length - 1 ? pal.agent : pal.grid}" rx="2"/>`;
    body += `<text x="${left + r1((s.count / max) * plot) + 8}" y="${y + rowH / 2 + 4}">${s.count} (${pct(s.count / max)})</text>`;
  });
  return frame(width, top + stages.length * rowH + 6, 'Run coverage funnel', body, pal);
}

/** 100%-stacked horizontal bars, one per row. */
export function stackedBars(rows: { label: string; parts: { name: string; value: number; color: string }[] }[], pal: Palette): string {
  const width = 640, left = 220, rowH = 30, top = 6, plot = width - left - 20;
  let body = '';
  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const total = row.parts.reduce((a, p) => a + p.value, 0) || 1;
    body += `<text x="${left - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(row.label)}</text>`;
    let x = left;
    for (const p of row.parts) {
      const w = r1((p.value / total) * plot);
      body += `<rect class="part" x="${r1(x)}" y="${y + 5}" width="${w}" height="${rowH - 10}" fill="${p.color}"><title>${esc(`${row.label} · ${p.name}: ${p.value}`)}</title></rect>`;
      x += w;
    }
  });
  return frame(width, top + rows.length * rowH + 6, 'Label outcomes by family', body, pal);
}
