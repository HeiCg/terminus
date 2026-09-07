import os from 'node:os';
import {
  acquireStateLock, createIdentity, currentGeneration, defaultStateDir, ensureOpenSSL,
  migrateLegacyStateDir, validateSanTargets, DEFAULT_INGEST_PORT, DEFAULT_ATLANTIS_PORT,
} from './identity.js';

// Parse `--host h --ip a --ip b [--state-dir d] [--ingest-port n] [--atlantis-port n]`.
export function parseRotateArgs(argv: string[]): { host?: string; ips: string[]; stateDir?: string; ingestPort?: number; atlantisPort?: number } {
  const out: { host?: string; ips: string[]; stateDir?: string; ingestPort?: number; atlantisPort?: number } = { ips: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (v == null) throw new Error(`missing value for ${a}`); return v; };
    if (a === '--host') out.host = next();
    else if (a === '--ip') out.ips.push(next());
    else if (a === '--state-dir') out.stateDir = next();
    else if (a === '--ingest-port') out.ingestPort = Number(next());
    else if (a === '--atlantis-port') out.atlantisPort = Number(next());
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

// Reissue the collector identity: new UUID, certificate/key and device token,
// generation bumped. Runs only with the collector stopped (state-dir lock), replaces
// files atomically, opens no listener, and forces re-pairing of every device.
export async function rotateIdentity(argv: string[]): Promise<{ collectorId: string; generation: number; certificateSha256: string }> {
  await ensureOpenSSL();
  const args = parseRotateArgs(argv);
  const host = args.host ?? os.hostname().replace(/\.local$/, '');
  const ips = args.ips.length ? args.ips : undefined;
  // Validate hostname/IPs before they reach the openssl argv.
  validateSanTargets(host, ips ?? []);
  const stateDir = args.stateDir ?? defaultStateDir();
  const ports = { ingestPort: args.ingestPort ?? DEFAULT_INGEST_PORT, atlantisPort: args.atlantisPort ?? DEFAULT_ATLANTIS_PORT };

  // Migrate a legacy state dir before locking, but only when the caller did not
  // pin an explicit --state-dir (that is its own opt-out, like the env override).
  if (!args.stateDir) await migrateLegacyStateDir(stateDir);
  const release = await acquireStateLock(stateDir);
  try {
    const generation = (await currentGeneration(stateDir)) + 1;
    const id = await createIdentity(stateDir, { host, ips, generation }, ports);
    return { collectorId: id.collectorId, generation: id.generation, certificateSha256: id.certificateSha256 };
  } finally {
    await release();
  }
}

// CLI entrypoint (`npm run identity:rotate -- --host <hostname> --ip <ip>`).
async function main() {
  try {
    const res = await rotateIdentity(process.argv.slice(2));
    console.log(`[terminus] rotated identity: collectorId ${res.collectorId}, generation ${res.generation}`);
    console.log(`[terminus] certificate sha256: ${res.certificateSha256}`);
    console.log('[terminus] every device must be re-paired from the authenticated UI (GET /api/pairing).');
  } catch (e) {
    console.error('[terminus] rotate failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

// Run only when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) void main();
