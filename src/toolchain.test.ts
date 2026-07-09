import { describe, it, expect } from 'vitest';

// Smoke test: proves the vitest toolchain runs before any real modules exist.
// Replaced/augmented by real unit tests in later tasks.
describe('toolchain', () => {
  it('runs vitest and TypeScript transforms', () => {
    const doubled = [1, 2, 3].map((n) => n * 2);
    expect(doubled).toEqual([2, 4, 6]);
  });
});
