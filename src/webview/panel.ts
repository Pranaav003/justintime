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
  private ready = false;
  private draining = false;
  private startup: HostToWebview[] = [];

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

    // Install lifecycle listeners before assigning HTML: the client may be ready
    // immediately, including during HTML assignment in an embedded host.
    this.panel.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      if (this.disposed) return;
      if (msg.type === 'ready' && !this.ready) {
        this.ready = true;
        this.draining = true;
        try {
          while (!this.disposed && this.startup.length) {
            const next = this.startup.shift()!;
            void this.panel.webview.postMessage(next);
          }
        } finally {
          this.draining = false;
          this.startup = [];
        }
      }
      if (!this.disposed) for (const h of this.messageHandlers) h(msg);
    });
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.startup = [];
      for (const h of this.disposeHandlers) h();
      this.messageHandlers.length = 0;
      this.disposeHandlers.length = 0;
    });

    const nonce = makeNonce();
    const scriptUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'panel.js'))
      .toString();
    this.panel.webview.html = buildPanelHtml({
      nonce,
      cspSource: this.panel.webview.cspSource,
      scriptUri,
    });
  }

  onMessage(handler: (msg: WebviewToHost) => void): void {
    this.messageHandlers.push(handler);
  }

  onDidDispose(handler: () => void): void {
    this.disposeHandlers.push(handler);
  }

  private post(msg: HostToWebview): void {
    if (this.disposed) return;
    if (this.ready) {
      // Reentrant posts must follow the complete earlier startup delivery.
      if (this.draining) this.startup.push(msg);
      else void this.panel.webview.postMessage(msg);
      return;
    }
    switch (msg.type) {
      case 'render':
      case 'busy':
      case 'idle':
      case 'paused':
      case 'completed': {
        // Terminal feedback also carries the client's stopped capability across
        // review/render. Only busy/idle reset it; preserve that safety latch.
        const terminal = msg.type === 'render' || msg.type === 'paused'
          ? this.startup.filter(m => m.type === 'error' || m.type === 'conflict')
          : [];
        this.startup = [msg, ...terminal];
        return;
      }
      case 'progress':
        if (this.startup[0]?.type !== 'busy') return;
        this.startup = this.startup.filter(m => m.type !== 'progress');
        break;
      case 'answer':
      case 'answerError': {
        const presentation = this.startup[0];
        if (presentation?.type !== 'render' || !presentation.view.chat.some(c => c.id === msg.id)) return;
        this.startup = this.startup.filter(m => !((m.type === 'answer' || m.type === 'answerError') && m.id === msg.id));
        break;
      }
      case 'error':
      case 'conflict':
        this.startup = this.startup.filter(m => m.type !== msg.type);
        break;
      case 'applied':
        // Applied is an acknowledgement only; the client never changes content.
        return;
    }
    this.startup.push(msg);
  }

  renderStep(view: StepView): void {
    this.post({ type: 'render', view });
  }
  showBusy(message: string): void {
    this.post({ type: 'busy', message });
  }
  showProgress(text: string): void {
    this.post({ type: 'progress', text });
  }
  showIdle(message: string): void {
    this.post({ type: 'idle', message });
  }
  showPaused(): void {
    this.post({ type: 'paused' });
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
