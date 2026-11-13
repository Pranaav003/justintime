import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Baseline ratchet: run the full suite, compare the passing count to
 * test-baseline.json. Fail if it dropped (a regression); ratchet the baseline
 * up if it grew. Perf regressions are enforced by src/perf.test.ts itself.
 */
// Returning with exitCode lets Node drain piped diagnostics before stopping.
function checkBaseline() {
  // Keep both streams even when Vitest exits unsuccessfully; inspecting a thrown
  // child-process Error truncates the JSON report and its assertion messages.
  const result = spawnSync('npx vitest run --reporter=json', {
    shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let json;
  try {
    const raw = result.stdout ?? '';
    json = JSON.parse(raw.slice(raw.indexOf('{')));
    if (!json || !Number.isSafeInteger(json.numPassedTests) || json.numPassedTests < 0
      || !Number.isSafeInteger(json.numFailedTests) || json.numFailedTests < 0
      || (json.testResults !== undefined && !Array.isArray(json.testResults))) {
      throw new Error('Invalid reporter shape');
    }
  } catch {
    console.error('FAIL: baseline runner did not return usable Vitest JSON.');
    if (result.stderr) console.error(result.stderr);
    if (result.error) console.error(result.error.message);
    process.exitCode = 1;
    return;
  }
  const passed = json.numPassedTests;
  const failed = json.numFailedTests;
  const suites = json.testResults ?? [];

  if (result.error || result.status !== 0 || result.signal || failed > 0
    || json.success === false || json.numFailedTestSuites > 0 || suites.some(suite => suite.status === 'failed')) {
    console.error(`FAIL: ${failed} test(s) failing.`);
    for (const suite of suites) {
      for (const assertion of suite.assertionResults ?? []) {
        if (assertion.status !== 'failed') continue;
        console.error(assertion.fullName || assertion.title || 'Unnamed failed assertion');
        for (const message of assertion.failureMessages ?? []) console.error(message);
      }
      if (suite.status === 'failed' && suite.message) {
        console.error(`${suite.name || 'Unnamed failed suite'}\n${suite.message}`);
      }
    }
    if (result.stderr) console.error(result.stderr);
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) console.error(`Vitest process failed (${result.status ?? result.signal ?? 'unknown exit'}).`);
    process.exitCode = 1;
    return;
  }
  const path = 'test-baseline.json';
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  if (passed < baseline.passingTests) {
    console.error(`REGRESSION: ${passed} passing < baseline ${baseline.passingTests}. A test was lost.`);
    process.exitCode = 1;
    return;
  }
  if (passed > baseline.passingTests) {
    baseline.passingTests = passed;
    writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`Baseline ratcheted up to ${passed} passing tests.`);
  } else {
    console.log(`Baseline held: ${passed} passing tests.`);
  }
}

checkBaseline();
