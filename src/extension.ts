import * as vscode from 'vscode';

/**
 * Extension entry point. For Task 1 this registers the command surface and
 * proves activation works end to end. The walkthrough engine (orchestrator,
 * Claude bridge, editor bridge, webview) is wired up in later tasks.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('justintime.start', async () => {
      const problem = await vscode.window.showInputBox({
        prompt: 'Describe the code problem for JustInTime to walk you through',
        placeHolder: 'e.g. Fix the race condition in the checkout flow',
        ignoreFocusOut: true,
      });
      if (!problem) {
        return;
      }
      void vscode.window.showInformationMessage(
        `JustInTime received: "${problem}". Walkthrough engine is not wired up yet.`,
      );
    }),
    vscode.commands.registerCommand('justintime.pause', notWiredUp('Pause')),
    vscode.commands.registerCommand('justintime.resume', notWiredUp('Resume')),
    vscode.commands.registerCommand('justintime.skip', notWiredUp('Skip Step')),
    vscode.commands.registerCommand('justintime.revertAll', notWiredUp('Revert All')),
  );
}

export function deactivate(): void {
  // No persistent resources to release yet.
}

function notWiredUp(label: string): () => void {
  return () => {
    void vscode.window.showInformationMessage(`JustInTime: "${label}" is not wired up yet.`);
  };
}
