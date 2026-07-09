import * as vscode from 'vscode';
import * as assert from 'node:assert';
import type { JustInTimeApi, ProviderFactory } from '../../../src/extension';
import type { PlanProvider } from '../../../src/plan-source';
import type { WalkthroughOutline, HydratedStep, OutlineStep } from '../../../src/types';

/**
 * E2E entry point, run INSIDE the VS Code extension host by @vscode/test-electron.
 * Injects a fake PlanProvider (no network/API key), runs a scripted walkthrough
 * on the fixture workspace, and asserts the REAL editor bridge + rollback store
 * apply and revert an edit on disk.
 */

const decoder = new TextDecoder();

const fakeProvider: PlanProvider = {
  async produceOutline(): Promise<WalkthroughOutline> {
    return {
      sessionId: 'e2e-session',
      problemSummary: 'Multiply price by quantity.',
      steps: [
        {
          stepNumber: 1,
          title: 'Scale price by quantity',
          targetFiles: ['sample.ts'],
          dependsOn: [],
          changeKind: 'edit',
          genericExplanation: 'Multiplying unit price by quantity computes a line total.',
          specificExplanation: 'checkout() currently adds the unit price, ignoring quantity.',
        },
      ],
    };
  },
  async hydrateStep(step: OutlineStep): Promise<HydratedStep> {
    return {
      stepNumber: step.stepNumber,
      primaryFile: 'sample.ts',
      changeKind: 'edit',
      hunks: [
        {
          contextBefore: 'export function checkout() {',
          oldText: '  cart.total += item.price;',
          newText: '  cart.total += item.price * qty;',
          contextAfter: '  return cart;',
        },
      ],
      navigation: { file: 'sample.ts', startLine: 2, endLine: 2 },
      hazards: [],
    };
  },
};

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<JustInTimeApi>('pranaaviyer.justintime');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();

  api.setProviderFactory((() => fakeProvider) as ProviderFactory);

  const wsFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(wsFolder, 'no workspace folder open');
  const fileUri = vscode.Uri.joinPath(wsFolder.uri, 'sample.ts');
  const original = decoder.decode(await vscode.workspace.fs.readFile(fileUri));
  assert.ok(!original.includes('* qty'), 'precondition: fixture is unmodified');

  await api.start('scale price by quantity');
  await waitFor(() => api.getState()?.phase === 'waiting_for_apply');

  await api.apply();
  await waitFor(() => api.getState()?.status === 'completed');

  const applied = decoder.decode(await vscode.workspace.fs.readFile(fileUri));
  assert.ok(applied.includes('cart.total += item.price * qty;'), 'edit was applied to disk');

  const result = await api.revertAll();
  assert.ok(result.restored >= 1, 'revert restored at least one file');
  const reverted = decoder.decode(await vscode.workspace.fs.readFile(fileUri));
  assert.strictEqual(reverted, original, 'file restored to original content');

  // Leave the fixture pristine for reruns.
  await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(original));
}
