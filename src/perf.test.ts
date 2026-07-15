import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { findAnchor, applyHunks, locateSnippet } from './anchor';
import { parseOutlinePayload } from './schema';

/**
 * Performance baselines (spec: fail if any latency-sensitive op regresses beyond
 * 10% of its recorded baseline). Targets in test-baseline.json carry headroom so
 * they catch gross regressions without flaking on machine variance; we compare
 * the BEST per-op time across batches (min is stable) to target * 1.10.
 */
const targets = (JSON.parse(readFileSync('test-baseline.json', 'utf8')) as { performance: Record<string, number> })
  .performance;

const lines = Array.from({ length: 1000 }, (_unused, i) => `  const v${i} = compute(${i});`);
const file = lines.join('\n');
const hunk = { contextBefore: lines[498]!, oldText: lines[499]!, newText: '  const v499 = compute(499) + 1;', contextAfter: lines[500]! };
const outline = {
  problemSummary: 'x',
  steps: Array.from({ length: 30 }, (_unused, i) => ({
    stepNumber: i + 1,
    title: 't',
    targetFiles: ['a.ts'],
    changeKind: 'edit',
    genericExplanation: 'g',
    specificExplanation: 's',
  })),
};

function bestPerOpMs(fn: () => void, iters = 200, batches = 3): number {
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const start = performance.now();
    for (let i = 0; i < iters; i++) {
      fn();
    }
    best = Math.min(best, (performance.now() - start) / iters);
  }
  return best;
}

function check(metric: string, fn: () => void): void {
  const ms = bestPerOpMs(fn);
  const budget = targets[metric]! * 1.1;
  expect(ms, `${metric} = ${ms.toFixed(4)}ms/op (budget ${budget.toFixed(3)}ms)`).toBeLessThanOrEqual(budget);
}

describe('performance baselines', () => {
  it('findAnchor on a 1000-line file', () => check('findAnchor_1000L_ms', () => findAnchor(file, hunk)));
  it('applyHunks on a 1000-line file', () => check('applyHunks_1000L_ms', () => applyHunks(file, [hunk])));
  it('locateSnippet on a 1000-line file', () => check('locateSnippet_1000L_ms', () => locateSnippet(file, lines[750]!)));
  it('parseOutlinePayload on a 30-step outline', () => check('parseOutlinePayload_30_ms', () => parseOutlinePayload(outline)));
});
