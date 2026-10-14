import { describe, expect, it } from 'vitest';
import type { GroupStats } from '../src/aggregate/index.js';
import { wilson } from '../src/aggregate/stats.js';
import { calibration, hitRate, labelStats } from '../src/label/metrics.js';
import type { FinalLabel } from '../src/label/review.js';
import type { SampleItem } from '../src/label/sample.js';
import type { Label } from '../src/types.js';

const item = (key: string, prId: string, group: 'agent' | 'human', family: SampleItem['family'], blind = false) =>
  ({ key, prId, group, family, blind }) as SampleItem;
const fin = (key: string, label: Label, draftLabel: Label | null, blind = false) => ({ key, label, draftLabel, blind }) as FinalLabel;

const sample = [
  item('a', 'p1', 'agent', 'proof-gap', true), item('b', 'p1', 'agent', 'escapes', true),
  item('c', 'p2', 'agent', 'proof-gap'), item('d', 'p3', 'agent', 'escapes'), item('e', 'p4', 'human', 'escapes'),
];
const finals = [fin('a', 'real', 'real', true), fin('b', 'false', 'real', true), fin('c', 'true-but-benign', 'true-but-benign'), fin('d', 'unclear', 'real'), fin('e', 'real', 'false')];

describe('labelStats', () => {
  it('computes precision and accuracy, excluding unclear', () => {
    const all = labelStats(sample, finals).find((s) => s.family === 'all' && s.group === 'all')!;
    expect(all).toMatchObject({ real: 2, benign: 1, false: 1, unclear: 1 });
    expect(all.precision).toMatchObject({ k: 2, n: 4 });
    expect(all.accuracy).toMatchObject({ k: 3, n: 4 });
    const pg = labelStats(sample, finals).find((s) => s.family === 'proof-gap' && s.group === 'agent')!;
    expect(pg.precision).toMatchObject({ k: 1, n: 2 });
  });
});

describe('calibration', () => {
  it('measures blind agreement and overrule rate', () => {
    const c = calibration(sample, finals, []);
    expect(c.blind).toMatchObject({ k: 1, n: 2 });
    expect(c.overruled).toMatchObject({ k: 2, n: 3 });
  });
});

describe('hitRate', () => {
  it('multiplies the counted-finding rate by the share of sampled agent PRs with a real label', () => {
    const allAgents = { anyCounted: wilson(40, 100) } as GroupStats;
    const h = hitRate(allAgents, sample, finals);
    expect(h.prsWithReal).toMatchObject({ k: 1, n: 3 });
    expect(h.p).toBeCloseTo(0.4 / 3, 6);
  });
});
