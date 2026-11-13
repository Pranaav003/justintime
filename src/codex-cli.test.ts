import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCodexCompletion, type CodexCompletionRequest } from './codex-cli';

// Wrap only the module namespace so cancellation can be injected at real async IO boundaries.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

let root: string;
let workspace: string;
let executable: string;
let record: string;
const schema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'jit-cli-test-'));
  workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  executable = path.join(root, 'codex');
  record = path.join(root, 'record.json');
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function fixture(body: string) {
  await fs.writeFile(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const cp = require('node:child_process'); const args = process.argv.slice(2); const output = args[args.indexOf('--output-last-message') + 1]; let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input += x); process.stdin.on('end', () => {\n${body}\n});\n`, { mode: 0o700 });
}
function request(extra: Partial<CodexCompletionRequest> = {}): CodexCompletionRequest {
  return { prompt: 'private source context', model: 'gpt-6-luna', schema, workspaceRoot: workspace, executable, timeoutMs: 3000, ...extra };
}
async function waitRecord() {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await fs.readFile(record, 'utf8')); } catch { await new Promise(r => setTimeout(r, 20)); }
  }
  throw new Error('Fixture did not start');
}

describe('native Codex completion transport', () => {
  it('uses stdin, private isolated cwd/schema, forced safe settings, and only returns final file', async () => {
    await fixture(`const schemaPath = args[args.indexOf('--output-schema') + 1]; fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input, cwd: process.cwd(), home: process.env.HOME, mode: fs.statSync(process.cwd()).mode & 511, schemaMode: fs.statSync(schemaPath).mode & 511, schema: JSON.parse(fs.readFileSync(schemaPath)), outputMode: fs.statSync(output).mode & 511 })); process.stdout.write('private thought'); process.stderr.write('private stderr'); fs.writeFileSync(output, '{"content":"done"}');`);
    const logs: string[] = [];
    expect(await runCodexCompletion(request({ log: (_level, message) => logs.push(message) }))).toBe('{"content":"done"}');
    const r = await waitRecord();
    expect(r.input).toBe('private source context');
    expect(r.cwd).not.toBe(workspace);
    expect(r.args.join(' ')).not.toContain(workspace);
    expect(r.args.join(' ')).not.toContain('private source context');
    expect(r.home).toBe(process.env.HOME);
    expect(r.mode).toBe(0o700);
    expect(r.schemaMode).toBe(0o600);
    expect(r.outputMode).toBe(0o600);
    expect(r.schema).toEqual(schema);
    for (const flag of ['exec', '--ignore-user-config', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only']) expect(r.args).toContain(flag);
    for (const setting of ['approval_policy="never"', 'forced_login_method="chatgpt"', 'model_reasoning_effort="medium"', 'project_doc_max_bytes=0', 'web_search="disabled"']) expect(r.args).toContain(setting);
    for (const feature of ['shell_tool', 'apps', 'plugins', 'hooks', 'skill_mcp_dependency_install', 'multi_agent', 'view_image', 'browser_use', 'computer_use', 'image_generation', 'code_mode_host']) expect(r.args.some((arg: string, i: number) => arg === '--disable' && r.args[i + 1] === feature)).toBe(true);
    expect(logs).toEqual([]);
    await expect(fs.stat(r.cwd)).rejects.toThrow();
  });
  it('runs env-node wrappers with a vetted interpreter and strips runtime injection', async () => {
    await fixture(`fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({path:process.env.PATH, nodeOptions:process.env.NODE_OPTIONS})); fs.writeFileSync(output, 'done');`);
    await fs.writeFile(executable, (await fs.readFile(executable, 'utf8')).replace(`#!${process.execPath}`, '#!/usr/bin/env node'));
    const oldPath = process.env.PATH;
    const oldOptions = process.env.NODE_OPTIONS;
    try {
      process.env.PATH = `${workspace}::.:/usr/bin:/bin`;
      process.env.NODE_OPTIONS = '--require=/nonexistent/unsafe.js';
      expect(await runCodexCompletion(request())).toBe('done');
      const r = await waitRecord();
      expect(r.path.split(path.delimiter)).not.toContain(workspace);
      expect(r.path.split(path.delimiter)).not.toContain('');
      expect(r.path.split(path.delimiter)).not.toContain('.');
      expect(r.nodeOptions).toBeUndefined();
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions;
    }
  });
  it('rejects workspace executables and symlink targets before spawning', async () => {
    const evil = path.join(workspace, 'codex');
    await fs.writeFile(evil, '#!/bin/sh\nexit 0', { mode: 0o700 });
    await expect(runCodexCompletion(request({ executable: evil }))).rejects.toThrow(/trusted|workspace/i);
    await fs.symlink(evil, executable);
    await expect(runCodexCompletion(request())).rejects.toThrow(/trusted|workspace/i);
    await expect(runCodexCompletion(request({ executable: './codex' }))).rejects.toThrow(/absolute/i);
    await expect(runCodexCompletion(request({ executable: '' }))).rejects.toThrow(/absolute|empty/i);
  });
  it('rejects final-message symlinks and oversized output and cleans temp directories', async () => {
    for (const body of [`fs.unlinkSync(output); fs.symlinkSync(${JSON.stringify(record)}, output);`, `fs.writeFileSync(output, 'x'.repeat(1048577));`]) {
      await fixture(`fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({cwd:process.cwd()})); ${body}`);
      await expect(runCodexCompletion(request())).rejects.toThrow(/output|final|message/i);
      await expect(fs.stat((await waitRecord()).cwd)).rejects.toThrow();
    }
  });
  it('does not expose stderr on failure and handles early stdin closure', async () => {
    await fs.writeFile(executable, `#!${process.execPath}\nprocess.stderr.write('secret-source-and-thought');process.exit(7);`, { mode: 0o700 });
    const logs: string[] = [];
    await expect(runCodexCompletion(request({ prompt: 'x'.repeat(2_000_000), log: (_level, m) => logs.push(m) }))).rejects.toThrow(/Codex.*7/);
    expect(logs).toEqual([]);
  });
  it('rejects a pre-aborted request without starting the child', async () => {
    await fixture(`fs.writeFileSync(${JSON.stringify(record)}, 'started');`);
    const abort = new AbortController(); abort.abort();
    await expect(runCodexCompletion(request({ signal: abort.signal }))).rejects.toThrow(/abort|cancel/i);
    await expect(fs.stat(record)).rejects.toThrow();
  });
  it('aborts and kills a running child and its descendants', async () => {
    await fixture(`const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:['ignore','inherit','inherit']}); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:child.pid,cwd:process.cwd()})); setInterval(()=>{},1000);`);
    const abort = new AbortController();
    const result = runCodexCompletion(request({ signal: abort.signal }));
    const rejection = expect(result).rejects.toThrow(/abort|cancel/i);
    const r = await waitRecord();
    abort.abort();
    await rejection;
    await expect(fs.stat(r.cwd)).rejects.toThrow();
    for (let i = 0; i < 100; i++) { try { process.kill(r.pid, 0); } catch { return; } await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Descendant survived cancellation');
  });
  it('returns the final message and kills descendants retaining pipes after leader exit', async () => {
    await fixture(`const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:['ignore','inherit','inherit']}); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:child.pid,cwd:process.cwd()})); fs.writeFileSync(output, 'done'); process.exit(0);`);
    expect(await runCodexCompletion(request({ timeoutMs: 250 }))).toBe('done');
    const r = await waitRecord();
    await expect(fs.stat(r.cwd)).rejects.toThrow();
    for (let i = 0; i < 100; i++) { try { process.kill(r.pid, 0); } catch { return; } await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error('Descendant survived leader exit');
  });
  it.each(['/tmp', '/private/tmp'])('refuses a temporary cwd within workspace %s before launching', async workspaceRoot => {
    await fixture(`fs.writeFileSync(${JSON.stringify(record)}, 'started'); fs.writeFileSync(output, 'done');`);
    await expect(runCodexCompletion(request({ workspaceRoot }))).rejects.toThrow(/temp.*workspace|workspace.*temp/i);
    await expect(fs.stat(record)).rejects.toThrow();
  });
  it.each([0, -1, NaN, Infinity])('refuses invalid timeout %s before launching', async timeoutMs => {
    await fixture(`fs.writeFileSync(${JSON.stringify(record)}, 'started'); fs.writeFileSync(output, 'done');`);
    await expect(runCodexCompletion(request({ timeoutMs }))).rejects.toThrow(/timeout.*positive|positive.*timeout/i);
    await expect(fs.stat(record)).rejects.toThrow();
  });
  it.each(['read', 'cleanup'])('honors cancellation during final %s before resolving', async phase => {
    await fixture(`fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({cwd:process.cwd()})); fs.writeFileSync(output, 'done');`);
    const abort = new AbortController();
    if (phase === 'cleanup') {
      const rm = fs.rm;
      vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
        if (String(target).startsWith('/tmp/justintime-codex-')) abort.abort();
        return rm(target, options);
      });
    } else {
      const open = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (String(args[0]).endsWith('/final.txt')) {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
            const result = await read(...readArgs);
            abort.abort();
            return result;
          });
        }
        return handle;
      });
    }
    await expect(runCodexCompletion(request({ signal: abort.signal }))).rejects.toThrow(/abort|cancel/i);
    await expect(fs.stat((await waitRecord()).cwd)).rejects.toThrow();
  });
  it('times out a running child and removes its temp directory', async () => {
    await fixture(`fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({cwd:process.cwd()})); setInterval(()=>{},1000);`);
    await expect(runCodexCompletion(request({ timeoutMs: 200 }))).rejects.toThrow(/timed out/i);
    await expect(fs.stat((await waitRecord()).cwd)).rejects.toThrow();
  });
});
