// IP literal normalisation and the address ranges the collector refuses as a
// destination. PURE: no Node or DOM import, because the rule model (ruleModel.ts)
// runs in the UI too. The Node-side destination guard (proxy/destGuard.ts) and the
// stream replay SSRF guard (streamReplay.ts) build on it.
//
// A host string can name the same address in many spellings, and a literal string
// compare (`host === '169.254.169.254'`) misses most of them:
//
//   IPv4    every form inet_aton / getaddrinfo accepts: dotted quad, fewer parts
//           (`169.254.43518`, `169.16689662`), one 32-bit number (`2852039166`),
//           octal (`0251.0376.0251.0376`) and hex (`0xa9.0xfe.0xa9.0xfe`, `0xa9fea9fe`)
//   IPv6    any compression, a dotted IPv4 tail, a zone id (`fe80::1%en0`),
//           brackets (`[::1]`); and an IPv4 address embedded in IPv6 is unwrapped:
//           IPv4-mapped `::ffff:a9fe:a9fe`, SIIT `::ffff:0:a.b.c.d`, the deprecated
//           IPv4-compatible `::a.b.c.d`, and NAT64 `64:ff9b::/96` and
//           `64:ff9b:1::/48` (last 32 bits).
//
// Every check below compares the canonical form.

export type IpLiteral = { family: 4; address: string; v4: number } | { family: 6; address: string; words: number[] };

const DEC = /^(?:0|[1-9][0-9]*)$/;
const OCT = /^0[0-7]+$/;
const HEX = /^0x[0-9a-f]*$/i;

function part(s: string): number | null {
  if (HEX.test(s)) return s.length === 2 ? 0 : parseInt(s.slice(2), 16);
  if (OCT.test(s)) return parseInt(s.slice(1), 8);
  if (DEC.test(s)) return Number(s);
  return null;
}

// An IPv4 literal in any inet_aton form, as a 32-bit number; null otherwise.
export function parseIpv4Loose(input: string): number | null {
  if (input === '' || input.length > 64) return null;
  const parts = input.split('.');
  if (parts.length > 4 || parts.some((p) => p === '')) return null;
  const nums = parts.map(part);
  if (nums.some((n) => n == null || !Number.isFinite(n))) return null;
  const n = nums as number[];
  const last = n[n.length - 1];
  const lastMax = 2 ** (8 * (5 - n.length)) - 1;
  if (last > lastMax) return null;
  let v = 0;
  for (let i = 0; i < n.length - 1; i++) {
    if (n[i] > 255) return null;
    v += n[i] * 2 ** (8 * (3 - i));
  }
  return v + last;
}

// A strict dotted quad (the only IPv4 spelling allowed as an IPv6 tail).
function strictQuad(s: string): number | null {
  const p = s.split('.');
  if (p.length !== 4 || !p.every((x) => /^(?:0|[1-9][0-9]{0,2})$/.test(x) && Number(x) <= 255)) return null;
  return p.reduce((acc, x) => acc * 256 + Number(x), 0);
}

// An IPv6 literal as eight 16-bit words; null otherwise. A zone id is dropped.
export function parseIpv6(input: string): number[] | null {
  let s = input;
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (s === '' || s.length > 64 || !s.includes(':')) return null;
  // A dotted IPv4 tail becomes its two hex words.
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const q = strictQuad(s.slice(lastColon + 1));
    if (q == null) return null;
    s = `${s.slice(0, lastColon + 1)}${Math.floor(q / 65536).toString(16)}:${(q % 65536).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const group = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = group(halves[0]);
  const rest = halves.length === 2 ? group(halves[1]) : [];
  if (head == null || rest == null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

const quad = (v: number): string => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');

function v6String(w: number[]): string {
  // RFC 5952: compress the longest run (2+) of zero words, lower-case hex.
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (w[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = w.map((x) => x.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

// The IPv4 address an IPv6 one carries (mapped, SIIT, compatible, NAT64), or null.
function embeddedV4(w: number[]): number | null {
  const zero = (from: number, to: number): boolean => w.slice(from, to).every((x) => x === 0);
  const low = w[6] * 65536 + w[7];
  if (zero(0, 5) && w[5] === 0xffff) return low; // ::ffff:a.b.c.d
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return low; // ::ffff:0:a.b.c.d
  if (zero(0, 6) && low > 1) return low; // ::a.b.c.d (not :: or ::1)
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return low; // 64:ff9b::/96
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return low; // 64:ff9b:1::/48
  return null;
}

// The canonical address a host string names when it is an IP literal (brackets,
// a trailing dot on IPv4 and letter case tolerated), with any IPv4 embedded in
// IPv6 unwrapped to IPv4; null for a DNS name.
export function parseIpLiteral(host: string): IpLiteral | null {
  let s = host.trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) {
    const v4 = parseIpv4Loose(s.endsWith('.') ? s.slice(0, -1) : s);
    return v4 == null ? null : { family: 4, address: quad(v4), v4 };
  }
  const w = parseIpv6(s);
  if (w == null) return null;
  const inner = embeddedV4(w);
  if (inner != null) return { family: 4, address: quad(inner), v4: inner };
  return { family: 6, address: v6String(w), words: w };
}

const inV4 = (v: number, base: string, bits: number): boolean => {
  const b = parseIpv4Loose(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(v / size) === Math.floor(b / size);
};

// The cloud metadata range: IPv4 link-local 169.254.0.0/16 (AWS, GCP, Azure,
// OCI and others serve instance credentials at 169.254.169.254) and the AWS IPv6
// metadata address fd00:ec2::254. Always refused as a destination.
export function isMetadataAddress(host: string): boolean {
  const ip = parseIpLiteral(host);
  if (!ip) return false;
  if (ip.family === 4) return inV4(ip.v4, '169.254.0.0', 16);
  return ip.address === 'fd00:ec2::254';
}

// Metadata service NAMES that resolve to the metadata address inside a cloud VM
// (GCP's `metadata.google.internal`, and the bare `metadata` its search domain
// completes). Refused by name, before any resolution.
const METADATA_NAMES: ReadonlySet<string> = new Set(['metadata.google.internal', 'metadata']);
export function isMetadataName(host: string): boolean {
  return METADATA_NAMES.has(host.trim().toLowerCase().replace(/\.$/, ''));
}

export function isMetadataHost(host: string): boolean {
  return isMetadataName(host) || isMetadataAddress(host);
}

// Addresses that only make sense on the collector machine itself (or its link):
// loopback (127.0.0.0/8, ::1), unspecified / "this host" (0.0.0.0/8, ::) and
// link-local (169.254.0.0/16, fe80::/10). Null for any other address or a name.
export type LocalKind = 'loopback' | 'unspecified' | 'link-local';
export function localAddressKind(host: string): LocalKind | null {
  const ip = parseIpLiteral(host);
  if (!ip) return null;
  if (ip.family === 4) {
    if (inV4(ip.v4, '127.0.0.0', 8)) return 'loopback';
    if (inV4(ip.v4, '0.0.0.0', 8)) return 'unspecified';
    if (inV4(ip.v4, '169.254.0.0', 16)) return 'link-local';
    return null;
  }
  const w = ip.words;
  if (w.slice(0, 7).every((x) => x === 0)) return w[7] === 1 ? 'loopback' : w[7] === 0 ? 'unspecified' : null;
  if ((w[0] & 0xffc0) === 0xfe80) return 'link-local';
  return null;
}
