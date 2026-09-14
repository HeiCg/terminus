const prefix = '[terminus]';

// Severity levels, lowest to highest. A message is emitted when its level is at or
// above the configured threshold, so `warn` silences `debug`/`info` and `error`
// silences everything below it.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Level is read straight from the environment, never through env.ts: env.ts imports
// this module, so importing it back would be a cycle. The deprecated NETCAPTURE_
// spelling is honoured here directly (env()'s once-per-name warning does not apply
// before the logger itself exists).
let invalidWarned = false;
function currentLevel(): LogLevel {
  const raw = process.env.TERMINUS_LOG_LEVEL ?? process.env.NETCAPTURE_LOG_LEVEL;
  if (raw == null || raw === '') return 'info';
  const v = raw.toLowerCase();
  if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
  // An unrecognized value falls back to `info` and warns once, so a typo is visible
  // without flooding every subsequent line.
  if (!invalidWarned) {
    invalidWarned = true;
    write('warn', console.warn, [`invalid TERMINUS_LOG_LEVEL "${raw}", using "info"`]);
  }
  return 'info';
}

// Prefix every line with the name, an ISO-8601 timestamp, and the upper-case level,
// e.g. `[terminus] 2026-09-14T10:00:00.000Z WARN ...`.
function write(level: LogLevel, sink: (...a: unknown[]) => void, args: unknown[]): void {
  sink(`${prefix} ${new Date().toISOString()} ${level.toUpperCase()}`, ...args);
}

function emit(level: LogLevel, sink: (...a: unknown[]) => void, args: unknown[]): void {
  if (RANK[level] < RANK[currentLevel()]) return;
  write(level, sink, args);
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', console.debug, a),
  info: (...a: unknown[]) => emit('info', console.log, a),
  warn: (...a: unknown[]) => emit('warn', console.warn, a),
  error: (...a: unknown[]) => emit('error', console.error, a),
};
