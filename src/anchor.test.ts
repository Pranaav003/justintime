import { describe, it, expect } from 'vitest';
import { findAnchor, applyHunks } from './anchor';
import type { AnchoredHunk } from './types';

function hunk(partial: Partial<AnchoredHunk>): AnchoredHunk {
  return { contextBefore: '', oldText: '', newText: '', contextAfter: '', ...partial };
}

const file = ['function checkout() {', '  cart.total += item.price;', '  return cart;', '}'].join('\n');

describe('findAnchor', () => {
  it('locates a unique hunk and returns its line range + replacement', () => {
    const r = findAnchor(
      file,
      hunk({
        contextBefore: 'function checkout() {',
        oldText: '  cart.total += item.price;',
        newText: '  await lock.run(() => { cart.total += item.price; });',
        contextAfter: '  return cart;',
      }),
    );
    expect(r).toEqual({
      status: 'ok',
      startLine: 1,
      endLineExclusive: 2,
      replacementLines: ['  await lock.run(() => { cart.total += item.price; });'],
    });
  });

  it('returns not_found when oldText is absent', () => {
    const r = findAnchor(file, hunk({ oldText: '  cart.total -= item.price;' }));
    expect(r.status).toBe('not_found');
  });

  it('returns ambiguous when the block matches more than once', () => {
    const dup = ['x();', 'x();'].join('\n');
    const r = findAnchor(dup, hunk({ oldText: 'x();', newText: 'y();' }));
    expect(r).toEqual({ status: 'ambiguous', count: 2 });
  });

  it('disambiguates a repeated line using context', () => {
    const dup = ['a', 'x();', 'b', 'x();', 'c'].join('\n');
    const r = findAnchor(
      dup,
      hunk({ contextBefore: 'b', oldText: 'x();', newText: 'y();', contextAfter: 'c' }),
    );
    expect(r).toEqual({ status: 'ok', startLine: 3, endLineExclusive: 4, replacementLines: ['y();'] });
  });

  it('matches a CRLF file against an LF hunk', () => {
    const crlf = ['let a = 1;', 'let b = 2;'].join('\r\n');
    const r = findAnchor(crlf, hunk({ oldText: 'let b = 2;', newText: 'let b = 3;' }));
    expect(r).toEqual({ status: 'ok', startLine: 1, endLineExclusive: 2, replacementLines: ['let b = 3;'] });
  });

  it('tolerates trailing whitespace differences', () => {
    const trailing = 'const x = 1;   \nconst y = 2;';
    const r = findAnchor(trailing, hunk({ oldText: 'const x = 1;', newText: 'const x = 42;' }));
    expect(r.status).toBe('ok');
  });

  it('supports pure insertion (empty oldText) between context lines', () => {
    const r = findAnchor(
      file,
      hunk({ contextBefore: 'function checkout() {', oldText: '', newText: '  const lock = new Lock();', contextAfter: '  cart.total += item.price;' }),
    );
    expect(r).toEqual({ status: 'ok', startLine: 1, endLineExclusive: 1, replacementLines: ['  const lock = new Lock();'] });
  });

  it('returns not_found for an empty anchor block', () => {
    expect(findAnchor(file, hunk({})).status).toBe('not_found');
  });
});

describe('applyHunks', () => {
  it('applies a single hunk and preserves LF endings', () => {
    const r = applyHunks(file, [
      hunk({ oldText: '  return cart;', newText: '  return Object.freeze(cart);' }),
    ]);
    expect(r).toEqual({
      status: 'ok',
      text: ['function checkout() {', '  cart.total += item.price;', '  return Object.freeze(cart);', '}'].join('\n'),
    });
  });

  it('preserves CRLF endings in the output', () => {
    const crlf = ['a();', 'b();'].join('\r\n');
    const r = applyHunks(crlf, [hunk({ oldText: 'b();', newText: 'c();' })]);
    expect(r).toEqual({ status: 'ok', text: 'a();\r\nc();' });
  });

  it('applies multiple non-overlapping hunks correctly', () => {
    const r = applyHunks(file, [
      hunk({ oldText: '  cart.total += item.price;', newText: '  cart.total += item.price * qty;' }),
      hunk({ oldText: '  return cart;', newText: '  return cart.snapshot();' }),
    ]);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.text).toContain('* qty;');
      expect(r.text).toContain('cart.snapshot()');
    }
  });

  it('errors when two hunks overlap', () => {
    const r = applyHunks(file, [
      hunk({ contextBefore: 'function checkout() {', oldText: '  cart.total += item.price;', newText: 'A' }),
      hunk({ oldText: '  cart.total += item.price;\n  return cart;', newText: 'B' }),
    ]);
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.reason).toBe('overlap');
    }
  });

  it('errors with the hunk index when a hunk cannot be anchored', () => {
    const r = applyHunks(file, [hunk({ oldText: 'does.not.exist();', newText: 'nope' })]);
    expect(r).toEqual({ status: 'error', reason: 'not_found', hunkIndex: 0 });
  });

  it('supports deletion (empty newText removes the matched lines)', () => {
    const r = applyHunks(file, [hunk({ oldText: '  cart.total += item.price;\n', newText: '' })]);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.text).toBe(['function checkout() {', '  return cart;', '}'].join('\n'));
    }
  });
});
