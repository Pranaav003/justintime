// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostToWebview, StepView } from './protocol';
const post = vi.fn();
const view = (patch: Partial<StepView> = {}): StepView => ({ stepNumber: 2, totalSteps: 3, title: 'Configure database', locationLabel: 'src/db.ts:4', locationFile: 'src/db.ts', locationLine: 4, genericMarkdown: 'Understand **connections**.', specificMarkdown: 'Use a pool.', prerequisites: ['SQL'], relatedFiles: [{ file: 'src/app.ts', relationship: 'Caller' }], changeKind: 'modify', diffHunks: [{ oldText: 'old', newText: 'new' }], reviewMode: false, showPrerequisites: true, dots: ['done', 'current', 'upcoming'], mode: 'solve', chat: [{ id: 10, question: 'Why?' }], ...patch });
const send = (data: HostToWebview) => window.dispatchEvent(new MessageEvent('message', { data }));
const el = <T extends HTMLElement = HTMLButtonElement>(id: string) => document.getElementById(id) as T;
// Import once: the real client installs one window listener for its lifetime.
beforeEach(async () => {
  document.body.innerHTML = '<button id="outside">Editor</button><main id="app"></main><div id="announcer" role="status" aria-live="polite"></div>';
  vi.stubGlobal('acquireVsCodeApi', () => ({ postMessage: post }));
  await import('./client');
  send({ type: 'idle', message: 'Ready' });
  post.mockClear();
});
describe('walkthrough client', () => {
  it('renders semantic navigation, file buttons, labelled chat and mode-specific actions', () => {
    send({ type: 'render', view: view() });
    expect(el('apply').textContent).toContain('Apply'); expect(el('skip')).toBeTruthy();
    expect(document.querySelector('nav button[aria-current="step"]')).toBeTruthy();
    expect(document.querySelector('.loc-link')?.tagName).toBe('BUTTON');
    expect(document.querySelector('label[for="chat-q"]')).toBeTruthy();
    expect(document.querySelector('.diff[tabindex="0"]')).toBeTruthy();
    send({ type: 'render', view: view({ mode: 'explain' }) });
    expect(el('apply').textContent).toBe('Next'); expect(el('skip')).toBeNull(); expect(document.querySelector('.diff')).toBeNull();
    send({ type: 'render', view: view({ reviewMode: true, stepNumber: 1 }) });
    expect(el('apply')).toBeNull(); el('return-current').click();
    expect(post).toHaveBeenLastCalledWith({ type: 'reviewStep', stepNumber: 1 });
  });
  it.each(['apply', 'skip'])('fences %s synchronously across double activation, conflicting controls and chat feedback', (action) => {
    send({ type: 'render', view: view() });
    el(action).click(); el(action).click(); el(action === 'apply' ? 'skip' : 'apply').click();
    send({ type: 'answerError', id: 10, message: 'Unavailable' }); send({ type: 'answer', id: 10, answer: 'Done' }); send({ type: 'progress', text: 'Working' }); send({ type: 'applied', stepNumber: 2 });
    document.querySelector<HTMLButtonElement>('.dot')!.click(); document.querySelector<HTMLButtonElement>('.loc-link')!.click(); el('apply').click();
    expect(post.mock.calls).toEqual([[{ type: action }]]); expect(el('apply').hasAttribute('disabled')).toBe(true);
    send({ type: 'busy', message: 'Preparing' }); send({ type: 'render', view: view({ stepNumber: 3 }) }); el('apply').click();
    send({ type: 'applied', stepNumber: 2 }); el('apply').click(); expect(post).toHaveBeenCalledTimes(2);
  });
  it.each(['error', 'conflict'] as const)('%s stops pending and remains terminal across review and return', (type) => {
    send({ type: 'render', view: view() }); el('apply').click();
    send(type === 'error' ? { type, message: 'Failed' } : { type, stepNumber: 2, reason: 'Changed' });
    expect(document.querySelector('[aria-busy="true"]')).toBeNull(); expect(el('apply')).toBeNull();
    send({ type: 'render', view: view({ reviewMode: true, stepNumber: 1 }) }); el('return-current').click();
    send({ type: 'render', view: view() }); expect(el('apply')).toBeNull(); expect(document.body.textContent).toContain('Start Walkthrough');
    send({ type: 'idle', message: 'Ready' }); send({ type: 'render', view: view() }); expect(el('apply').disabled).toBe(false);
  });
  it.each(['error', 'conflict'] as const)('handles %s before any view without a stale busy indicator', type => {
    send({ type: 'busy', message: 'Analyzing' }); send({ type: 'progress', text: 'Reading' });
    send(type === 'error' ? { type, message: 'Failed' } : { type, stepNumber: 1, reason: 'Changed' });
    expect(document.querySelector('.busy')).toBeNull(); expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(el('analysis-progress')?.textContent ?? '').toBe(''); expect(el('apply')).toBeNull(); expect(el('cancel')).toBeTruthy(); expect(el('announcer').textContent).toMatch(/Failed|Changed/);
  });
  it('keeps composition Enter separate from submission and prevents handled defaults', () => {
    send({ type: 'render', view: view() }); const input = el<HTMLInputElement>('chat-q'); input.value = 'Question';
    const key = (opts = {}) => { const e = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...opts }); input.dispatchEvent(e); expect(e.defaultPrevented).toBe(true); };
    key({ isComposing: true }); key({ keyCode: 229 }); input.dispatchEvent(new CompositionEvent('compositionstart')); key(); expect(post).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionend')); key(); key(); expect(post).toHaveBeenCalledTimes(1); expect(post).toHaveBeenLastCalledWith({ type: 'ask', id: 11, question: 'Question' });
  });
  it('preserves per-step drafts, selection and owned focus without stealing editor focus', () => {
    send({ type: 'render', view: view() }); let input = el<HTMLInputElement>('chat-q'); input.value = 'Draft two'; input.focus(); input.setSelectionRange(2, 5);
    send({ type: 'answer', id: 10, answer: 'Answer' }); expect(document.activeElement).toBe(input); expect(input.selectionStart).toBe(2);
    send({ type: 'render', view: view() }); input = el('chat-q'); expect(input.value).toBe('Draft two'); expect(document.activeElement).toBe(input); expect(input.selectionEnd).toBe(5);
    send({ type: 'render', view: view({ stepNumber: 1, reviewMode: true }) }); expect(el<HTMLInputElement>('chat-q').value).toBe(''); el<HTMLInputElement>('chat-q').value = 'Draft one';
    el('outside').focus(); send({ type: 'render', view: view() }); expect(el<HTMLInputElement>('chat-q').value).toBe('Draft two'); expect(document.activeElement).toBe(el('outside'));
    send({ type: 'render', view: view({ stepNumber: 1, reviewMode: true }) }); expect(el<HTMLInputElement>('chat-q').value).toBe('Draft one');
  });
  it.each(['paused', 'completed', 'idle', 'busy'] as const)('%s resets pending for replacement presentation', type => {
    send({ type: 'render', view: view() }); el('apply').click();
    if (type === 'completed') send({ type, applied: 1, skipped: 0, mode: 'solve' }); else if (type === 'paused') send({ type }); else send({ type, message: 'State' });
    send({ type: 'render', view: view() }); expect(el('apply').disabled).toBe(false);
  });
  it('keeps fresh chat history, draft, selection and focus through a terminal banner', () => {
    send({ type: 'render', view: view() });
    const input = el<HTMLInputElement>('chat-q'); input.value = 'Fresh question'; el('chat-send').click();
    const id = post.mock.calls.at(-1)![0].id;
    send({ type: 'answer', id, answer: 'Fresh answer' });
    input.value = 'Unsent draft'; input.focus(); input.setSelectionRange(1, 4);
    send({ type: 'error', message: 'Global failure' });
    expect(document.getElementById('chat-log')?.textContent).toContain('Fresh question');
    expect(document.getElementById('chat-log')?.textContent).toContain('Fresh answer');
    expect(document.activeElement).toBe(input); expect(input.value).toBe('Unsent draft'); expect(input.selectionEnd).toBe(4);
    expect(el('apply')).toBeNull();
  });
  it('retains drafts through routine step preparation and clears them on idle', () => {
    send({ type: 'render', view: view({ stepNumber: 1 }) });
    el<HTMLInputElement>('chat-q').value = 'Keep step one draft'; el('apply').click();
    send({ type: 'busy', message: 'Preparing next step' });
    send({ type: 'render', view: view() }); expect(el('apply').disabled).toBe(false);
    send({ type: 'render', view: view({ stepNumber: 1, reviewMode: true }) });
    expect(el<HTMLInputElement>('chat-q').value).toBe('Keep step one draft');
    send({ type: 'error', message: 'Stopped' }); send({ type: 'busy', message: 'New presentation' });
    send({ type: 'render', view: view() }); expect(el('apply').disabled).toBe(false);
    send({ type: 'idle', message: 'New session' }); send({ type: 'render', view: view({ stepNumber: 1 }) });
    expect(el<HTMLInputElement>('chat-q').value).toBe('');
  });
  it.each(['.location .loc-link', 'li .loc-link', '.diff', 'pre', 'table'])('restores owned %s focus across same-step render only', selector => {
    const content = view({ genericMarkdown: '```ts\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |' });
    send({ type: 'render', view: content });
    document.querySelector<HTMLElement>(selector)!.focus();
    send({ type: 'render', view: content });
    expect(document.activeElement).toBe(document.querySelector(selector));
    el('outside').focus(); send({ type: 'render', view: content }); expect(document.activeElement).toBe(el('outside'));
    document.querySelector<HTMLElement>(selector)!.focus();
    send({ type: 'render', view: { ...content, stepNumber: 1 } }); expect(document.activeElement).not.toBe(document.querySelector(selector));
  });
  it('sets up incremental answer code and table regions identically to restored history', () => {
    const answer = '```ts\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    send({ type: 'render', view: view() }); send({ type: 'answer', id: 10, answer });
    const regions = Array.from(document.querySelectorAll<HTMLElement>('.chat-a pre, .chat-a table'));
    expect(regions).toHaveLength(2);
    for (const region of regions) { expect(region.tabIndex).toBe(0); expect(region.getAttribute('aria-label')).toBeTruthy(); expect(region.id).toBeTruthy(); }
    const attributes = regions.map(r => [r.id, r.tabIndex, r.getAttribute('aria-label')]);
    regions[0].focus(); send({ type: 'render', view: view({ chat: [{ id: 10, question: 'Why?', answer }] }) });
    expect(document.activeElement).toBe(document.querySelector('.chat-a pre'));
    expect(Array.from(document.querySelectorAll<HTMLElement>('.chat-a pre, .chat-a table')).map(r => [r.id, r.tabIndex, r.getAttribute('aria-label')])).toEqual(attributes);
  });
  it('escapes hostile plain fields and sanitizes markdown, answers and terminal messages', () => {
    const payload = '\"><img src=x onerror="evil()"><script>evil()</script>';
    send({ type: 'render', view: view({ title: payload, locationFile: payload, locationLabel: payload, genericMarkdown: payload, diffHunks: [{ oldText: payload, newText: payload }], chat: [{ id: 10, question: payload }] }) });
    send({ type: 'answer', id: 10, answer: payload }); send({ type: 'error', message: payload });
    expect(document.querySelector('script,[onerror]')).toBeNull(); expect(document.querySelector('.title')?.textContent).toBe(payload);
    expect(document.querySelector<HTMLElement>('.loc-link')?.dataset.file).toBe(payload);
  });
});
