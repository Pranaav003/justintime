import * as vscode from 'vscode';
import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EditorBridge } from '../../../src/editor-bridge';
import type { JustInTimeApi, ProviderFactory } from '../../../src/extension';
import type { PlanProvider, RepoContext } from '../../../src/plan-source';
import type { WalkthroughOutline, HydratedStep, OutlineStep } from '../../../src/types';

/**
 * E2E entry point, run INSIDE the VS Code extension host by @vscode/test-electron.
 * Injects a fake PlanProvider (no network/API key), runs a scripted walkthrough
 * on the fixture workspace, and asserts the REAL editor bridge + rollback store
 * apply and revert an edit on disk.
 */

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const fakeProvider: PlanProvider = {
  async produceOutline(_problem: string, ctx: RepoContext): Promise<WalkthroughOutline> {
    if ((ctx.mode ?? 'solve') === 'explain') {
      return {
        sessionId: 'e2e-explain',
        problemSummary: 'How checkout totals the cart.',
        mode: 'explain',
        steps: [
          {
            stepNumber: 1,
            title: 'checkout accumulates item price',
            targetFiles: ['sample.ts'],
            dependsOn: [],
            changeKind: 'edit',
            genericExplanation: 'Accumulator pattern.',
            specificExplanation: 'checkout() adds each item price into cart.total.',
            focus: { file: 'sample.ts', startLine: 2, endLine: 2, anchor: '  cart.total += item.price;' },
          },
        ],
      };
    }
    return {
      sessionId: 'e2e-session',
      problemSummary: 'Multiply price by quantity.',
      mode: 'solve',
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

async function waitFor(predicate: () => boolean, label = 'condition', timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function editProvider(file: string, before: string, after: string): PlanProvider {
  return {
    async produceOutline(_problem, ctx) {
      assert.ok(ctx.repoMap?.includes('sample.ts'), 'first root is enumerated');
      assert.ok(!ctx.repoMap?.includes('secondary-only.ts'), 'second root never leaks into repo map');
      assert.ok((ctx.repoMap?.length ?? 0) <= 600, 'repo map remains bounded');
      assert.ok(!ctx.repoMap?.some(f => f.startsWith('outside-link/')), 'outside symlinks excluded');
      return { sessionId: 'host', problemSummary: 'host edit', mode: 'solve', steps: [{
        stepNumber: 1, title: 'Host edit', targetFiles: [file], dependsOn: [], changeKind: 'edit',
        genericExplanation: 'Edit', specificExplanation: 'Test',
      }] };
    },
    async hydrateStep() {
      return { stepNumber: 1, primaryFile: file, changeKind: 'edit',
        hunks: [{ contextBefore: '', oldText: before, newText: after, contextAfter: '' }],
        navigation: { file, startLine: 1, endLine: 1 }, hazards: [] };
    },
  };
}

async function closePanels(api: JustInTimeApi): Promise<void> {
  const panels = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input instanceof vscode.TabInputWebview);
  await vscode.window.tabGroups.close(panels);
  await waitFor(() => api.getState() === undefined, 'panel disposal');
}

async function setBuffer(uri: vscode.Uri, text: string): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  assert.ok(await vscode.workspace.applyEdit(edit), 'dirty buffer edit applied');
  return doc;
}

async function apply(api: JustInTimeApi, provider: PlanProvider): Promise<void> {
  api.setProviderFactory(() => provider);
  await api.start('host regression');
  assert.strictEqual(api.getState()?.phase, 'waiting_for_apply');
  await api.apply();
  assert.strictEqual(api.getState()?.status, 'completed');
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<JustInTimeApi>('pranaaviyer.justintime');
  assert.ok(ext, 'extension not found');
  const api = await ext.activate();
  const first = process.env.JIT_E2E_FIRST_ROOT!;
  const second = process.env.JIT_E2E_SECOND_ROOT!;
  const temp = process.env.JIT_E2E_TEMP_DIR!;
  assert.strictEqual(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, first);
  const fileUri = vscode.Uri.file(path.join(first, 'sample.ts'));
  const read = (file: string) => fs.readFile(path.join(first, file), 'utf8');
  const expectedFile = path.join(temp, 'expected.json');

  if (process.env.JIT_E2E_PHASE === 'recover') {
    const expected = JSON.parse(await fs.readFile(expectedFile, 'utf8')) as Record<string, string>;
    assert.strictEqual(api.getState(), undefined, 'fresh host has no panel');
    assert.ok((await read('sample.ts')).includes('* qty * 2'), 'activation never automatically reverts');
    assert.strictEqual(await read('dirty.ts'), 'generated dirty two\n', 'dirty edit survives process restart');
    assert.strictEqual(await fs.readFile(path.join(temp, 'outside/target.ts'), 'utf8'), 'outside sentinel\n');
    // The actual registered command must discover the journal without starting a provider.
    await vscode.commands.executeCommand('justintime.revertAll');
    assert.strictEqual(await read('sample.ts'), expected.sample);
    assert.strictEqual(await read('dirty.ts'), expected.dirty);
    assert.strictEqual(await fs.readFile(path.join(temp, 'outside/target.ts'), 'utf8'), 'outside sentinel\n', 'unsafe recovery does not write outside');
    assert.strictEqual(await fs.readFile(path.join(first, 'saved-sub/target.ts'), 'utf8'), 'generated sub\n', 'failed target remains pending');
    await fs.unlink(path.join(first, 'sub'));
    await fs.rename(path.join(first, 'saved-sub'), path.join(first, 'sub'));
    const retried = await api.revertAll();
    assert.strictEqual(retried.errors.length, 0);
    assert.strictEqual(retried.restored, 1, 'only failed entry remains for retry');
    assert.strictEqual(await read('sub/target.ts'), 'original sub\n');
    const noop = await api.revertAll();
    assert.deepStrictEqual(noop, { restored: 0, deleted: 0, errors: [] });
    assert.strictEqual(await fs.readFile(path.join(second, 'sample.ts'), 'utf8'), expected.sample);
    console.log('PASS fresh-host command recovery, first-touch/dirty baselines, persistent containment retry');
    return;
  }

  const original = await read('sample.ts');
  assert.ok(!original.includes('* qty'));
  // Overfill only the second root: selecting the first root must still find its files.
  await Promise.all(Array.from({ length: 605 }, (_, i) => fs.writeFile(path.join(second, `other-${i}.ts`), 'secondary sentinel')));
  const bridge = new EditorBridge(first, { highlightColor: 'rgba(1,2,3,0.1)', secondaryHighlightColor: 'rgba(1,2,3,0.1)' });
  try {
    const files = await bridge.listFiles();
    assert.ok(files.includes('sample.ts'));
    assert.ok(!files.includes('secondary-only.ts'));
    assert.ok(!files.some(f => f.startsWith('other-')));
    assert.match(await bridge.searchCode('secondary sentinel'), /^\(no matches/);
    await fs.mkdir(path.join(temp, 'outside'));
    await fs.writeFile(path.join(temp, 'outside/target.ts'), 'outside sentinel\n');
    await fs.symlink(path.join(temp, 'outside'), path.join(first, 'outside-link'));
    const bad = ['../second-root/secondary-only.ts', path.join(second, 'secondary-only.ts'), 'outside-link/target.ts'];
    for (const file of bad) {
      await assert.rejects(() => bridge.readFile(file));
      await assert.rejects(() => bridge.navigateTo(file, 1, 1));
      for (const changeKind of ['edit', 'create', 'delete', 'rename'] as const) {
        const result = await bridge.applyStep({ stepNumber: 1, primaryFile: file, changeKind,
          fullFileContent: 'unsafe', renameTo: 'safe-destination.ts',
          hunks: [{ contextBefore: '', oldText: 'outside sentinel', newText: 'unsafe', contextAfter: '' }],
          navigation: { file, startLine: 1, endLine: 1 }, hazards: [] });
        assert.notStrictEqual(result.status, 'applied', `${changeKind} rejects ${file}`);
      }
      const rename = await bridge.applyStep({ stepNumber: 1, primaryFile: 'sample.ts', changeKind: 'rename', renameTo: file,
        navigation: { file: 'sample.ts', startLine: 1, endLine: 1 }, hazards: [] });
      assert.notStrictEqual(rename.status, 'applied', 'rename destination is contained');
    }
    assert.ok(!vscode.workspace.textDocuments.some(d => d.uri.fsPath === path.join(temp, 'outside/target.ts')), 'outside document never opened');
    assert.strictEqual(await fs.readFile(path.join(temp, 'outside/target.ts'), 'utf8'), 'outside sentinel\n');
    assert.strictEqual(await read('sample.ts'), original);
    assert.strictEqual(await bridge.readFile('new/deep/file.ts'), undefined);
    await bridge.navigateTo('new/deep/file.ts', 1, 1);
    const created = await bridge.applyStep({ stepNumber: 1, primaryFile: 'new/deep/file.ts', changeKind: 'create',
      fullFileContent: 'nested\n', navigation: { file: 'new/deep/file.ts', startLine: 1, endLine: 1 }, hazards: [] });
    assert.strictEqual(created.status, 'applied');
    assert.strictEqual(await read('new/deep/file.ts'), 'nested\n');
    await fs.mkdir(path.join(first, '..cache'));
    await fs.writeFile(path.join(first, '..cache/file.txt'), 'legal descendant');
    assert.strictEqual(await bridge.readFile('..cache/file.txt'), 'legal descendant');
    console.log('PASS first-root bounds, outside path/read/navigation/mutation/rename rejection, absent nested create');
  } finally { bridge.dispose(); }

  api.setProviderFactory((() => fakeProvider) as ProviderFactory);
  await api.start('explain', 'explain');
  assert.strictEqual(api.getState()?.phase, 'waiting_for_apply');
  await api.apply();
  assert.strictEqual(await read('sample.ts'), original);
  await api.start('skip');
  await api.skip();
  assert.strictEqual(await read('sample.ts'), original);
  await apply(api, fakeProvider);
  assert.ok((await read('sample.ts')).includes('* qty'));
  await closePanels(api);
  await vscode.commands.executeCommand('justintime.revertAll');
  assert.strictEqual(await read('sample.ts'), original, 'command recovers after panel closes');
  console.log('PASS explain, skip, apply and panel-independent command recovery');

  // Read unsaved text as the first preimage; restore both the editor and disk.
  const dirtyUri = vscode.Uri.file(path.join(first, 'dirty.ts'));
  await fs.writeFile(dirtyUri.fsPath, 'disk baseline\n');
  const dirty = await setBuffer(dirtyUri, 'user unsaved baseline\n');
  assert.ok(dirty.isDirty);
  assert.strictEqual(await read('dirty.ts'), 'disk baseline\n');
  await apply(api, editProvider('dirty.ts', 'user unsaved baseline', 'generated dirty'));
  await closePanels(api);
  await vscode.commands.executeCommand('justintime.revertAll');
  assert.strictEqual(dirty.getText(), 'user unsaved baseline\n');
  await dirty.save();
  assert.strictEqual(await read('dirty.ts'), 'user unsaved baseline\n', 'later save cannot resurrect generated content');

  // macOS commonly aliases case variants to the same document; capture that dirty document too.
  const caseUri = vscode.Uri.file(path.join(first, 'Case.ts'));
  await fs.writeFile(caseUri.fsPath, 'case disk\n');
  if (await fs.stat(path.join(first, 'case.ts')).then(() => true, () => false)) {
    const caseDoc = await setBuffer(caseUri, 'case user unsaved\n');
    await apply(api, editProvider('case.ts', 'case user unsaved', 'case generated'));
    await closePanels(api);
    await vscode.commands.executeCommand('justintime.revertAll');
    assert.strictEqual(caseDoc.getText(), 'case user unsaved\n');
    await caseDoc.save();
    assert.strictEqual(await read('Case.ts'), 'case user unsaved\n');
  }
  console.log('PASS dirty-buffer baseline and case-alias recovery');

  // Retarget a previously safe parent at the actual applyEdit await boundary.
  // This instruments only the host test API; application code exposes no test hooks.
  await fs.mkdir(path.join(first, 'inside'));
  await fs.writeFile(path.join(first, 'inside/target.ts'), 'inside baseline\n');
  await fs.symlink(path.join(first, 'inside'), path.join(first, 'inside-link'));
  api.setProviderFactory(() => editProvider('inside-link/target.ts', 'inside baseline', 'inside generated'));
  await api.start('retarget during editor apply');
  assert.strictEqual(api.getState()?.phase, 'waiting_for_apply');
  const originalApplyEdit = vscode.workspace.applyEdit;
  let retargeted = false;
  const interceptedApplyEdit: typeof vscode.workspace.applyEdit = async (...args) => {
    const result = await originalApplyEdit(...args);
    if (!retargeted) {
      retargeted = true;
      await fs.unlink(path.join(first, 'inside-link'));
      await fs.symlink(path.join(temp, 'outside'), path.join(first, 'inside-link'));
    }
    return result;
  };
  assert.ok(Reflect.set(vscode.workspace, 'applyEdit', interceptedApplyEdit), 'host applyEdit can be instrumented');
  try { await api.apply(); } finally { Reflect.set(vscode.workspace, 'applyEdit', originalApplyEdit); }
  assert.ok(retargeted);
  assert.strictEqual(await fs.readFile(path.join(temp, 'outside/target.ts'), 'utf8'), 'outside sentinel\n', 'post-apply validation blocks saving through retargeted parent');
  const unsafeRevert = await api.revertAll();
  assert.strictEqual(unsafeRevert.errors.length, 1, 'unsafe recovery remains journaled');
  await fs.unlink(path.join(first, 'inside-link'));
  await fs.symlink(path.join(first, 'inside'), path.join(first, 'inside-link'));
  const safeRevert = await api.revertAll();
  assert.strictEqual(safeRevert.errors.length, 0);
  assert.strictEqual(safeRevert.restored, 1);
  assert.strictEqual(await read('inside/target.ts'), 'inside baseline\n');
  console.log('PASS post-apply await-boundary retarget rejection and retained recovery');

  // A provider that ignores abort must not resurrect a closed or replaced panel.
  for (const phase of ['outline', 'hydrate'] as const) {
    const gate = deferred<WalkthroughOutline | HydratedStep>();
    const entered = deferred<void>();
    let signal: AbortSignal | undefined;
    let savedCtx: RepoContext | undefined;
    const old: PlanProvider = { ...fakeProvider,
      ...(phase === 'outline' ? {
        produceOutline: async (_p: string, ctx: RepoContext) => { signal = ctx.signal; savedCtx = ctx; entered.resolve(); return await gate.promise as WalkthroughOutline; },
      } : {
        hydrateStep: async (_s: OutlineStep, _current: unknown, ctx: { signal?: AbortSignal }) => { signal = ctx.signal; entered.resolve(); return await gate.promise as HydratedStep; },
      }),
    };
    api.setProviderFactory(() => old);
    const pending = api.start('obsolete');
    await entered.promise;
    if (phase === 'outline') await closePanels(api);
    else { api.setProviderFactory(() => fakeProvider); await api.start('replacement', 'explain'); }
    assert.ok(signal?.aborted);
    const current = api.getState();
    if (savedCtx) {
      await assert.rejects(() => savedCtx!.readFile!('sample.ts'));
      await assert.rejects(() => savedCtx!.searchCode!('cart'));
      savedCtx.onProgress?.('late progress');
    }
    gate.resolve(phase === 'outline' ? await fakeProvider.produceOutline('x', { workspaceRoot: first }) : await fakeProvider.hydrateStep({ stepNumber: 1 } as OutlineStep, {}, { sessionId: 's', workspaceRoot: first }));
    await pending;
    assert.deepStrictEqual(api.getState(), current);
    assert.strictEqual(await read('sample.ts'), original);
  }
  await closePanels(api);
  console.log('PASS ignored-abort outline close and hydration replacement');

  // A panel-independent command waits for a mutation already entered by a closed panel.
  api.setProviderFactory(() => fakeProvider);
  await api.start('entered mutation');
  const mutationEntered = deferred<void>();
  const releaseMutation = deferred<void>();
  const applyEditBeforeGate = vscode.workspace.applyEdit;
  let gateOnce = true;
  assert.ok(Reflect.set(vscode.workspace, 'applyEdit', async (...args: Parameters<typeof vscode.workspace.applyEdit>) => {
    const result = await applyEditBeforeGate(...args);
    if (gateOnce) {
      gateOnce = false;
      mutationEntered.resolve();
      await releaseMutation.promise;
    }
    return result;
  }));
  try {
    const applying = api.apply();
    await mutationEntered.promise;
    await closePanels(api);
    await api.start('replacement during old apply', 'explain');
    assert.strictEqual(api.getState()?.phase, 'waiting_for_apply');
    let reverted = false;
    const reverting = vscode.commands.executeCommand('justintime.revertAll').then(() => { reverted = true; });
    // The command disposes replacement before it can enter the shared recovery queue.
    await waitFor(() => api.getState() === undefined, 'revert invalidates replacement');
    assert.strictEqual(reverted, false, 'recovery waits for entered mutation');
    releaseMutation.resolve();
    await Promise.all([applying, reverting]);
    assert.strictEqual(await read('sample.ts'), original, 'recovery is final after old apply settles');
    assert.strictEqual(api.getState(), undefined);
  } finally {
    releaseMutation.resolve();
    Reflect.set(vscode.workspace, 'applyEdit', applyEditBeforeGate);
  }
  console.log('PASS entered-mutation panel-close/replacement/command serialization');

  // Persist overlapping first touches, including dirty text, for the independent second host.
  await setBuffer(dirtyUri, 'user second unsaved baseline\n');
  await apply(api, editProvider('dirty.ts', 'user second unsaved baseline', 'generated dirty one'));
  await apply(api, editProvider('dirty.ts', 'generated dirty one', 'generated dirty two'));
  await apply(api, fakeProvider);
  await apply(api, editProvider('sample.ts', '  cart.total += item.price * qty;', '  cart.total += item.price * qty * 2;'));
  await fs.mkdir(path.join(first, 'sub'));
  await fs.writeFile(path.join(first, 'sub/target.ts'), 'original sub\n');
  await apply(api, editProvider('sub/target.ts', 'original sub', 'generated sub'));
  await closePanels(api);
  // The persisted recovery target becomes unsafe between host launches.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await fs.rename(path.join(first, 'sub'), path.join(first, 'saved-sub'));
  await fs.symlink(path.join(temp, 'outside'), path.join(first, 'sub'));
  await fs.writeFile(expectedFile, JSON.stringify({ sample: original, dirty: 'user second unsaved baseline\n' }));
  assert.strictEqual(await fs.readFile(path.join(second, 'sample.ts'), 'utf8'), original);
  console.log('PASS prepared two-host first-touch/dirty/containment recovery state');
}
