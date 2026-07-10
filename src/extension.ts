import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { delimiter as pathDelimiter, join as pathJoin } from 'node:path';
import { Orchestrator } from './orchestrator';
import { EditorBridge } from './editor-bridge';
import { ExplanationPanel } from './webview/panel';
import { RollbackStore, type RevertResult } from './rollback-store';
import { ClaudeAgentProvider } from './claude-bridge';
import { makeClaudeQuery } from './sdk-adapter';
import { VscodeSnapshotFs } from './vscode-snapshot-fs';
import type { PlanProvider } from './plan-source';
import type { SessionState } from './state-machine';
import type { WalkthroughMode } from './types';

const SECRET_KEY = 'justintime.anthropicApiKey';

/** Builds the PlanProvider for a run. Swappable for E2E tests (fake provider, no network). */
export type ProviderFactory = (maxSteps: number) => PlanProvider;

/** Extension API returned from activate(); used by the E2E suite to drive the loop. */
export interface JustInTimeApi {
  setProviderFactory(factory: ProviderFactory): void;
  start(problem: string, mode?: WalkthroughMode): Promise<void>;
  apply(): Promise<void>;
  skip(): Promise<void>;
  revertAll(): Promise<RevertResult>;
  getState(): SessionState | undefined;
}

interface ActiveSession {
  orchestrator: Orchestrator;
  editor: EditorBridge;
  panel: ExplanationPanel;
}

let session: ActiveSession | undefined;
let extContext: vscode.ExtensionContext;
let providerFactory: ProviderFactory = (maxSteps) => {
  const cfg = vscode.workspace.getConfiguration('justintime');
  return new ClaudeAgentProvider(makeClaudeQuery(), {
    maxSteps,
    model: cfg.get<string>('model') || undefined,
    claudeExecutable: resolveClaudeExecutable(cfg.get<string>('claudeExecutable')),
  });
};

/** Resolve the `claude` CLI: explicit setting, else the first match on PATH. */
function resolveClaudeExecutable(configured?: string): string | undefined {
  if (configured) {
    return configured;
  }
  const names = process.platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude'];
  for (const dir of (process.env.PATH ?? '').split(pathDelimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of names) {
      const candidate = pathJoin(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined; // fall back to the SDK's bundled binary if present
}

export function activate(context: vscode.ExtensionContext): JustInTimeApi {
  extContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('justintime.start', () => void startCommand()),
    vscode.commands.registerCommand('justintime.explain', () => void startCommand('explain')),
    vscode.commands.registerCommand('justintime.solve', () => void startCommand('solve')),
    vscode.commands.registerCommand('justintime.pause', () => session?.orchestrator.pause()),
    vscode.commands.registerCommand('justintime.resume', () => void session?.orchestrator.resume()),
    vscode.commands.registerCommand('justintime.skip', () => void session?.orchestrator.skip()),
    vscode.commands.registerCommand('justintime.revertAll', () => void revertAllCommand()),
    vscode.commands.registerCommand('justintime.setApiKey', () => void setApiKey()),
  );

  return {
    setProviderFactory: (factory) => {
      providerFactory = factory;
    },
    start: (problem, mode) => runWalkthrough(problem, mode ?? 'solve'),
    apply: () => session?.orchestrator.apply() ?? Promise.resolve(),
    skip: () => session?.orchestrator.skip() ?? Promise.resolve(),
    revertAll: () =>
      session?.orchestrator.revertAll() ?? Promise.resolve({ restored: 0, deleted: 0, errors: [] }),
    getState: () => session?.orchestrator.getState(),
  };
}

export function deactivate(): void {
  disposeSession();
}

async function startCommand(preselected?: WalkthroughMode): Promise<void> {
  let mode = preselected;
  if (!mode) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(tools) Solve', description: 'Propose gated code changes, step by step', mode: 'solve' as const },
        { label: '$(book) Explain', description: 'Read-only — walk through and explain the code, no changes', mode: 'explain' as const },
      ],
      { title: 'JustInTime', placeHolder: 'Choose a mode' },
    );
    if (!pick) {
      return;
    }
    mode = pick.mode;
  }

  const problem = await vscode.window.showInputBox({
    prompt:
      mode === 'explain'
        ? 'What would you like JustInTime to explain?'
        : 'Describe the code problem for JustInTime to solve',
    placeHolder:
      mode === 'explain'
        ? 'e.g. How does the checkout flow handle concurrent updates?'
        : 'e.g. Fix the race condition in the checkout flow',
    ignoreFocusOut: true,
  });
  if (problem) {
    await runWalkthrough(problem, mode);
  }
}

async function runWalkthrough(problem: string, mode: WalkthroughMode): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage('JustInTime requires an open workspace folder.');
    return;
  }
  const workspaceRoot = folders[0]!.uri.fsPath;

  await applyStoredApiKey();

  const config = vscode.workspace.getConfiguration('justintime');
  const maxSteps = config.get<number>('maxSteps', 30);
  const showPrerequisites = config.get<boolean>('showPrerequisites', true);
  const highlightColor = config.get<string>('highlightColor', '#FFF3CD');
  const secondaryHighlightColor = config.get<string>('secondaryHighlightColor', '#D1ECF1');

  disposeSession();

  const panel = new ExplanationPanel(extContext.extensionUri);
  const editor = new EditorBridge(workspaceRoot, { highlightColor, secondaryHighlightColor });
  const rollback = new RollbackStore(
    new VscodeSnapshotFs(),
    extContext.globalStorageUri.fsPath,
    globalThis.crypto.randomUUID(),
  );
  const orchestrator = new Orchestrator(providerFactory(maxSteps), editor, panel, rollback, {
    workspaceRoot,
    maxSteps,
    showPrerequisites,
  });

  session = { orchestrator, editor, panel };
  panel.onDidDispose(() => {
    if (session?.panel === panel) {
      editor.dispose();
      session = undefined;
    }
  });

  await orchestrator.start(problem, mode);
}

async function revertAllCommand(): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage('No active JustInTime walkthrough to revert.');
    return;
  }
  const result = await session.orchestrator.revertAll();
  const errorNote = result.errors.length ? ` (${result.errors.length} error(s))` : '';
  void vscode.window.showInformationMessage(
    `JustInTime reverted ${result.restored} file(s), removed ${result.deleted}${errorNote}.`,
  );
}

async function setApiKey(): Promise<void> {
  const key = await vscode.window.showInputBox({
    prompt: 'Anthropic API key for JustInTime (stored securely in VS Code SecretStorage)',
    password: true,
    ignoreFocusOut: true,
  });
  if (key) {
    await extContext.secrets.store(SECRET_KEY, key);
    process.env.ANTHROPIC_API_KEY = key;
    void vscode.window.showInformationMessage('JustInTime: Anthropic API key saved.');
  }
}

/**
 * Auth (design Section 2): the SDK inherits the user's existing local `claude`
 * credentials automatically, so we only inject a key when one has been stored
 * via the setApiKey command. We never prompt upfront, to respect an existing
 * claude.ai login.
 */
async function applyStoredApiKey(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    return;
  }
  const stored = await extContext.secrets.get(SECRET_KEY);
  if (stored) {
    process.env.ANTHROPIC_API_KEY = stored;
  }
}

function disposeSession(): void {
  // Clear `session` first so the panel's onDidDispose callback (fired
  // synchronously by panel.dispose) doesn't re-dispose the editor.
  const s = session;
  session = undefined;
  s?.editor.dispose();
  s?.panel.dispose();
}
