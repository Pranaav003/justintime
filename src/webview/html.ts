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
* { box-sizing: border-box; }
body { margin: 0; padding: 20px 16px 32px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.55; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
#app { width: 100%; max-width: 760px; margin: 0 auto; overflow-wrap: anywhere; }
.brand { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-bottom: 16px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); font-weight: 600; }
.mode { padding: 2px 8px; border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); border-radius: 4px; font-size: .9em; font-weight: 400; color: var(--vscode-descriptionForeground); }
.progress-label { margin-top: 16px; color: var(--vscode-descriptionForeground); font-size: .95em; }
.progress { display: flex; gap: 8px; flex-wrap: wrap; list-style: none; padding: 0; margin: 8px 0 20px; }
.progress li { min-width: 0; }
.dot { display: flex; gap: 6px; align-items: center; padding: 4px 8px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); }
.step-number { font-weight: 600; }
.step-status { font-size: .85em; }
.dot.current { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
h1.title { font-size: 1.55em; line-height: 1.3; margin: 0 0 16px; font-weight: 600; }
.location { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; margin: 0 0 20px; }
.eyebrow { font-size: .9em; color: var(--vscode-descriptionForeground); }
button.loc-link { background: transparent; color: var(--vscode-textLink-foreground); border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); text-align: left; max-width: 100%; }
.section { min-width: 0; border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); border-radius: 6px; padding: 16px; margin: 12px 0; }
.section h2 { margin: 0 0 10px; font-size: 1em; font-weight: 600; }
.section p { margin: 8px 0; }
.section > :last-child { margin-bottom: 0; }
ul, ol { padding-left: 24px; }
li + li { margin-top: 6px; }
.progress li + li { margin-top: 0; }
pre, .diff { max-width: 100%; overflow: auto; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); border-radius: 4px; padding: 12px; }
pre, code, .diff { font-family: var(--vscode-editor-font-family, monospace); font-size: .95em; }
pre { white-space: pre; overflow-wrap: normal; }
pre code { font-size: inherit; }
code { overflow-wrap: anywhere; }
.diff .del { color: var(--vscode-gitDecoration-deletedResourceForeground); white-space: pre; }
.diff .add { color: var(--vscode-gitDecoration-addedResourceForeground); white-space: pre; }
table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
th, td { text-align: left; border: 1px solid var(--vscode-panel-border); padding: 6px 10px; }
img { max-width: 100%; height: auto; }
a { color: var(--vscode-textLink-foreground); }
blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid var(--vscode-textBlockQuote-border); }
.action-area { padding: 16px 0; margin: 8px 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
#action-status:empty { display: none; }
#action-status { margin: 10px 0 0; color: var(--vscode-descriptionForeground); }
button { min-height: 32px; min-width: 32px; max-width: 100%; font: inherit; line-height: 1.4; padding: 6px 12px; border: 1px solid var(--vscode-contrastBorder, transparent); border-radius: 3px; cursor: pointer; overflow-wrap: anywhere; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.dot:hover:not(:disabled), button.loc-link:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground, var(--vscode-foreground)); }
button:disabled, input:disabled { opacity: .6; cursor: default; }
:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
.banner { padding: 12px; border: 1px solid; border-radius: 4px; margin: 12px 0; }
.banner.warn { background: var(--vscode-inputValidation-warningBackground); border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-contrastBorder, transparent)); color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground)); }
.banner.error { background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-contrastBorder, transparent)); color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground)); }
.review-note { color: var(--vscode-descriptionForeground); margin: 0 0 12px; }
.busy, .empty { padding: 24px 0; }
.progress-line { color: var(--vscode-descriptionForeground); margin: 4px 0 16px; }
.chat #chat-log { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
.chat-q { font-weight: 600; }
.chat-a { min-width: 0; background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 8px 12px; }
.chat-a.pending { color: var(--vscode-descriptionForeground); }
.chat-a .banner { display: block; }
.chat label { display: block; margin-bottom: 6px; }
.chat-input { display: flex; gap: 8px; align-items: stretch; }
.chat-input input { min-width: 0; width: 100%; flex: 1; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent)); border-radius: 3px; font: inherit; }
.chat-input input::placeholder { color: var(--vscode-input-placeholderForeground); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 360px) { body { padding: 16px 12px 24px; } .section { padding: 12px; } .chat-input { flex-wrap: wrap; } .chat-input input { flex-basis: 100%; } }
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
  <title>JustInTime walkthrough</title>
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${p.nonce}">${PANEL_CSS}</style>
</head>
<body>
  <main id="app" aria-label="JustInTime walkthrough"><div class="empty">Starting JustInTime…</div></main>
  <div id="announcer" role="status" aria-live="polite" aria-atomic="true" class="sr-only"></div>
  <script nonce="${p.nonce}" src="${p.scriptUri}"></script>
</body>
</html>`;
}

export function makeNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
