import type { Entry } from './types.js';
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
export function toCurl(e: Entry): string {
  const parts = [`curl -X ${e.method} ${q(e.url)}`];
  for (const [k, v] of Object.entries(e.requestHeaders)) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (e.requestBody !== null) parts.push(`--data-raw ${q(e.requestBody)}`);
  return parts.join(' ');
}
