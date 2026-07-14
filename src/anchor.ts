import type { AnchoredHunk } from './types';

/**
 * Content anchoring for diff hunks. Pure — no VS Code, no fs.
 *
 * A hunk is located by matching its `contextBefore + oldText + contextAfter`
 * block against the current file, line by line, after normalizing CRLF->LF and
 * tolerating trailing whitespace. Absolute line numbers are never trusted; this
 * is what makes JustInTime immune to line-drift and to the extension's own
 * prior edits shifting later steps (design Sections 3 & 5).
 *
 * Line indices in results are 0-based into the normalized (LF) line array.
 */

export type AnchorResult =
  | { status: 'ok'; startLine: number; endLineExclusive: number; replacementLines: string[] }
  | { status: 'not_found' }
  | { status: 'ambiguous'; count: number };

export type ApplyResult =
  | { status: 'ok'; text: string }
  | { status: 'error'; reason: 'not_found' | 'ambiguous' | 'overlap'; hunkIndex: number };

/** Split into lines on LF after CRLF normalization; keeps a trailing empty element. */
function toFileLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Split a hunk field into lines, dropping a single trailing empty element caused
 * by a trailing newline (models frequently append one). An empty string yields
 * zero lines (i.e. "no context" / "no replacement").
 */
function toHunkLines(text: string): string[] {
  if (text === '') {
    return [];
  }
  const parts = text.replace(/\r\n/g, '\n').split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  return parts;
}

/** Line equality tolerant of trailing spaces/tabs only (leading indentation is significant). */
function lineEq(a: string, b: string): boolean {
  return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
}

function findAnchorOnLines(fileLines: string[], h: AnchoredHunk): AnchorResult {
  const before = toHunkLines(h.contextBefore);
  const old = toHunkLines(h.oldText);
  const after = toHunkLines(h.contextAfter);
  const block = [...before, ...old, ...after];
  if (block.length === 0) {
    return { status: 'not_found' };
  }

  const starts: number[] = [];
  // A file ending in a newline yields a trailing '' from the split; excluding it
  // prevents a blank-line block element from phantom-matching that artifact.
  const searchLen =
    fileLines.length > 0 && fileLines[fileLines.length - 1] === '' ? fileLines.length - 1 : fileLines.length;
  for (let i = 0; i + block.length <= searchLen; i++) {
    let matched = true;
    for (let j = 0; j < block.length; j++) {
      if (!lineEq(fileLines[i + j]!, block[j]!)) {
        matched = false;
        break;
      }
    }
    if (matched) {
      starts.push(i);
    }
  }

  if (starts.length === 0) {
    return { status: 'not_found' };
  }
  if (starts.length > 1) {
    return { status: 'ambiguous', count: starts.length };
  }

  const start = starts[0]! + before.length;
  return {
    status: 'ok',
    startLine: start,
    endLineExclusive: start + old.length,
    replacementLines: toHunkLines(h.newText),
  };
}

/** Locate a single hunk within a file. */
export function findAnchor(fileText: string, h: AnchoredHunk): AnchorResult {
  return findAnchorOnLines(toFileLines(fileText), h);
}

/**
 * Locate a verbatim snippet in a file, returning a 1-based inclusive line range,
 * or undefined if it isn't found uniquely. Used to anchor navigation/highlights
 * to the real code instead of trusting the model's advisory line numbers.
 */
export function locateSnippet(fileText: string, snippet: string): { startLine: number; endLine: number } | undefined {
  const r = findAnchor(fileText, { contextBefore: '', oldText: snippet, newText: '', contextAfter: '' });
  if (r.status !== 'ok' || r.endLineExclusive <= r.startLine) {
    return undefined;
  }
  return { startLine: r.startLine + 1, endLine: r.endLineExclusive };
}

/**
 * Apply every hunk against the ORIGINAL file (each anchored independently),
 * then splice from the bottom up so earlier edits don't shift later indices.
 * Overlapping regions are rejected. Preserves the file's dominant EOL.
 *
 * Used for the diff-preview "after" text; the VS Code applier builds an
 * equivalent WorkspaceEdit from the same anchors.
 */
export function applyHunks(fileText: string, hunks: AnchoredHunk[]): ApplyResult {
  const eol = fileText.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = toFileLines(fileText);

  const regions: { startLine: number; endLineExclusive: number; replacementLines: string[]; index: number }[] = [];
  for (let k = 0; k < hunks.length; k++) {
    const r = findAnchorOnLines(fileLines, hunks[k]!);
    if (r.status !== 'ok') {
      return { status: 'error', reason: r.status, hunkIndex: k };
    }
    regions.push({ startLine: r.startLine, endLineExclusive: r.endLineExclusive, replacementLines: r.replacementLines, index: k });
  }

  // Sort descending by start so splices don't invalidate later indices.
  regions.sort((a, b) => b.startLine - a.startLine);
  for (let k = 0; k < regions.length - 1; k++) {
    const higher = regions[k]!; // later in the file
    const lower = regions[k + 1]!; // earlier in the file
    if (lower.endLineExclusive > higher.startLine) {
      return { status: 'error', reason: 'overlap', hunkIndex: lower.index };
    }
  }

  const out = fileLines.slice();
  for (const r of regions) {
    out.splice(r.startLine, r.endLineExclusive - r.startLine, ...r.replacementLines);
  }
  return { status: 'ok', text: out.join(eol) };
}
