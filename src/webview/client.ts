import { renderMarkdown, escapeHtml } from './sanitize';
import type { HostToWebview, WebviewToHost, StepView, DiffHunkView, ChatEntry } from './protocol';

/**
 * Webview client (browser context). Renders step views, posts user actions back
 * to the host. All model/workspace-derived content is sanitized (markdown) or
 * escaped (plain text) before touching the DOM. acquireVsCodeApi() is called
 * exactly once and kept private to this module.
 */

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

function post(msg: WebviewToHost): void {
  vscodeApi.postMessage(msg);
}

function app(): HTMLElement {
  return document.getElementById('app')!;
}

let chatSeq = 0;
let currentView: StepView | undefined;
let pending = false;
let stopped = false;
const drafts = new Map<number, string>();

function announce(message: string): void {
  const region = document.getElementById('announcer');
  if (region) region.textContent = message;
}

function saveDraft(): void {
  const input = document.getElementById('chat-q') as HTMLInputElement | null;
  if (currentView && input) drafts.set(currentView.stepNumber, input.value);
}

function resetPresentation(clearCapabilities = false, clearDrafts = false): void {
  saveDraft();
  currentView = undefined;
  pending = false;
  app().removeAttribute('aria-busy');
  if (clearCapabilities) stopped = false;
  if (clearDrafts) drafts.clear();
}

function submitAction(type: 'apply' | 'skip'): void {
  if (pending || stopped || !currentView || currentView.reviewMode) return;
  pending = true;
  app().setAttribute('aria-busy', 'true');
  for (const button of Array.from(app().querySelectorAll('button'))) button.disabled = true;
  const input = document.getElementById('chat-q') as HTMLInputElement | null;
  if (input) input.disabled = true;
  announce(type === 'skip' ? 'Skipping step…' : currentView.mode === 'explain' ? 'Preparing next step…' : 'Applying change…');
  const status = document.getElementById('action-status');
  if (status) status.textContent = type === 'skip' ? 'Skipping step…' : 'Preparing next step…';
  post({ type });
}

function chatEntryHtml(e: ChatEntry): string {
  const q = `<div class="chat-q">${escapeHtml(e.question)}</div>`;
  let a: string;
  if (e.error !== undefined) {
    a = `<div class="chat-a" data-id="${Number(e.id) | 0}"><span class="banner error">${escapeHtml(e.error)}</span></div>`;
  } else if (e.answer !== undefined) {
    a = `<div class="chat-a" data-id="${Number(e.id) | 0}">${renderMarkdown(e.answer)}</div>`;
  } else {
    a = `<div class="chat-a pending" data-id="${Number(e.id) | 0}">Thinking…</div>`;
  }
  return q + a;
}

function renderChat(view: StepView): string {
  const log = view.chat.map(chatEntryHtml).join('');
  return `<div class="section chat"><h2>Ask about this step</h2>
    <div id="chat-log">${log}</div>
    <label for="chat-q">Your question</label><div class="chat-input">
      <input id="chat-q" type="text" placeholder="Ask a follow-up question about this step…" />
      <button class="secondary" id="chat-send">Send</button>
    </div>
  </div>`;
}

function wireChat(): void {
  const input = document.getElementById('chat-q') as HTMLInputElement | null;
  document.getElementById('chat-send')?.addEventListener('click', () => sendChat(input));
  let composing = false;
  input?.addEventListener('compositionstart', () => { composing = true; });
  input?.addEventListener('compositionend', () => { composing = false; });
  input?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (composing || e.isComposing || e.keyCode === 229) return;
    sendChat(input);
  });
}

function sendChat(input: HTMLInputElement | null): void {
  if (!input || pending) {
    return;
  }
  const question = input.value.trim();
  if (!question) {
    return;
  }
  const id = ++chatSeq;
  const log = document.getElementById('chat-log');
  if (log) {
    const qEl = document.createElement('div');
    qEl.className = 'chat-q';
    qEl.textContent = question; // textContent — never interpret as HTML
    const aEl = document.createElement('div');
    aEl.className = 'chat-a pending';
    aEl.dataset.id = String(id);
    aEl.textContent = 'Thinking…';
    log.appendChild(qEl);
    log.appendChild(aEl);
  }
  input.value = '';
  saveDraft();
  announce('Question sent. Waiting for an answer.');
  post({ type: 'ask', id, question });
}

