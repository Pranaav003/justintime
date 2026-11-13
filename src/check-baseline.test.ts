import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/check-baseline.mjs', import.meta.url));
const temporary: string[] = [];
const originalBaseline = '{ "passingTests": 5, "performance": { "metric": 0.5 }, "note": "keep" }\n';
const report = (passed = 5) => ({
  numPassedTests: passed, numFailedTests: 0, numFailedTestSuites: 0, success: true, testResults: [],
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function run(output: unknown, exit = 0, stderr = '', preface = '') {
  const cwd = mkdtempSync(join(tmpdir(), 'justintime baseline '));
  temporary.push(cwd);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  writeFileSync(join(cwd, 'test-baseline.json'), originalBaseline);
  writeFileSync(join(bin, 'fixture.json'), JSON.stringify({
    stdout: preface + (typeof output === 'string' ? output : JSON.stringify(output)), stderr, exit,
  }));
  const fixture = `const fs = require('node:fs');
const path = require('node:path');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
fs.writeFileSync('invocation.json', JSON.stringify(process.argv.slice(2)));
process.stdout.write(fixture.stdout);
process.stderr.write(fixture.stderr);
process.exitCode = fixture.exit;
`;
  writeFileSync(join(bin, 'fake-npx.cjs'), fixture);
  writeFileSync(join(bin, 'npx'), '#!/usr/bin/env node\n' + fixture, { mode: 0o755 });
  writeFileSync(join(bin, 'npx.cmd'), `@"${process.execPath}" "%~dp0fake-npx.cjs" %*\r\n`);
  const result = spawnSync(process.execPath, [script], {
    cwd, env: { ...process.env, PATH: bin + delimiter + (process.env.PATH ?? '') },
    encoding: 'utf8', timeout: 10_000, maxBuffer: 6 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(JSON.parse(readFileSync(join(cwd, 'invocation.json'), 'utf8')))
    .toEqual(['vitest', 'run', '--reporter=json']);
  return { ...result, baseline: readFileSync(join(cwd, 'test-baseline.json'), 'utf8') };
}

describe('baseline checker CLI', () => {
  it.each([40_000, 500_000])('preserves full assertion names and multiple %i-byte failure messages', length => {
    const message = 'failure start\n' + 'x'.repeat(length) + '\nFAILURE_TAIL';
    const result = run({ ...report(10), numFailedTests: 1, numFailedTestSuites: 1, success: false,
      testResults: [{ name: 'source.test.ts', status: 'failed', assertionResults: [
        { status: 'failed', fullName: 'suite exact assertion', failureMessages: [message, 'SECOND_MESSAGE'] },
      ] }],
    }, 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL: 1 test(s) failing.');
    expect(result.stderr).toContain('suite exact assertion');
    expect(result.stderr.includes('FAILURE_TAIL')).toBe(true);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain('SECOND_MESSAGE');
    expect(result.baseline).toBe(originalBaseline);
  });

  it('falls back to assertion titles when failure messages are absent', () => {
    const result = run({ ...report(10), numFailedTests: 1, success: false, testResults: [
      { status: 'failed', assertionResults: [{ status: 'failed', title: 'title-only failure', failureMessages: null }] },
    ] }, 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('title-only failure');
    expect(result.baseline).toBe(originalBaseline);
  });

  it.each([0, 1])('reports suite setup failures without failed assertions (exit %s)', exit => {
    const result = run({ ...report(10), numFailedTestSuites: 1, success: false, testResults: [
      { name: 'setup.test.ts', status: 'failed', message: 'Cannot load fixture dependency', assertionResults: [] },
    ] }, exit);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('setup.test.ts');
    expect(result.stderr).toContain('Cannot load fixture dependency');
    expect(result.baseline).toBe(originalBaseline);
  });

  it('rejects nonzero command status even when JSON counts look green', () => {
    const result = run(report(10), 2, 'runner setup failed');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('runner setup failed');
    expect(result.baseline).toBe(originalBaseline);
  });

  it.each(['', '{broken', 'null', '{}'])('reports unusable reporter output %j without ratcheting', output => {
    const result = run(output, 0, 'reporter diagnostic');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL: baseline runner did not return usable Vitest JSON.');
    expect(result.stderr).toContain('reporter diagnostic');
    expect(result.baseline).toBe(originalBaseline);
  });

  it('drains large captured stderr when reporter output is unusable', () => {
    const stderr = 'runner diagnostic\n' + 'x'.repeat(500_000) + '\nSTDERR_TAIL';
    const result = run('{broken', 0, stderr);
    expect(result.status).toBe(1);
    expect(result.stderr.includes('STDERR_TAIL')).toBe(true);
    expect(result.stderr).toContain(stderr);
    expect(result.baseline).toBe(originalBaseline);
  });

  it('fails without ratcheting when reporter output exceeds the capture buffer', () => {
    const result = run({ ...report(10), padding: 'x'.repeat(2 * 1024 * 1024) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL: baseline runner did not return usable Vitest JSON.');
    expect(result.baseline).toBe(originalBaseline);
  });

  it('keeps equal-count baseline bytes and accepts the existing output preface', () => {
    const result = run(report(), 0, '', 'Vitest reporter preface\n');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Baseline held: 5 passing tests.');
    expect(result.baseline).toBe(originalBaseline);
  });

  it('ratchets growth while retaining performance and unrelated metadata', () => {
    const result = run(report(6));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Baseline ratcheted up to 6 passing tests.');
    expect(JSON.parse(result.baseline)).toEqual({ passingTests: 6, performance: { metric: 0.5 }, note: 'keep' });
  });

  it('rejects reduced passing count without changing baseline bytes', () => {
    const result = run(report(4));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REGRESSION: 4 passing < baseline 5.');
    expect(result.baseline).toBe(originalBaseline);
  });
});
