import { describe, it, expect } from 'vitest';
import { formatLogEntry } from './logger';

const FIXED = new Date('2026-07-15T12:00:00.000Z');

describe('formatLogEntry', () => {
  it('includes an ISO timestamp and upper-cased level', () => {
    const line = formatLogEntry('info', 'started', undefined, FIXED);
    expect(line).toBe('[2026-07-15T12:00:00.000Z] INFO started');
  });

  it('appends the error type and stack for errors', () => {
    const err = new TypeError('boom');
    const line = formatLogEntry('error', 'failed to apply', err, FIXED);
    expect(line).toContain('[2026-07-15T12:00:00.000Z] ERROR failed to apply');
    expect(line).toContain('TypeError: boom');
    // stack frames are included (at least one line after the message)
    expect(line.split('\n').length).toBeGreaterThan(2);
  });

  it('coerces a non-Error thrown value', () => {
    const line = formatLogEntry('warn', 'odd', 'a string error', FIXED);
    expect(line).toContain('WARN odd');
    expect(line).toContain('Error: a string error');
  });

  it('omits error detail when no error is given', () => {
    expect(formatLogEntry('info', 'plain', undefined, FIXED)).not.toContain('\n');
  });
});
