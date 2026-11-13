import { describe, it, expect } from 'vitest';
import { buildPanelHtml, makeNonce } from './html';

describe('buildPanelHtml', () => {
  const html = buildPanelHtml({
    nonce: 'NONCE123',
    cspSource: 'vscode-webview://abc',
    scriptUri: 'https://file+.vscode-resource/dist/panel.js',
  });

  it('provides a named document, main landmark and persistent narrow announcer', () => {
    expect(html).toContain('<title>JustInTime walkthrough</title>');
    expect(html).toContain('<main id="app"');
    expect(html).toMatch(/<\/main>\s*<div id="announcer"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).not.toMatch(/id="app"[^>]*aria-live/);
  });

  it('sets a strict CSP with default-src none', () => {
    expect(html).toContain("default-src 'none'");
  });

  it('only allows nonce-tagged scripts (no unsafe-inline)', () => {
    expect(html).toContain("script-src 'nonce-NONCE123'");
    const scriptSrc = html.match(/script-src[^;]*/)![0];
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('loads the bundled script by uri with the nonce', () => {
    expect(html).toContain('src="https://file+.vscode-resource/dist/panel.js"');
    expect(html).toContain('nonce="NONCE123"');
  });

  it('scopes styles to the cspSource + nonce', () => {
    const styleSrc = html.match(/style-src[^;]*/)![0];
    expect(styleSrc).toContain('vscode-webview://abc');
    expect(styleSrc).toContain("'nonce-NONCE123'");
  });
});

describe('makeNonce', () => {
  it('produces a 32-char hex nonce', () => {
    expect(makeNonce()).toMatch(/^[0-9a-f]{32}$/);
  });
  it('is different each call', () => {
    expect(makeNonce()).not.toBe(makeNonce());
  });
});
