import { validateRule, type Rule, type RulePhase, type RuleActionType } from '../ruleModel.js';

// The rule form's editable state (U6). Every field is the text the admin typed;
// `build()` turns it into the rule JSON and `check` runs the SAME validation the
// collector runs on `PUT /api/rules` (the shared ruleModel), so the form shows the
// server's messages before anything is sent. Line-based fields (query, headers)
// are parsed here, with their own messages, before the shared validation.

export type BlockMode = 'status' | 'close' | 'reset';
export type ReplaceRow = { find: string; with: string };

// What "Create rule from this request" carries from the Capture detail panel.
export type RuleSeed = { method: string; host: string; path: string };

// A seed handed from the Capture view to Settings: set just before navigating,
// taken once by the Rules card when it mounts.
let pendingSeed: RuleSeed | null = null;
export function offerRuleSeed(seed: RuleSeed): void { pendingSeed = seed; }
export function takeRuleSeed(): RuleSeed | null {
  const s = pendingSeed;
  pendingSeed = null;
  return s;
}

export type DraftCheck = { ok: true; rule: Rule } | { ok: false; field: string; message: string };

// `Name: value` lines (headers) or `name=value` lines (query) into a map.
function parseLines(text: string, sep: ':' | '=', field: string): { ok: true; map: Record<string, string> } | { ok: false; field: string; message: string } {
  const map: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const at = line.indexOf(sep);
    if (at <= 0) return { ok: false, field, message: `line ${i + 1}: expected ${sep === ':' ? 'Name: value' : 'name=value'}` };
    map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { ok: true, map };
}

