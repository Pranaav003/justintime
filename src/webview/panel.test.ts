import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// jsdom is a test-only dependency without bundled declarations.
// @ts-expect-error No @types/jsdom dependency is needed for this runtime fixture.
import { JSDOM } from 'jsdom';
import type { HostToWebview, StepView, WebviewToHost } from './protocol';
const mock = vi.hoisted(() => ({
  receive: undefined as undefined | ((m: WebviewToHost) => void),
  disposed: undefined as undefined | (() => void),
  htmlReady: false,
  readyDelivered: false,
  post: vi.fn(),
}));
vi.mock('vscode', () => ({
  ViewColumn: { Beside: 2 },
  Uri: { joinPath: () => ({ toString: () => 'local.js' }) },
  window: {
    createWebviewPanel: () => ({
      webview: {
        cspSource: 'local',
        asWebviewUri: (u: unknown) => u,
        set html(_s: string) {
          if (mock.htmlReady) {
            mock.readyDelivered = !!mock.receive && !!mock.disposed;
            mock.receive?.({ type: 'ready' });
          }
        },
        onDidReceiveMessage: (h: typeof mock.receive) => {
          mock.receive = h;
        },
        postMessage: mock.post,
      },
      onDidDispose: (h: typeof mock.disposed) => {
        mock.disposed = h;
      },
      dispose: () => mock.disposed?.(),
      reveal: vi.fn(),
    }),
  },
}));
import { ExplanationPanel } from './panel';
import type * as vscode from 'vscode';
const create = () => new ExplanationPanel({} as vscode.Uri);
const ready = () => mock.receive?.({ type: 'ready' });
const messages = () => mock.post.mock.calls.map(([m]) => m as HostToWebview);
const view = (): StepView => ({
  stepNumber: 1,
  totalSteps: 1,
  title: 'Test',
  locationLabel: 'a:1',
  locationFile: 'a',
  locationLine: 1,
  genericMarkdown: '',
  specificMarkdown: '',
  prerequisites: [],
  relatedFiles: [],
  changeKind: 'modify',
  diffHunks: [],
  reviewMode: false,
  showPrerequisites: true,
  dots: ['current'],
  mode: 'solve',
  chat: [
    { id: 1, question: 'One?' },
    { id: 2, question: 'Two?' },
  ],
});
beforeEach(() => {
  mock.receive = undefined;
  mock.disposed = undefined;
  mock.htmlReady = false;
  mock.readyDelivered = false;
  mock.post.mockReset();
});
afterEach(() => vi.unstubAllGlobals());
describe('panel startup delivery', () => {
  it('installs receiver before HTML and forwards ordinary posts after synchronous ready', () => {
    mock.htmlReady = true;
    const p = create();
    expect(mock.readyDelivered).toBe(true);
    p.showIdle('Ready');
    expect(messages()).toEqual([{ type: 'idle', message: 'Ready' }]);
  });
  it('holds startup messages, drains once and forwards ready to handlers', () => {
    const p = create();
    const handler = vi.fn();
    p.onMessage(handler);
    p.showBusy('Read');
    p.showProgress('Latest');
    expect(messages()).toEqual([]);
    ready();
    ready();
    p.showIdle('Done');
    expect(messages().map((m) => m.type)).toEqual(['busy', 'progress', 'idle']);
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it.each(['render', 'busy', 'idle', 'paused', 'completed'] as const)(
    'replacing %s drops obsolete presentation and effects',
    (type) => {
      const p = create();
      p.renderStep(view());
      p.postAnswer(1, 'Old');
      p.showBusy('Old');
      p.showProgress('Old');
      p.notifyError('Old');
      if (type === 'render') p.renderStep(view());
      if (type === 'busy') p.showBusy('New');
      if (type === 'idle') p.showIdle('New');
      if (type === 'paused') p.showPaused();
      if (type === 'completed') p.notifyCompleted(1, 0, 'solve');
      p.notifyConflict(1, 'New conflict');
      ready();
      expect(messages().map((m) => m.type)).toEqual(
        type === 'render' || type === 'paused' ? [type, 'error', 'conflict'] : [type, 'conflict'],
      );
    },
  );
  it('retains standalone feedback and chronological latest progress under streaming', () => {
    const p = create();
    p.notifyError('Early');
    p.notifyConflict(1, 'Conflict');
    ready();
    expect(messages().map((m) => m.type)).toEqual(['error', 'conflict']);
  });
  it('coalesces progress with bounded retained storage and preserves retained effect order', () => {
    const p = create();
    p.showBusy('Read');
    for (let i = 0; i < 10000; i++) p.showProgress(String(i));
    p.notifyError('Failure');
    p.showProgress('Last');
    expect(messages()).toEqual([]);
    const retained = Object.values(p).filter(Array.isArray).flat();
    expect(retained.length).toBeLessThan(10);
    ready();
    expect(messages()).toEqual([
      { type: 'busy', message: 'Read' },
      { type: 'error', message: 'Failure' },
      { type: 'progress', text: 'Last' },
    ]);
  });
  it('delivers latest matching chat results without mutating the caller or admitting foreign answers', async () => {
    const p = create();
    const v = view();
    const before = structuredClone(v);
    p.renderStep(v);
    p.postAnswer(1, 'Old');
    p.postAnswer(1, 'Final');
    p.postAnswerError(2, 'Failed');
    p.postAnswer(99, 'Foreign');
    p.notifyError('Global');
    expect(messages()).toEqual([]);
    ready();
    expect(v).toEqual(before);
    expect(messages().map((m) => m.type)).toEqual(['render', 'answer', 'answerError', 'error']);
    const dom = new JSDOM();
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('MessageEvent', dom.window.MessageEvent);
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    document.body.innerHTML = '<main id="app"></main><div id="announcer"></div>';
    vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: vi.fn() }));
    await import('./client');
    for (const data of messages()) window.dispatchEvent(new MessageEvent('message', { data }));
    expect(document.querySelector('.chat-a[data-id="1"]')?.textContent).toContain('Final');
    expect(document.querySelector('.chat-a[data-id="2"]')?.textContent).toContain('Failed');
    expect(document.body.textContent).toContain('Global');
    expect(document.getElementById('apply')).toBeNull();
  });
  it('preserves terminal safety across a later render until busy or idle resets it', () => {
    const p = create();
    p.notifyError('Stopped');
    p.renderStep(view());
    ready();
    expect(messages().map((m) => m.type)).toEqual(['render', 'error']);
  });
  it('drops answers for a replaced render and progress outside busy', () => {
    const p = create();
    p.renderStep(view());
    p.postAnswer(1, 'Old');
    p.renderStep({ ...view(), chat: [] });
    p.postAnswer(1, 'Foreign');
    p.showProgress('Stale');
    ready();
    expect(messages().map((m) => m.type)).toEqual(['render']);
  });
  it('keeps the complete startup drain ahead of synchronous reentrant posts and handler posts', () => {
    const p = create();
    p.showBusy('Read');
    p.notifyError('Failure');
    mock.post.mockImplementationOnce(() => p.showIdle('Hook'));
    p.onMessage(() => p.showPaused());
    ready();
    expect(messages().map((m) => m.type)).toEqual(['busy', 'error', 'idle', 'paused']);
  });
  it('clears startup storage and suppresses messages when disposed before ready', () => {
    const p = create();
    p.renderStep(view());
    p.dispose();
    ready();
    p.showBusy('Late');
    expect(messages()).toEqual([]);
    expect(Object.values(p).filter(Array.isArray).flat()).toEqual([]);
  });
  it('stops and clears a drain disposed from its first post', () => {
    const p = create();
    p.showBusy('Read');
    p.notifyError('Failure');
    mock.post.mockImplementationOnce(() => p.dispose());
    ready();
    ready();
    p.showIdle('Late');
    expect(messages().map((m) => m.type)).toEqual(['busy']);
    expect(Object.values(p).filter(Array.isArray).flat()).toEqual([]);
  });
});