/** Scope identities to their explanation or chat entry, so new answers do not shift focus targets. */
function setupContentRegions(root: HTMLElement): void {
  for (const region of Array.from(root.querySelectorAll<HTMLElement>('pre, table'))) {
    const scope = region.closest<HTMLElement>('.chat-a, #generic-content, #specific-content');
    if (!scope) continue;
    const prefix = scope.classList.contains('chat-a') ? `chat-${Number(scope.dataset.id) | 0}` : scope.id;
    const index = Array.from(scope.querySelectorAll('pre, table')).indexOf(region);
    region.id = `${prefix}-region-${index}`;
    region.tabIndex = 0;
    region.setAttribute('aria-label', region.tagName === 'PRE' ? 'Code example' : 'Data table');
  }
}

function fillAnswer(id: number, content: string, isError: boolean): void {
  const el = document.querySelector<HTMLElement>(`.chat-a[data-id="${id}"]`);
  if (!el) {
    return;
  }
  el.classList.remove('pending');
  announce(isError ? 'Could not answer the question.' : 'Answer received.');
  if (isError) {
    el.innerHTML = '';
    const b = document.createElement('span');
    b.className = 'banner error';
    b.textContent = content; // raw message; textContent escapes
    el.appendChild(b);
  } else {
    el.innerHTML = content; // sanitized markdown HTML from renderMarkdown
    setupContentRegions(el);
  }
}

function renderDiff(hunks: DiffHunkView[]): string {
  if (hunks.length === 0) {
    return '<div class="section"><h2>Change</h2><p>No line edits (file-level change).</p></div>';
  }
  const blocks = hunks
    .map((h) => {
      const del = h.oldText
        ? h.oldText.split('\n').map((l) => `<div class="del">- ${escapeHtml(l)}</div>`).join('')
        : '';
      const add = h.newText
        ? h.newText.split('\n').map((l) => `<div class="add">+ ${escapeHtml(l)}</div>`).join('')
        : '';
      return del + add;
    })
    .join('');
  return `<div class="section"><h2>Diff preview</h2><div id="diff-preview" class="diff" tabindex="0" role="region" aria-label="Diff preview">${blocks}</div></div>`;
}

function renderRelated(view: StepView): string {
  if (view.relatedFiles.length === 0) {
    return '';
  }
  const items = view.relatedFiles
    .map(
      (r, i) =>
        `<li><button type="button" id="related-location-${i}" class="loc-link" data-file="${escapeHtml(r.file)}" data-line="1">${escapeHtml(r.file)}</button> — ${escapeHtml(r.relationship)}</li>`,
    )
    .join('');
  return `<div class="section"><h2>Related context</h2><ul>${items}</ul></div>`;
}

function renderPrereqs(view: StepView): string {
  if (!view.showPrerequisites || view.prerequisites.length === 0) {
    return '';
  }
  const items = view.prerequisites.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  return `<div class="section"><h2>Prerequisites</h2><ul>${items}</ul></div>`;
}

