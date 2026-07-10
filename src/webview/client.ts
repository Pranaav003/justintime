import { renderMarkdown, escapeHtml } from './sanitize';
import type { HostToWebview, WebviewToHost, StepView, DiffHunkView } from './protocol';

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

function renderChat(): string {
  return `<div class="section chat"><h3>Ask about this step</h3>
    <div id="chat-log"></div>
    <div class="chat-input">
      <input id="chat-q" type="text" placeholder="Ask a follow-up question about this step…" />
      <button class="secondary" id="chat-send">Ask</button>
    </div>
  </div>`;
}

function wireChat(): void {
  const input = document.getElementById('chat-q') as HTMLInputElement | null;
  document.getElementById('chat-send')?.addEventListener('click', () => sendChat(input));
  input?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      sendChat(input);
    }
  });
}

function sendChat(input: HTMLInputElement | null): void {
  if (!input) {
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
  post({ type: 'ask', id, question });
}

function fillAnswer(id: number, content: string, isError: boolean): void {
  const el = document.querySelector<HTMLElement>(`.chat-a[data-id="${id}"]`);
  if (!el) {
    return;
  }
  el.classList.remove('pending');
  if (isError) {
    el.innerHTML = '';
    const b = document.createElement('span');
    b.className = 'banner error';
    b.textContent = content; // raw message; textContent escapes
    el.appendChild(b);
  } else {
    el.innerHTML = content; // sanitized markdown HTML from renderMarkdown
  }
}

function renderDiff(hunks: DiffHunkView[]): string {
  if (hunks.length === 0) {
    return '<div class="section"><h3>Change</h3><p>No line edits (file-level change).</p></div>';
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
  return `<div class="section"><h3>Diff preview</h3><div class="diff">${blocks}</div></div>`;
}

function renderRelated(view: StepView): string {
  if (view.relatedFiles.length === 0) {
    return '';
  }
  const items = view.relatedFiles
    .map(
      (r) =>
        `<li><a class="loc-link" data-file="${escapeHtml(r.file)}" data-line="1">${escapeHtml(r.file)}</a> — ${escapeHtml(r.relationship)}</li>`,
    )
    .join('');
  return `<div class="section"><h3>Related context</h3><ul>${items}</ul></div>`;
}

function renderPrereqs(view: StepView): string {
  if (!view.showPrerequisites || view.prerequisites.length === 0) {
    return '';
  }
  const items = view.prerequisites.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  return `<div class="section"><h3>Prerequisites</h3><ul>${items}</ul></div>`;
}

function renderView(view: StepView): void {
  // Coerce numerics before interpolation — defence in depth even though these
  // are host-controlled.
  const stepNum = String(Number(view.stepNumber) | 0);
  const totalSteps = String(Number(view.totalSteps) | 0);
  const locationLine = String(Number(view.locationLine) | 0);

  const dots = view.dots
    .map((status, i) => `<span class="dot ${status}" data-step="${i + 1}" title="Step ${i + 1}"></span>`)
    .join('');

  const explain = view.mode === 'explain';
  const actions = view.reviewMode
    ? `<div class="review-note">Reviewing a previous step — read only.</div>`
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
    <div class="progress">${dots}<span class="progress-label">Step ${stepNum} of ${totalSteps}${explain ? ' · Explain' : ''}</span></div>
    <h2 class="title">${escapeHtml(view.title)}</h2>
    <div class="location">📍 <a class="loc-link" data-file="${escapeHtml(view.locationFile)}" data-line="${locationLine}">${escapeHtml(view.locationLabel)}</a></div>
    <div class="section"><h3>What's happening</h3>${renderMarkdown(view.genericMarkdown)}</div>
    <div class="section"><h3>Why here</h3>${renderMarkdown(view.specificMarkdown)}</div>
    ${renderRelated(view)}
    ${renderPrereqs(view)}
    ${explain ? '' : renderDiff(view.diffHunks)}
    ${actions}
    ${view.reviewMode ? '' : renderChat()}
  `;

  document.getElementById('apply')?.addEventListener('click', () => post({ type: 'apply' }));
  document.getElementById('skip')?.addEventListener('click', () => post({ type: 'skip' }));
  document.getElementById('pause')?.addEventListener('click', () => post({ type: 'pause' }));
  wireChat();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.dot'))) {
    el.addEventListener('click', () => post({ type: 'reviewStep', stepNumber: Number(el.dataset.step) }));
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('.loc-link'))) {
    el.addEventListener('click', () =>
      post({ type: 'openLocation', file: el.dataset.file ?? '', line: Number(el.dataset.line ?? '1') }),
    );
  }
}

function showBanner(message: string, kind: 'warn' | 'error'): void {
  const banner = document.createElement('div');
  banner.className = `banner ${kind}`;
  banner.textContent = message; // textContent — never interpret as HTML
  app().prepend(banner);
}

function renderCompleted(applied: number, skipped: number, mode: string): void {
  const appliedStr = String(Number(applied) | 0);
  const skippedStr = String(Number(skipped) | 0);
  if (mode === 'explain') {
    app().innerHTML = `
      <h2 class="title">Explanation complete</h2>
      <p>${appliedStr} step(s) reviewed, ${skippedStr} skipped.</p>
    `;
    return;
  }
  app().innerHTML = `
    <h2 class="title">Walkthrough complete</h2>
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
      app().innerHTML = `<div class="busy">${escapeHtml(msg.message)}</div><div class="actions"><button class="secondary" id="cancel">Cancel</button></div>`;
      document.getElementById('cancel')?.addEventListener('click', () => post({ type: 'cancel' }));
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
