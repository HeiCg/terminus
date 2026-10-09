import * as api from '../api.js';
import type { Rule } from '../ruleModel.js';
import { RuleDraft, type RuleSeed } from './RuleDraft.svelte.js';

// The Rules card's state (U6): the collector's rule list and the one rule being
// edited. Every change is saved at once: the enable toggle with PATCH
// /api/rules/:id, every structural change (add, edit, delete, reorder) with a PUT
// of the whole list. The list shown is always what the collector answered, so a
// refused save leaves it as it was and reports why.
export type RulesStatus = 'loading' | 'ready' | 'unavailable';

export class RulesEditor {
  status = $state<RulesStatus>('loading');
  rules = $state.raw<Rule[]>([]);
  busy = $state(false);
  error = $state<string | null>(null);
  notice = $state<string | null>(null);
  // The rule being edited: its draft and its index (null for a new rule).
  draft = $state<RuleDraft | null>(null);
  editIndex = $state<number | null>(null);
  // The save error for the open form (the server's message), kept apart from the
  // list-level `error`.
  formError = $state<string | null>(null);

  async load(): Promise<void> {
    this.status = 'loading';
    const rules = await api.fetchRules();
    if (rules) this.rules = rules;
    this.status = rules ? 'ready' : 'unavailable';
  }

  startNew(seed?: RuleSeed | null): void {
    this.draft = seed ? RuleDraft.fromSeed(seed) : new RuleDraft();
    this.editIndex = null;
    this.formError = null;
  }

  startEdit(index: number): void {
    const r = this.rules[index];
    if (!r) return;
    this.draft = RuleDraft.fromRule(r);
    this.editIndex = index;
    this.formError = null;
  }

  cancel(): void {
    this.draft = null;
    this.editIndex = null;
    this.formError = null;
  }

  // Save the open form. A client-side validation failure never reaches the server.
  async submit(): Promise<boolean> {
    const d = this.draft;
    if (!d) return false;
    const c = d.check;
    if (!c.ok) { this.formError = `${c.field ? `${c.field}: ` : ''}${c.message}`; return false; }
    const rule = { ...c.rule } as Partial<Rule>;
    if (d.id == null) delete rule.id; // the collector assigns a new rule's id
    const next = [...this.rules] as Partial<Rule>[];
    if (this.editIndex == null) next.push(rule); else next[this.editIndex] = rule;
    const ok = await this.put(next as Rule[], (m) => { this.formError = m; });
    if (ok) {
      this.notice = this.editIndex == null ? 'Rule added.' : 'Rule saved.';
      this.cancel();
    }
    return ok;
  }

  async toggle(id: string, enabled: boolean): Promise<void> {
    this.busy = true;
    this.error = null;
    const r = await api.setRuleEnabled(id, enabled);
    this.busy = false;
    if (r.ok) this.rules = this.rules.map((x) => (x.id === id ? r.rule : x));
    else this.error = r.message;
  }

  async remove(index: number): Promise<void> {
    if (!this.rules[index]) return;
    if (this.editIndex === index) this.cancel();
    if (await this.put(this.rules.filter((_, i) => i !== index), (m) => { this.error = m; })) this.notice = 'Rule deleted.';
  }

  // Move one rule up (-1) or down (+1): order decides which rule runs first.
  async move(index: number, delta: -1 | 1): Promise<void> {
    const to = index + delta;
    if (to < 0 || to >= this.rules.length || this.draft) return;
    const next = [...this.rules];
    [next[index], next[to]] = [next[to], next[index]];
    await this.put(next, (m) => { this.error = m; });
  }

  private async put(next: Rule[], onError: (m: string) => void): Promise<boolean> {
    this.busy = true;
    this.error = null;
    this.notice = null;
    const r = await api.saveRules(next);
    this.busy = false;
    if (r.ok) { this.rules = r.rules; return true; }
    onError(r.message);
    return false;
  }
}

// One-line description of what a rule matches and does, for the list.
export function describeRule(r: Rule): string {
  const m = r.match;
  const where = [
    m.methods?.join('|'),
    m.scheme ? `${m.scheme}://` : null,
    `${m.host ?? '*'}${m.path ?? ''}`,
    m.query ? `?${Object.keys(m.query).join('&')}` : null,
    m.headers ? `[${Object.keys(m.headers).join(', ')}]` : null,
  ].filter(Boolean).join(' ');
  const a = r.action;
  const what = a.type === 'block' ? ('close' in a ? 'close connection' : 'reset' in a ? 'reset connection' : `block ${('status' in a && a.status) || 403}`)
    : a.type === 'mock' ? `mock ${a.status}`
      : a.type === 'delay' ? `delay ${a.ms} ms`
        : `rewrite ${r.phase}`;
  return `${what} · ${where}`;
}
