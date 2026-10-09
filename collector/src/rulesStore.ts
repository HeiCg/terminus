import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from './log.js';
import { validateRulesBody, formatRuleError, type Rule } from './ruleModel.js';

// The active interception rules (U6) and their persistence in
// `<stateDir>/rules.json` (0600, atomic write). One instance is shared by the
// admin API (`GET/PUT /api/rules`, `PATCH /api/rules/:id`) and the proxy source,
// which reads `list()` per request. The list is immutable: every change swaps in
// a new array, so a request in flight keeps the snapshot it started with. A change
// is persisted first and only then applied, so a failed write changes nothing.

export const RULES_FILE = 'rules.json';

export class RulesStore {
  private rules: readonly Rule[];

  constructor(initial: readonly Rule[] = [], private readonly file?: string) {
    this.rules = Object.freeze([...initial]);
  }

  list(): readonly Rule[] { return this.rules; }

  // Validate and replace the whole list. Rules without an id get a fresh one.
  replace(body: unknown): { ok: true; rules: readonly Rule[] } | { ok: false; path: string; message: string } {
    const v = validateRulesBody(body, () => randomUUID());
    if (!v.ok) return v;
    this.commit(v.value);
    return { ok: true, rules: this.rules };
  }

  // Toggle one rule; null when the id is unknown.
  setEnabled(id: string, enabled: boolean): Rule | null {
    const at = this.rules.findIndex((r) => r.id === id);
    if (at < 0) return null;
    const next = this.rules.map((r, i) => (i === at ? { ...r, enabled } : r));
    this.commit(next);
    return this.rules[at];
  }

  private commit(next: Rule[]): void {
    if (this.file) saveRulesFile(this.file, next);
    this.rules = Object.freeze(next);
  }
}

// The persisted list, or [] when the file is absent. A malformed file is logged and
// ignored (no rules) rather than failing boot: a rule that cannot be read must not
// silently alter traffic in some half-applied form.
export function loadRulesFile(file: string): Rule[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  try {
    const r = validateRulesBody(JSON.parse(text));
    if (r.ok) return r.value;
    log.warn(`${file}: ignoring persisted rules (${formatRuleError(r)})`);
  } catch (e) {
    log.warn(`${file}: ignoring unreadable rules file`, String(e));
  }
  return [];
}

// Atomic, owner-only write: a temp file in the same directory, then rename.
export function saveRulesFile(file: string, rules: readonly Rule[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
