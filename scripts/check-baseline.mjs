import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Baseline ratchet: run the full suite, compare the passing count to
 * test-baseline.json. Fail if it dropped (a regression); ratchet the baseline
 * up if it grew. Perf regressions are enforced by src/perf.test.ts itself.
 */
const raw = execSync('npx vitest run --reporter=json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const json = JSON.parse(raw.slice(raw.indexOf('{')));
const passed = json.numPassedTests ?? 0;
const failed = json.numFailedTests ?? 0;

const path = 'test-baseline.json';
const baseline = JSON.parse(readFileSync(path, 'utf8'));

if (failed > 0) {
  console.error(`FAIL: ${failed} test(s) failing.`);
  process.exit(1);
}
if (passed < baseline.passingTests) {
  console.error(`REGRESSION: ${passed} passing < baseline ${baseline.passingTests}. A test was lost.`);
  process.exit(1);
}
if (passed > baseline.passingTests) {
  baseline.passingTests = passed;
  writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`Baseline ratcheted up to ${passed} passing tests.`);
} else {
  console.log(`Baseline held: ${passed} passing tests.`);
}
