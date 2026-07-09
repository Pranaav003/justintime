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
  const dots = view.dots
    .map((status, i) => `<span class="dot ${status}" data-step="${i + 1}" title="Step ${i + 1}"></span>`)
    .join('');

  const actions = view.reviewMode
    ? `<div class="review-note">Reviewing a completed step — read only.</div>`
    : `<div class="actions">
         <button class="primary" id="apply">Apply &amp; Next</button>
         <button class="secondary" id="skip">Skip</button>
         <button class="secondary" id="pause">Pause</button>
       </div>`;

  app().innerHTML = `
    <div class="progress">${dots}<span class="progress-label">Step ${view.stepNumber} of ${view.totalSteps}</span></div>
    <h2 class="title">${escapeHtml(view.title)}</h2>
    <div class="location">📍 <a class="loc-link" data-file="${escapeHtml(view.locationFile)}" data-line="${view.locationLine}">${escapeHtml(view.locationLabel)}</a></div>
    <div class="section"><h3>What's happening</h3>${renderMarkdown(view.genericMarkdown)}</div>
    <div class="section"><h3>Why here</h3>${renderMarkdown(view.specificMarkdown)}</div>
    ${renderRelated(view)}
    ${renderPrereqs(view)}
    ${renderDiff(view.diffHunks)}
    ${actions}
  `;

  document.getElementById('apply')?.addEventListener('click', () => post({ type: 'apply' }));
  document.getElementById('skip')?.addEventListener('click', () => post({ type: 'skip' }));
  document.getElementById('pause')?.addEventListener('click', () => post({ type: 'pause' }));
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

function renderCompleted(applied: number, skipped: number): void {
  app().innerHTML = `
    <h2 class="title">Walkthrough complete</h2>
    <p>${applied} step(s) applied, ${skipped} skipped.</p>
    <div class="actions"><button class="secondary" id="revert">Revert All</button></div>
  `;
  document.getElementById('revert')?.addEventListener('click', () => post({ type: 'openLocation', file: '', line: 0 }));
}

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'render':
      renderView(msg.view);
      break;
    case 'busy':
      app().innerHTML = `<div class="busy">${escapeHtml(msg.message)}</div>`;
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
      renderCompleted(msg.applied, msg.skipped);
      break;
  }
});

post({ type: 'ready' });
