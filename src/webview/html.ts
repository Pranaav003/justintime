/**
 * Builds the webview's HTML shell with a strict Content-Security-Policy and a
 * per-load nonce (design Section 8). Pure and unit-tested. Styles are inlined
 * under the same nonce; the client script is loaded by uri (localResourceRoots-
 * scoped) and also nonce-tagged. No inline scripts, no remote content.
 */

export interface PanelHtmlParams {
  nonce: string;
  cspSource: string;
  scriptUri: string;
}

const PANEL_CSS = `
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 12px 24px; }
#app { max-width: 720px; }
.busy, .empty { opacity: .8; padding: 24px 0; }
.progress-line { opacity: .7; font-family: var(--vscode-editor-font-family, monospace); font-size: .9em; margin: 4px 0 12px; min-height: 1.2em; }
.progress { display: flex; gap: 6px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
.dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--vscode-foreground); cursor: pointer; }
.dot.done { background: var(--vscode-charts-green, #4caf50); border-color: transparent; }
.dot.skipped { background: var(--vscode-charts-yellow, #d1a000); border-color: transparent; }
.dot.current { background: var(--vscode-focusBorder); border-color: transparent; }
.dot.upcoming { background: transparent; }
.progress-label { margin-left: 8px; opacity: .8; }
h2.title { margin: 8px 0; }
.location a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.section { border-top: 1px solid var(--vscode-panel-border); padding: 10px 0; }
.section h3 { margin: 0 0 6px; font-size: 1em; }
.diff { background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: 8px; overflow:auto; }
.diff .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #d16969); white-space: pre; }
.diff .add { color: var(--vscode-gitDecoration-addedResourceForeground, #4caf50); white-space: pre; }
.actions { display: flex; gap: 8px; margin-top: 16px; }
button { font: inherit; padding: 6px 12px; border: none; border-radius: 3px; cursor: pointer; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button:disabled { opacity: .5; cursor: default; }
.banner { padding: 8px; border-radius: 4px; margin: 8px 0; }
.banner.warn { background: var(--vscode-inputValidation-warningBackground); }
.banner.error { background: var(--vscode-inputValidation-errorBackground); }
.review-note { font-style: italic; opacity: .8; margin-top: 12px; }
.chat #chat-log { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.chat-q { font-weight: 600; }
.chat-a { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 6px 10px; border-radius: 3px; }
.chat-a.pending { opacity: .7; font-style: italic; }
.chat-input { display: flex; gap: 6px; }
.chat-input input { flex: 1; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; }
`;

export function buildPanelHtml(p: PanelHtmlParams): string {
  const csp = [
    `default-src 'none'`,
    `base-uri 'none'`,
    `img-src ${p.cspSource} https:`,
    `style-src ${p.cspSource} 'nonce-${p.nonce}'`,
    `script-src 'nonce-${p.nonce}'`,
    `font-src ${p.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${p.nonce}">${PANEL_CSS}</style>
</head>
<body>
  <div id="app"><div class="empty">Starting JustInTime…</div></div>
  <script nonce="${p.nonce}" src="${p.scriptUri}"></script>
</body>
</html>`;
}

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