function renderView(view: StepView): void {
  saveDraft();
  const active = document.activeElement as HTMLElement | null;
  const restoreFocus = currentView?.stepNumber === view.stepNumber && active && app().contains(active) && document.hasFocus();
  const focusId = restoreFocus ? active.id : '';
  const selection = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
  currentView = view;
  pending = false;
  app().removeAttribute('aria-busy');
  // Keep the local id counter ahead of any restored history ids.
  chatSeq = view.chat.reduce((m, e) => Math.max(m, e.id), chatSeq);
  // Coerce numerics before interpolation — defence in depth even though these
  // are host-controlled.
  const stepNum = String(Number(view.stepNumber) | 0);
  const totalSteps = String(Number(view.totalSteps) | 0);
  const locationLine = String(Number(view.locationLine) | 0);

  const dots = view.dots
    .map((status, i) => `<li><button type="button" id="step-${i + 1}" class="dot ${escapeHtml(status)}" data-step="${i + 1}" ${status === 'current' ? 'aria-current="step"' : ''} aria-label="Step ${i + 1}, ${escapeHtml(status)}"><span class="step-number">${i + 1}</span><span class="step-status">${escapeHtml(status)}</span></button></li>`)
    .join('');

  const explain = view.mode === 'explain';
  const actions = view.reviewMode
    ? `<div class="review-note">Reviewing step ${stepNum} · Read only</div><button class="secondary" id="return-current">Return to current step</button>`
    : stopped
      ? '<div class="banner error">Walkthrough stopped. Run “JustInTime: Start Walkthrough” from the Command Palette to begin again.</div><button class="secondary" id="cancel">End walkthrough</button>'
    : explain
      ? `<div class="actions">
           <button class="primary" id="apply">Next</button>
           <button class="secondary" id="pause">Pause</button>
         </div>`
      : `<div class="actions">
           <button class="primary" id="apply">Apply &amp; Next</button>
           <button class="secondary" id="skip">Skip</button>
           <button class="secondary" id="pause">Pause</button>
         </div>`;

  app().innerHTML = `
    <header class="brand"><span>JustInTime</span><span class="mode">${explain ? 'Explain · Read only' : 'Solve'}</span></header>
    <nav aria-label="Walkthrough steps"><div class="progress-label">Step ${stepNum} of ${totalSteps}</div><ol class="progress">${dots}</ol></nav>
    <h1 class="title">${escapeHtml(view.title)}</h1>
    <div class="location"><span class="eyebrow">In this file</span><button id="primary-location" type="button" class="loc-link" data-file="${escapeHtml(view.locationFile)}" data-line="${locationLine}">${escapeHtml(view.locationLabel)}</button></div>
    <div id="generic-content" class="section"><h2>What's happening</h2>${renderMarkdown(view.genericMarkdown)}</div>
    <div id="specific-content" class="section"><h2>Why here</h2>${renderMarkdown(view.specificMarkdown)}</div>
    ${renderRelated(view)}
    ${renderPrereqs(view)}
    ${explain ? '' : renderDiff(view.diffHunks)}
    <section class="action-area" aria-label="Step actions">${actions}<p id="action-status"></p></section>
    ${renderChat(view)}
  `;

  document.getElementById('apply')?.addEventListener('click', () => submitAction('apply'));
  document.getElementById('skip')?.addEventListener('click', () => submitAction('skip'));
  document.getElementById('pause')?.addEventListener('click', () => post({ type: 'pause' }));
  document.getElementById('return-current')?.addEventListener('click', () => post({ type: 'reviewStep', stepNumber: view.stepNumber }));
  document.getElementById('cancel')?.addEventListener('click', () => post({ type: 'cancel' }));
  const input = document.getElementById('chat-q') as HTMLInputElement;
  input.value = drafts.get(view.stepNumber) ?? '';
  wireChat();
  setupContentRegions(app());
  const focusTarget = focusId ? document.getElementById(focusId) : null;
  if (focusTarget && !(focusTarget as HTMLButtonElement).disabled) {
    focusTarget.focus({ preventScroll: true });
    if (selection && focusTarget instanceof HTMLInputElement) focusTarget.setSelectionRange(selection[0], selection[1]);
  }
  announce(`Step ${stepNum} of ${totalSteps}: ${view.title}${view.reviewMode ? '. Review only.' : ''}`);
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.dot'))) {
    el.addEventListener('click', () => { if (!pending) post({ type: 'reviewStep', stepNumber: Number(el.dataset.step) }); });
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.loc-link'))) {
    el.addEventListener('click', () =>
      { if (!pending) post({ type: 'openLocation', file: el.dataset.file ?? '', line: Number(el.dataset.line ?? '1') }); },
    );
  }
}

