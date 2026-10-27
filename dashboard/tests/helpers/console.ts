/**
 * `console.error`, `console.warn` and Vue warnings fail the test that caused them (the old `Dev/drive.js` did the same: a page that
 * logs an error is a bug). `tests/setup.ts` installs the guard around every test.
 *
 * A test that expects such output says so, and gets the messages to assert on:
 *
 *     const logged = expectConsole('error');      // or expectConsole('error', 'warn')
 *     …
 *     expect(logged.error).toEqual([expect.stringContaining('mock error')]);
 */
export type ConsoleLevel = 'error' | 'warn';

interface Guard {
  recorded: Record<ConsoleLevel, string[]>;
  allowed: Set<ConsoleLevel>;
}

let guard: Guard | null = null;
const original = { error: console.error, warn: console.warn };

const text = (args: unknown[]): string => args.map(a => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

/** Records a message (also used for Vue warnings, which `tests/setup.ts` routes here through `app.config.warnHandler`). */
export function record(level: ConsoleLevel, message: string): void {
  guard?.recorded[level].push(message);
}

export function installConsoleGuard(): void {
  guard = { recorded: { error: [], warn: [] }, allowed: new Set() };
  console.error = (...args: unknown[]) => record('error', text(args));
  console.warn = (...args: unknown[]) => record('warn', text(args));
}

/** Restores the console and returns what the test logged without declaring it (empty when the test was clean). */
export function removeConsoleGuard(): string[] {
  console.error = original.error;
  console.warn = original.warn;
  const g = guard;
  guard = null;
  if (!g) return [];
  return (['error', 'warn'] as const).flatMap(level => (g.allowed.has(level) ? [] : g.recorded[level].map(m => `console.${level}: ${m}`)));
}

/** Declares that this test expects output at these levels. Returns the live message lists. */
export function expectConsole(...levels: ConsoleLevel[]): Record<ConsoleLevel, string[]> {
  if (!guard) throw new Error('expectConsole() works inside a test only.');
  for (const level of levels.length ? levels : (['error', 'warn'] as const)) guard.allowed.add(level);
  return guard.recorded;
}
