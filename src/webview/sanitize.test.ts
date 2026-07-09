// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderMarkdown, escapeHtml } from './sanitize';

describe('renderMarkdown', () => {
  it('renders basic markdown to safe HTML', () => {
    const html = renderMarkdown('**bold** and `code`');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('strips <script> tags injected via model output (XSS)', () => {
    const html = renderMarkdown('hi\n\n<script>window.__pwned = 1</script>');
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toContain('__pwned');
  });

  it('strips event-handler attributes and javascript: hrefs', () => {
    const html = renderMarkdown('<a href="javascript:alert(1)" onclick="steal()">x</a>');
    expect(html.toLowerCase()).not.toContain('onclick');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('strips inline style attributes', () => {
    const html = renderMarkdown('<span style="position:fixed">x</span>');
    expect(html.toLowerCase()).not.toContain('style=');
  });
});

describe('escapeHtml', () => {
  it('escapes angle brackets and quotes for non-markdown content', () => {
    expect(escapeHtml(`<b>"x" & 'y'</b>`)).toBe('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;');
  });
});
