import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAgentProvider } from '../src/claude-bridge';
import { makeClaudeQuery } from '../src/sdk-adapter';
import { applyHunks } from '../src/anchor';

/**
 * Real-Claude smoke test of the provider layer (no VS Code). Creates a tiny
 * fixture with an obvious bug, asks the real SDK for an outline, hydrates the
 * first step, and verifies the returned hunks actually anchor to the file.
 */
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'jit-smoke-'));
  const rel = 'stats.ts';
  const content =
    'export function average(nums: number[]): number {\n' +
    '  let sum = 0;\n' +
    '  for (const n of nums) {\n' +
    '    sum += n;\n' +
    '  }\n' +
    '  return sum / nums.length;\n' +
    '}\n';
  writeFileSync(join(dir, rel), content);
  console.log('workspace:', dir);
  console.log('problem: guard average() against an empty array\n');

  // JIT_SMOKE_MODEL lets us exercise the provider's model-override path (needed
  // on restricted keys/gateways). Blank = the SDK/CLI default.
  const provider = new ClaudeAgentProvider(makeClaudeQuery(), {
    maxSteps: 3,
    model: process.env.JIT_SMOKE_MODEL || undefined,
    claudeExecutable: process.env.JIT_SMOKE_CLAUDE || undefined,
  });

  console.log('=== produceOutline (real Claude) ===');
  const t0 = Date.now();
  const outline = await provider.produceOutline(
    'Guard average() against an empty array so it returns 0 instead of NaN.',
    { workspaceRoot: dir },
  );
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log('sessionId:', outline.sessionId);
  console.log('summary:', outline.problemSummary);
  for (const s of outline.steps) {
    console.log(`  [${s.stepNumber}] ${s.title} (${s.changeKind}) -> ${s.targetFiles.join(', ')}`);
  }

  const step = outline.steps[0]!;
  console.log('\n=== hydrateStep(1) (real Claude) ===');
  const t1 = Date.now();
  const targetFile = step.targetFiles[0]!;
  const current: Record<string, string> = { [targetFile]: readFileSync(join(dir, targetFile), 'utf8') };
  const hydrated = await provider.hydrateStep(step, current, { sessionId: outline.sessionId });
  console.log(`(${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  console.log('primaryFile:', hydrated.primaryFile, '| changeKind:', hydrated.changeKind);
  console.log('navigation:', JSON.stringify(hydrated.navigation));
  for (const [i, h] of (hydrated.hunks ?? []).entries()) {
    console.log(`  hunk ${i}: old=${JSON.stringify(h.oldText)}  new=${JSON.stringify(h.newText)}`);
  }

  if (hydrated.changeKind === 'edit') {
    const before = current[hydrated.primaryFile] ?? '';
    const res = applyHunks(before, hydrated.hunks ?? []);
    console.log('\n=== anchor verification ===');
    console.log('applyHunks status:', res.status);
    if (res.status === 'ok') {
      console.log('--- resulting file ---\n' + res.text);
      console.log('SMOKE OK: outline + hydration + anchoring all succeeded.');
    } else {
      console.log('ANCHOR FAILED:', JSON.stringify(res));
      process.exit(2);
    }
  } else {
    console.log('SMOKE OK (non-edit step):', hydrated.changeKind);
  }
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
