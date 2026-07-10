import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Render model-generated markdown to sanitized HTML for the webview. Runs in the
 * webview (a browser context with `window`), so DOMPurify's default instance is
 * bound to the global window. Closes the XSS vector the pressure-test flagged:
 * explanations and any workspace-derived text pass through here before hitting
 * the DOM.
 */

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'ul', 'ol', 'li', 'code', 'pre', 'strong', 'em', 'b', 'i',
  'h1', 'h2', 'h3', 'h4', 'h5', 'blockquote', 'a', 'span',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
const ALLOWED_ATTR = ['href', 'class'];

export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'meta'],
    FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload', 'onmouseover', 'srcset'],
    // Allow only http(s), root-relative, and anchor hrefs — block javascript:,
    // data:, vbscript:, etc.
    ALLOWED_URI_REGEXP: /^(?:(?:https?:)|\/|#|[^a-z])/i,
  });
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape plain text (titles, paths, diff content) before inserting into HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]!);
}