function showBanner(message: string, kind: 'warn' | 'error'): void {
  stopped = true;
  pending = false;
  app().removeAttribute('aria-busy');
  if (currentView) {
    const actions = document.querySelector('.action-area');
    if (actions) actions.innerHTML = '<p>Walkthrough stopped. Run “JustInTime: Start Walkthrough” from the Command Palette to begin again.</p><button id="cancel" class="secondary">End walkthrough</button>';
    for (const control of Array.from(app().querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'))) control.disabled = false;
    document.getElementById('cancel')?.addEventListener('click', () => post({ type: 'cancel' }));
  } else {
    app().innerHTML = '<h1 class="title">Walkthrough stopped</h1><p>Run “JustInTime: Start Walkthrough” from the Command Palette to begin again.</p><button id="cancel" class="secondary">End walkthrough</button>';
    document.getElementById('cancel')?.addEventListener('click', () => post({ type: 'cancel' }));
  }
  const banner = document.createElement('div');
  banner.className = `banner ${kind}`;
  banner.textContent = message; // textContent — never interpret as HTML
  app().prepend(banner);
  announce(message);
}

function renderCompleted(applied: number, skipped: number, mode: string): void {
  const appliedStr = String(Number(applied) | 0);
  const skippedStr = String(Number(skipped) | 0);
  if (mode === 'explain') {
    app().innerHTML = `
      <h1 class="title">Explanation complete</h1>
      <p>${appliedStr} step(s) reviewed, ${skippedStr} skipped.</p>
    `;
    return;
  }
  app().innerHTML = `
    <h1 class="title">Walkthrough complete</h1>
    <p>${appliedStr} step(s) applied, ${skippedStr} skipped.</p>
    <p class="review-note">Run “JustInTime: Revert All” from the Command Palette to undo every applied change.</p>
  `;
}

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'render':
      renderView(msg.view);
      break;
    case 'busy':
      resetPresentation(true);
      app().setAttribute('aria-busy', 'true');
      announce(msg.message);
      app().innerHTML =
        `<div class="busy">${escapeHtml(msg.message)}</div>` +
        `<div id="analysis-progress" class="progress-line"></div>` +
        `<div class="actions"><button class="secondary" id="cancel">Cancel</button></div>`;
      document.getElementById('cancel')?.addEventListener('click', () => {
        const p = document.getElementById('analysis-progress');
        if (p) {
          p.textContent = 'Cancelling…';
        }
        post({ type: 'cancel' });
      });
      break;
    case 'progress': {
      const line = document.getElementById('analysis-progress');
      if (line) {
        line.textContent = msg.text;
        announce(msg.text);
      }
      break;
    }
    case 'idle':
      resetPresentation(true, true);
      announce(msg.message);
      app().innerHTML = `<div class="empty">${escapeHtml(msg.message)}</div>`;
      break;
    case 'paused':
      resetPresentation();
      announce('Walkthrough paused.');
      app().innerHTML =
        `<div class="empty">Paused.</div>` +
        `<div class="actions"><button class="primary" id="resume">Resume</button></div>`;
      document.getElementById('resume')?.addEventListener('click', () => post({ type: 'resume' }));
      break;
    case 'applied':
      // The host advances by sending the next 'render'; nothing to do here.
      break;
    case 'conflict':
      showBanner(`Conflict on step ${msg.stepNumber}: ${msg.reason}`, 'warn');
      break;
    case 'error':
      showBanner(msg.message, 'error');
      break;
    case 'completed':
      resetPresentation();
      announce('Walkthrough complete.');
      renderCompleted(msg.applied, msg.skipped, msg.mode);
      break;
    case 'answer':
      fillAnswer(msg.id, renderMarkdown(msg.answer), false);
      break;
    case 'answerError':
      fillAnswer(msg.id, msg.message, true);
      break;
  }
});

post({ type: 'ready' });
