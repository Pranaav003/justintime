import * as vscode from 'vscode';
import { buildPanelHtml, makeNonce } from './html';
import type { HostToWebview, WebviewToHost, StepView } from './protocol';
import type { WalkthroughMode } from '../types';

/**
 * Host side of the explanation panel. Owns the WebviewPanel lifecycle, injects
 * the CSP/nonce HTML, and exposes a typed post/receive surface. Review-mode
 * enforcement lives in the orchestrator's state machine (APPLY is illegal while
 * reviewing); this class just relays messages.
 */
export class ExplanationPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly messageHandlers: ((msg: WebviewToHost) => void)[] = [];
  private readonly disposeHandlers: (() => void)[] = [];
  private disposed = false;

  constructor(extensionUri: vscode.Uri) {
    this.panel = vscode.window.createWebviewPanel(
      'justintime.panel',
      'JustInTime',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );

    const nonce = makeNonce();
    const scriptUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'panel.js'))
      .toString();
    this.panel.webview.html = buildPanelHtml({
      nonce,
      cspSource: this.panel.webview.cspSource,
      scriptUri,
    });

    this.panel.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      for (const h of this.messageHandlers) {
        h(msg);
      }
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      for (const h of this.disposeHandlers) {
        h();
      }
    });
  }

  onMessage(handler: (msg: WebviewToHost) => void): void {
    this.messageHandlers.push(handler);
  }

  onDidDispose(handler: () => void): void {
    this.disposeHandlers.push(handler);
  }

  private post(msg: HostToWebview): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(msg);
    }
  }

  renderStep(view: StepView): void {
    this.post({ type: 'render', view });
  }
  showBusy(message: string): void {
    this.post({ type: 'busy', message });
  }
  notifyApplied(stepNumber: number): void {
    this.post({ type: 'applied', stepNumber });
  }
  notifyConflict(stepNumber: number, reason: string): void {
    this.post({ type: 'conflict', stepNumber, reason });
  }
  notifyError(message: string): void {
    this.post({ type: 'error', message });
  }
  notifyCompleted(applied: number, skipped: number, mode: WalkthroughMode): void {
    this.post({ type: 'completed', applied, skipped, mode });
  }
  postAnswer(id: number, answer: string): void {
    this.post({ type: 'answer', id, answer });
  }
  postAnswerError(id: number, message: string): void {
    this.post({ type: 'answerError', id, message });
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  dispose(): void {
    this.panel.dispose();
  }
}
