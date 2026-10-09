import { describe, it, expect } from 'vitest';
import { findOpenSSL, OPENSSL_FALLBACKS } from '../src/security/identity.js';

// OpenSSL discovery: `openssl` on PATH first; when it is missing or not v3 (stock
// macOS ships LibreSSL), TERMINUS_OPENSSL, then the Homebrew locations (openssl@3
// is keg-only, so it is usually not on PATH). The probe is injected, so no binary
// runs and the machine's real OpenSSL never matters.

type Outcome = string | Error;
function probeFrom(table: Record<string, Outcome>) {
  const calls: string[] = [];
  const probe = async (bin: string): Promise<string> => {
    calls.push(bin);
    const r = table[bin];
    if (r === undefined) throw Object.assign(new Error(`spawn ${bin} ENOENT`), { code: 'ENOENT' });
    if (r instanceof Error) throw r;
    return r;
  };
  return { probe, calls };
}
const noEnv = () => undefined;
const envWith = (vars: Record<string, string>) => (name: string) => vars[name];
const V3 = 'OpenSSL 3.3.1 4 Jun 2024 (Library: OpenSSL 3.3.1 4 Jun 2024)\n';
const LIBRE = 'LibreSSL 3.3.6\n';

describe('findOpenSSL', () => {
  it('uses `openssl` on PATH when it is v3, probing nothing else', async () => {
    const { probe, calls } = probeFrom({ openssl: V3 });
    await expect(findOpenSSL({ probe, env: envWith({ OPENSSL: '/x/openssl' }) })).resolves.toBe('openssl');
    expect(calls).toEqual(['openssl']);
  });

  it('PATH has LibreSSL: falls through to the keg-only Homebrew openssl@3', async () => {
    const brew = '/opt/homebrew/opt/openssl@3/bin/openssl';
    const { probe, calls } = probeFrom({ openssl: LIBRE, [brew]: V3 });
    await expect(findOpenSSL({ probe, env: noEnv })).resolves.toBe(brew);
    expect(calls).toEqual(['openssl', brew]);
  });

  it('tries TERMINUS_OPENSSL before the built-in locations', async () => {
    const { probe, calls } = probeFrom({ '/custom/bin/openssl': V3, '/opt/homebrew/opt/openssl@3/bin/openssl': V3 });
    await expect(findOpenSSL({ probe, env: envWith({ OPENSSL: '/custom/bin/openssl' }) })).resolves.toBe('/custom/bin/openssl');
    expect(calls).toEqual(['openssl', '/custom/bin/openssl']);
  });

  it('skips a TERMINUS_OPENSSL that is not v3 and keeps looking', async () => {
    const intel = '/usr/local/opt/openssl@3/bin/openssl';
    const { probe } = probeFrom({ '/old/openssl': 'OpenSSL 1.1.1w  11 Sep 2023\n', [intel]: V3 });
    await expect(findOpenSSL({ probe, env: envWith({ OPENSSL: '/old/openssl' }) })).resolves.toBe(intel);
  });

  it('tries the documented locations in order', async () => {
    expect(OPENSSL_FALLBACKS).toEqual([
      '/opt/homebrew/opt/openssl@3/bin/openssl',
      '/usr/local/opt/openssl@3/bin/openssl',
      '/opt/homebrew/bin/openssl',
      '/usr/local/bin/openssl',
    ]);
    const { probe, calls } = probeFrom({});
    await findOpenSSL({ probe, env: noEnv }).catch(() => {});
    expect(calls).toEqual(['openssl', ...OPENSSL_FALLBACKS]);
  });

  it('none found: the error lists every candidate tried and what each was', async () => {
    const { probe } = probeFrom({ openssl: LIBRE, '/usr/local/bin/openssl': 'OpenSSL 1.1.1w  11 Sep 2023\n' });
    const err = await findOpenSSL({ probe, env: envWith({ OPENSSL: '/nope/openssl' }) }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = err!.message;
    expect(msg).toMatch(/^OpenSSL 3 not found\./);
    expect(msg).toContain('openssl on PATH (LibreSSL 3.3.6)');
    expect(msg).toContain('/nope/openssl from TERMINUS_OPENSSL (not found)');
    for (const f of OPENSSL_FALLBACKS) expect(msg).toContain(f);
    expect(msg).toContain('/usr/local/bin/openssl (OpenSSL 1.1.1w');
    expect(msg).toContain('brew install openssl@3');
    expect(msg).toContain('TERMINUS_OPENSSL');
    expect(msg).toContain('Linux');
  });

  it('does not probe the same path twice when TERMINUS_OPENSSL names a built-in location', async () => {
    const { probe, calls } = probeFrom({});
    await findOpenSSL({ probe, env: envWith({ OPENSSL: '/usr/local/bin/openssl' }) }).catch(() => {});
    expect(calls.filter((c) => c === '/usr/local/bin/openssl')).toHaveLength(1);
  });
});
