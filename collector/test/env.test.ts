import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from '../src/env.js';

// Each case uses a distinct variable name so the module-level "warn once" set
// never bleeds between assertions.
describe('env() TERMINUS_/NETCAPTURE_ fallback', () => {
  const touched: string[] = [];
  const set = (k: string, v: string) => { touched.push(k); process.env[k] = v; };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => {
    warnSpy.mockRestore();
    for (const k of touched.splice(0)) delete process.env[k];
  });

  it('prefers TERMINUS_ and does not warn', () => {
    set('TERMINUS_PREF', 'new');
    set('NETCAPTURE_PREF', 'old');
    expect(env('PREF')).toBe('new');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to NETCAPTURE_ with a deprecation warning', () => {
    set('NETCAPTURE_FALLBACK', 'legacy');
    expect(env('FALLBACK')).toBe('legacy');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0].join(' ');
    expect(msg).toContain('NETCAPTURE_FALLBACK is deprecated, use TERMINUS_FALLBACK');
  });

  it('warns only once per name across repeated reads', () => {
    set('NETCAPTURE_ONCE', 'legacy');
    env('ONCE'); env('ONCE'); env('ONCE');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('treats empty string as unset and returns undefined when neither is set', () => {
    set('TERMINUS_EMPTY', '');
    expect(env('EMPTY')).toBeUndefined();
    expect(env('MISSING')).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
