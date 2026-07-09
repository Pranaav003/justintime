import * as vscode from 'vscode';
import { Orchestrator } from './orchestrator';
import { EditorBridge } from './editor-bridge';
import { ExplanationPanel } from './webview/panel';
import { RollbackStore } from './rollback-store';
import { ClaudeAgentProvider } from './claude-bridge';
import { makeClaudeQuery } from './sdk-adapter';
import { VscodeSnapshotFs } from './vscode-snapshot-fs';

const SECRET_KEY = 'justintime.anthropicApiKey';

interface ActiveSession {
  orchestrator: Orchestrator;
  editor: EditorBridge;
  panel: ExplanationPanel;
}

let session: ActiveSession | undefined;
let extContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('justintime.start', () => void startWalkthrough()),
    vscode.commands.registerCommand('justintime.pause', () => session?.orchestrator.pause()),
    vscode.commands.registerCommand('justintime.resume', () => void session?.orchestrator.resume()),
    vscode.commands.registerCommand('justintime.skip', () => void session?.orchestrator.skip()),
    vscode.commands.registerCommand('justintime.revertAll', () => void revertAll()),
    vscode.commands.registerCommand('justintime.setApiKey', () => void setApiKey()),
  );
}

export function deactivate(): void {
  disposeSession();
}

async function startWalkthrough(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage('JustInTime requires an open workspace folder.');
    return;
  }
  const workspaceRoot = folders[0]!.uri.fsPath;

  const problem = await vscode.window.showInputBox({
    prompt: 'Describe the code problem for JustInTime to walk you through',
    placeHolder: 'e.g. Fix the race condition in the checkout flow',
    ignoreFocusOut: true,
  });
  if (!problem) {
    return;
  }

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
  const provider = new ClaudeAgentProvider(makeClaudeQuery(), { maxSteps });
  const orchestrator = new Orchestrator(provider, editor, panel, rollback, {
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

  await orchestrator.start(problem);
}

async function revertAll(): Promise<void> {
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
  session?.editor.dispose();
  session?.panel.dispose();
  session = undefined;
}
