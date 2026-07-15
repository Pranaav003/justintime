/**
 * Structured log formatting (pure — no VS Code). The extension pipes these
 * lines to an OutputChannel; keeping the formatter pure makes it unit-testable
 * and guarantees every entry carries a timestamp, level, and (for errors) the
 * error type + stack.
 */

export type LogLevel = 'error' | 'warn' | 'info';

export function formatLogEntry(level: LogLevel, message: string, error?: unknown, now: Date = new Date()): string {
  let line = `[${now.toISOString()}] ${level.toUpperCase()} ${message}`;
  if (error !== undefined) {
    const err = error instanceof Error ? error : new Error(String(error));
    line += `\n  ${err.name}: ${err.message}`;
    if (err.stack) {
      const frames = err.stack.split('\n').slice(1);
      if (frames.length > 0) {
        line += `\n  ${frames.join('\n  ')}`;
      }
    }
  }
  return line;
}
