import { describe, expect, it } from 'vitest';
import { wilson } from '../src/aggregate/stats.js';
import { CSS_PALETTE, LIGHT_PALETTE, ciBars, dotPlot, esc, funnel, pct, stackedBars } from '../src/report/svg.js';

describe('svg primitives', () => {
  it('formats and escapes', () => {
    expect(pct(0.12345)).toBe('12.3%');
    expect(esc('<a & b>')).toBe('&lt;a &amp; b&gt;');
  });

  it('draws CI bars with whiskers, labels and values', () => {
    const svg = ciBars([{ label: 'Agents', value: wilson(30, 100), color: CSS_PALETTE.agent }, { label: 'Humans <x>', value: wilson(50, 100), color: CSS_PALETTE.human }], CSS_PALETTE, { title: 'Proof rate' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('<title>Proof rate</title>');
    expect(svg).toContain('30.0%');
    expect(svg).toContain('Humans &lt;x&gt;');
    expect(svg.match(/class="whisker"/g)!.length).toBe(2);
    expect(svg).toBe(ciBars([{ label: 'Agents', value: wilson(30, 100), color: CSS_PALETTE.agent }, { label: 'Humans <x>', value: wilson(50, 100), color: CSS_PALETTE.human }], CSS_PALETTE, { title: 'Proof rate' }));
  });

  it('draws a dot plot with dimmed rows and empty cells', () => {
    const svg = dotPlot([{ label: 'copilot', dimmed: false }, { label: 'jules', dimmed: true }], ['proof-gap', 'escapes'],
      [[wilson(1, 10), wilson(2, 10)], [null, wilson(1, 2)]], LIGHT_PALETTE, () => LIGHT_PALETTE.agent);
    expect(svg.match(/<circle/g)!.length).toBe(3);
    expect(svg).toContain('opacity="0.35"');
  });

  it('shows n=0 rows as "n=0" with no bar or whisker', () => {
    const svg = ciBars([{ label: 'Agents', value: wilson(3, 10), color: '#00f' }, { label: 'Humans', value: wilson(0, 0), color: '#f00' }], LIGHT_PALETTE);
    expect(svg.match(/class="whisker"/g)!.length).toBe(1);
    expect(svg.match(/fill="#f00"/g)).toBeNull();
    expect(svg).toContain('>n=0<');
    expect(svg).not.toContain('>0.0%<');
  });

  it('leaves n=0 dot-plot cells empty', () => {
    const svg = dotPlot([{ label: 'a', dimmed: false }], ['x', 'y'], [[wilson(1, 2), wilson(0, 0)]], LIGHT_PALETTE, () => '#00f');
    expect(svg.match(/<circle/g)!.length).toBe(1);
  });

  it('draws a funnel and stacked bars', () => {
    expect(funnel([{ label: 'Selected', count: 800 }, { label: 'Ran', count: 420 }], CSS_PALETTE)).toContain('420');
    const s = stackedBars([{ label: 'proof-gap', parts: [{ name: 'real', value: 8, color: CSS_PALETTE.real }, { name: 'false', value: 2, color: CSS_PALETTE.false }] }], CSS_PALETTE);
    expect(s.match(/<rect class="part"/g)!.length).toBe(2);
  });
});

describe('long labels', () => {
  const long = 'Test passes without the change';
  it('wraps long dot-plot column headers onto separate lines', () => {
    const svg = dotPlot([{ label: 'copilot', dimmed: false }], [long], [[null]], CSS_PALETTE, () => '#000');
    expect(svg.match(/<tspan/g)!.length).toBeGreaterThan(1);
    expect(svg).toContain('Test passes');
  });
  it('leaves room for the longest family name in stacked bars', () => {
    const svg = stackedBars([{ label: long, parts: [{ name: 'real', value: 1, color: '#000' }] }], CSS_PALETTE);
    expect(Number(svg.match(/class="part" x="([\d.]+)"/)![1])).toBeGreaterThanOrEqual(220);
  });
});
