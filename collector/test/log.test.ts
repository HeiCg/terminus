import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { log } from '../src/log.js';

// The level is read from process.env on every call, so each case sets it fresh.
describe('log levels and prefix (T5.1)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  const saved = process.env.TERMINUS_LOG_LEVEL;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved == null) delete process.env.TERMINUS_LOG_LEVEL; else process.env.TERMINUS_LOG_LEVEL = saved;
    delete process.env.NETCAPTURE_LOG_LEVEL;
  });

  it('default (unset) level is info: info/warn/error emit, debug does not', () => {
    delete process.env.TERMINUS_LOG_LEVEL;
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('level error silences info and warn but not error', () => {
    process.env.TERMINUS_LOG_LEVEL = 'error';
    log.info('i'); log.warn('w'); log.error('e');
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('level debug enables debug', () => {
    process.env.TERMINUS_LOG_LEVEL = 'debug';
    log.debug('d');
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('reads the deprecated NETCAPTURE_LOG_LEVEL spelling', () => {
    delete process.env.TERMINUS_LOG_LEVEL;
    process.env.NETCAPTURE_LOG_LEVEL = 'error';
    log.info('i'); log.error('e');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('prefixes [terminus], an ISO-8601 timestamp, and the upper-case level, keeping args', () => {
    process.env.TERMINUS_LOG_LEVEL = 'info';
    log.warn('hello', 42);
    const [head, ...rest] = warnSpy.mock.calls[0];
    expect(head).toMatch(/^\[terminus\] \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z WARN$/);
    expect(rest).toEqual(['hello', 42]);
  });

  it('an invalid level warns once and falls back to info', () => {
    process.env.TERMINUS_LOG_LEVEL = 'chatty';
    log.info('still emits');
    expect(logSpy).toHaveBeenCalledTimes(1); // info still emitted under the fallback
    const warned = warnSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(warned).toContain('invalid TERMINUS_LOG_LEVEL');
  });
});