const listOf = (text: string): string[] => text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '');
const intOf = (text: string): number | string => (/^\s*-?\d+\s*$/.test(text) ? Number(text) : text.trim());
const headerLines = (h: Record<string, string> | undefined): string => Object.entries(h ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');

export class RuleDraft {
  id: string | null = null;
  name = $state('');
  enabled = $state(true);
  phase = $state<RulePhase>('request');
  actionType = $state<RuleActionType>('block');
  // match
  methods = $state('');
  host = $state('');
  path = $state('');
  scheme = $state<'' | 'http' | 'https'>('');
  query = $state('');
  headers = $state('');
  // block
  blockMode = $state<BlockMode>('status');
  // shared by block/mock/rewrite (status), mock/rewrite (body), mock (headers)
  status = $state('');
  body = $state('');
  bodyIsBase64 = $state(false);
  mockHeaders = $state('');
  mockDelay = $state('');
  // rewrite
  url = $state('');
  method = $state('');
  setHeaders = $state('');
  removeHeaders = $state('');
  replace = $state<ReplaceRow[]>([]);
  // delay
  delayMs = $state('');

  // The actions the current phase allows; the select offers only these.
  readonly actions = $derived<RuleActionType[]>(this.phase === 'response' ? ['rewrite', 'delay'] : ['block', 'mock', 'rewrite', 'delay']);
  readonly check = $derived<DraftCheck>(this.validate());

  static fromRule(r: Rule): RuleDraft {
    const d = new RuleDraft();
    d.id = r.id;
    d.name = r.name;
    d.enabled = r.enabled;
    d.phase = r.phase;
    d.actionType = r.action.type;
    d.methods = (r.match.methods ?? []).join(', ');
    d.host = r.match.host ?? '';
    d.path = r.match.path ?? '';
    d.scheme = r.match.scheme ?? '';
    d.query = Object.entries(r.match.query ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
    d.headers = headerLines(r.match.headers);
    const a = r.action;
    switch (a.type) {
      case 'block':
        d.blockMode = 'close' in a ? 'close' : 'reset' in a ? 'reset' : 'status';
        if ('status' in a && a.status !== undefined) d.status = String(a.status);
        if ('body' in a && a.body !== undefined) d.body = a.body;
        break;
      case 'mock':
        d.status = String(a.status);
        d.mockHeaders = headerLines(a.headers);
        d.body = a.bodyBase64 ?? a.body ?? '';
        d.bodyIsBase64 = a.bodyBase64 !== undefined;
        d.mockDelay = a.delayMs !== undefined ? String(a.delayMs) : '';
        break;
      case 'rewrite':
        d.url = a.url ?? '';
        d.method = a.method ?? '';
        d.status = a.status !== undefined ? String(a.status) : '';
        d.setHeaders = headerLines(a.setHeaders);
        d.removeHeaders = (a.removeHeaders ?? []).join(', ');
        d.body = a.bodyBase64 ?? a.body ?? '';
        d.bodyIsBase64 = a.bodyBase64 !== undefined;
        d.replace = (a.replace ?? []).map((x) => ({ ...x }));
        break;
      case 'delay':
        d.delayMs = String(a.ms);
        break;
    }
    return d;
  }

  // A mock for the request the admin picked in Capture: same method, host, path.
  static fromSeed(s: RuleSeed): RuleDraft {
    const d = new RuleDraft();
    d.name = `${s.method} ${s.host}${s.path}`.slice(0, 120);
    d.methods = s.method;
    d.host = s.host;
    d.path = s.path;
    d.actionType = 'mock';
    d.status = '200';
    d.mockHeaders = 'content-type: application/json';
    return d;
  }

  // Switching phase keeps the action when the new phase allows it.
  setPhase(p: RulePhase): void {
    this.phase = p;
    if (p === 'response' && (this.actionType === 'block' || this.actionType === 'mock')) this.actionType = 'rewrite';
  }

  addReplace(): void { this.replace.push({ find: '', with: '' }); }
  removeReplace(i: number): void { this.replace.splice(i, 1); }

  // The rule JSON as typed (unvalidated), or a form-level parse error.
  build(): { ok: true; value: Record<string, unknown> } | { ok: false; field: string; message: string } {
    const match: Record<string, unknown> = {};
    const methods = listOf(this.methods);
    if (methods.length) match.methods = methods;
    if (this.host.trim()) match.host = this.host.trim();
    if (this.path.trim()) match.path = this.path.trim();
    if (this.scheme) match.scheme = this.scheme;
    const q = parseLines(this.query, '=', 'match.query');
    if (!q.ok) return q;
    if (Object.keys(q.map).length) match.query = q.map;
    const h = parseLines(this.headers, ':', 'match.headers');
    if (!h.ok) return h;
    if (Object.keys(h.map).length) match.headers = h.map;

    const body = (): Record<string, unknown> =>
      this.body === '' ? {} : this.bodyIsBase64 ? { bodyBase64: this.body.trim() } : { body: this.body };
    let action: Record<string, unknown>;
    switch (this.actionType) {
      case 'block':
        action = this.blockMode === 'close' ? { type: 'block', close: true }
          : this.blockMode === 'reset' ? { type: 'block', reset: true }
            : { type: 'block', ...(this.status.trim() ? { status: intOf(this.status) } : {}), ...(this.body !== '' ? { body: this.body } : {}) };
        break;
      case 'mock': {
        const mh = parseLines(this.mockHeaders, ':', 'action.headers');
        if (!mh.ok) return mh;
        action = {
          type: 'mock', status: this.status.trim() ? intOf(this.status) : undefined,
          ...(Object.keys(mh.map).length ? { headers: mh.map } : {}), ...body(),
          ...(this.mockDelay.trim() ? { delayMs: intOf(this.mockDelay) } : {}),
        };
        break;
      }
      case 'rewrite': {
        const sh = parseLines(this.setHeaders, ':', 'action.setHeaders');
        if (!sh.ok) return sh;
        const rm = listOf(this.removeHeaders);
        const rows = this.replace.filter((r) => r.find !== '' || r.with !== '');
        action = {
          type: 'rewrite',
          ...(this.phase === 'request' && this.url.trim() ? { url: this.url.trim() } : {}),
          ...(this.phase === 'request' && this.method.trim() ? { method: this.method.trim() } : {}),
          ...(this.phase === 'response' && this.status.trim() ? { status: intOf(this.status) } : {}),
          ...(Object.keys(sh.map).length ? { setHeaders: sh.map } : {}),
          ...(rm.length ? { removeHeaders: rm } : {}),
          ...body(),
          ...(rows.length ? { replace: rows.map((r) => ({ find: r.find, with: r.with })) } : {}),
        };
        break;
      }
      case 'delay':
        action = { type: 'delay', ms: intOf(this.delayMs) };
        break;
    }
    return {
      ok: true,
      value: { ...(this.id ? { id: this.id } : {}), name: this.name, enabled: this.enabled, match, phase: this.phase, action },
    };
  }

  private validate(): DraftCheck {
    const b = this.build();
    if (!b.ok) return b;
    // A new rule has no id yet: validate with a placeholder, the save assigns one.
    const v = validateRule(b.value, 'rule', () => 'new');
    if (v.ok) return { ok: true, rule: v.value };
    return { ok: false, field: v.path.replace(/^rule\.?/, ''), message: v.message };
  }

  // The message for one form field (a path prefix such as `match.host` or
  // `action.status`), or null.
  // `exact` matches that path only, not the fields under it.
  errorFor(field: string, exact = false): string | null {
    const c = this.check;
    if (c.ok) return null;
    if (c.field === field) return c.message;
    return !exact && (c.field.startsWith(`${field}.`) || c.field.startsWith(`${field}[`)) ? c.message : null;
  }
}
