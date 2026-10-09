import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import RulesCard from '../Settings/RulesCard.svelte';
import RuleBadge from '../Capture/RuleBadge.svelte';
import AppliedRules from '../Capture/AppliedRules.svelte';
import { RulesEditor, describeRule } from '../../lib/state/RulesEditor.svelte.js';
import { offerRuleSeed } from '../../lib/state/RuleDraft.svelte.js';
import type { Rule } from '../../lib/ruleModel.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const RULES: Rule[] = [
  { id: 'r1', name: 'Mock login', enabled: true, phase: 'request', match: { methods: ['POST'], host: 'api.app.test', path: '/login' }, action: { type: 'mock', status: 200, body: '{}' } },
  { id: 'r2', name: 'Slow API', enabled: false, phase: 'response', match: { host: '*.app.test' }, action: { type: 'delay', ms: 2000 } },
];

// A fake collector: GET/PUT /api/rules and PATCH /api/rules/:id over an in-memory
// list, recording every call. `putStatus` forces the next PUT to fail.
function fakeCollector(initial: Rule[] = RULES) {
  let rules = structuredClone(initial);
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const state = { putStatus: 200 as number, putBody: null as unknown };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url === '/api/rules' && method === 'GET') return json(200, { rules });
    if (url === '/api/rules' && method === 'PUT') {
      if (state.putStatus !== 200) return json(state.putStatus, state.putBody);
      rules = (body.rules as Rule[]).map((r, i) => ({ ...r, id: r.id ?? `assigned-${i}` }));
      return json(200, { rules });
    }
    const m = /^\/api\/rules\/(.+)$/.exec(url);
    if (m && method === 'PATCH') {
      const r = rules.find((x) => x.id === decodeURIComponent(m[1]));
      if (!r) return json(404, {});
      r.enabled = body.enabled;
      return json(200, r);
    }
    return json(404, {});
  }));
  return { calls, state, rules: () => rules };
}

describe('RulesEditor (U6 state)', () => {
  it('loads, toggles with PATCH and saves structural changes with a PUT of the whole list', async () => {
    const fake = fakeCollector();
    const ed = new RulesEditor();
    await ed.load();
    expect(ed.status).toBe('ready');
    expect(ed.rules.map((r) => r.id)).toEqual(['r1', 'r2']);

    await ed.toggle('r2', true);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'PATCH', url: '/api/rules/r2', body: { enabled: true } });
    expect(ed.rules[1].enabled).toBe(true);

    await ed.move(1, -1);
    expect(fake.calls.at(-1)?.body).toMatchObject({ rules: [{ id: 'r2' }, { id: 'r1' }] });
    expect(ed.rules.map((r) => r.id)).toEqual(['r2', 'r1']);
    await ed.move(0, -1); // already first: no call
    expect(fake.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    ed.startNew();
    ed.draft!.name = 'Block ads';
    ed.draft!.host = 'ads.test';
    expect(await ed.submit()).toBe(true);
    const put = fake.calls.at(-1)!;
    expect((put.body as { rules: Rule[] }).rules[2]).toEqual({ name: 'Block ads', enabled: true, phase: 'request', match: { host: 'ads.test' }, action: { type: 'block' } });
    expect(ed.rules[2].id).toBe('assigned-2');
    expect(ed.draft).toBeNull();
    expect(ed.notice).toBe('Rule added.');

    ed.startEdit(2);
    ed.draft!.name = 'Block all ads';
    expect(await ed.submit()).toBe(true);
    expect(ed.rules[2]).toMatchObject({ id: 'assigned-2', name: 'Block all ads' });

    await ed.remove(0);
    expect(ed.rules.map((r) => r.id)).toEqual(['r1', 'assigned-2']);
  });

  it('a client-side invalid form never reaches the server; a server 400 keeps the form open with its message', async () => {
    const fake = fakeCollector();
    const ed = new RulesEditor();
    await ed.load();
    ed.startNew();
    expect(await ed.submit()).toBe(false);
    expect(ed.formError).toBe('name: must not be empty');
    expect(fake.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    ed.draft!.name = 'x';
    fake.state.putStatus = 400;
    fake.state.putBody = { error: 'bad_request', message: 'rules[2].action.status: must be an integer from 200 to 599', path: 'rules[2].action.status' };
    expect(await ed.submit()).toBe(false);
    expect(ed.formError).toContain('rules[2].action.status');
    expect(ed.draft).not.toBeNull();
    expect(ed.rules).toHaveLength(2); // unchanged
  });

  it('describes a rule in one line', () => {
    expect(describeRule(RULES[0])).toBe('mock 200 · POST api.app.test/login');
    expect(describeRule(RULES[1])).toBe('delay 2000 ms · *.app.test');
    expect(describeRule({ ...RULES[0], action: { type: 'block', close: true } })).toBe('close connection · POST api.app.test/login');
  });
});

describe('RulesCard (U6)', () => {
  it('lists the rules with enable toggles and a one-line description', async () => {
    fakeCollector();
    render(RulesCard);
    const row = await screen.findByTestId('rule-row-r1');
    expect(row).toHaveTextContent('Mock login');
    expect(row).toHaveTextContent('mock 200 · POST api.app.test/login');
    expect(screen.getByRole('switch', { name: 'Enable Mock login' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Enable Slow API' })).not.toBeChecked();
  });

  it('toggling a rule sends PATCH', async () => {
    const fake = fakeCollector();
    render(RulesCard);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: 'Enable Slow API' }));
    await waitFor(() => expect(fake.calls.some((c) => c.method === 'PATCH')).toBe(true));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Slow API' })).toBeChecked());
  });

  it('adds a rule through the form, with live validation messages', async () => {
    const fake = fakeCollector([]);
    render(RulesCard);
    const user = userEvent.setup();
    expect(await screen.findByTestId('rules-empty')).toBeInTheDocument();
    await user.click(screen.getByTestId('rule-add'));
    const form = screen.getByTestId('rule-form');
    expect(screen.getByTestId('rule-save')).toBeDisabled();
    expect(within(form).getByTestId('rule-error-name')).toHaveTextContent('must not be empty');

    await user.type(screen.getByTestId('rule-name'), 'Slow login');
    await user.type(screen.getByTestId('rule-host'), 'api.test:443');
    expect(screen.getByTestId('rule-error-match.host')).toHaveTextContent('a port or IPv6 literal is not allowed');
    await user.clear(screen.getByTestId('rule-host'));
    await user.type(screen.getByTestId('rule-host'), 'api.test');
    await user.selectOptions(screen.getByTestId('rule-action'), 'delay');
    await user.type(screen.getByTestId('rule-delay'), '99999');
    expect(screen.getByTestId('rule-error-action.ms')).toHaveTextContent('from 1 to 30000');
    await user.clear(screen.getByTestId('rule-delay'));
    await user.type(screen.getByTestId('rule-delay'), '1500');
    expect(screen.getByTestId('rule-save')).toBeEnabled();
    await user.click(screen.getByTestId('rule-save'));

    await waitFor(() => expect(fake.rules()).toHaveLength(1));
    expect(fake.rules()[0]).toMatchObject({ name: 'Slow login', match: { host: 'api.test' }, action: { type: 'delay', ms: 1500 } });
    await waitFor(() => expect(screen.getByTestId('rule-row-assigned-0')).toHaveTextContent('delay 1500 ms'));
    expect(screen.queryByTestId('rule-form')).toBeNull();
  });

  it('switching the phase to response offers only rewrite and delay', async () => {
    fakeCollector([]);
    render(RulesCard);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('rule-add'));
    await user.selectOptions(screen.getByTestId('rule-phase'), 'response');
    const options = within(screen.getByTestId('rule-action')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Rewrite', 'Delay']);
    expect(screen.getByTestId('rule-action')).toHaveValue('rewrite');
    expect(screen.queryByTestId('rule-url')).toBeNull(); // request-only field
  });

  it('shows the collector message when a save is refused', async () => {
    const fake = fakeCollector();
    fake.state.putStatus = 400;
    fake.state.putBody = { error: 'bad_request', message: 'rules[0].match.host: not a valid hostname', path: 'rules[0].match.host' };
    render(RulesCard);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Mock login' }));
    await user.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(screen.getByTestId('rule-form-error')).toHaveTextContent('not a valid hostname'));
  });

  it('a seed from Capture opens a prefilled form', async () => {
    fakeCollector([]);
    offerRuleSeed({ method: 'GET', host: 'api.test', path: '/v1/me' });
    render(RulesCard);
    await waitFor(() => expect(screen.getByTestId('rule-form')).toBeInTheDocument());
    expect(screen.getByTestId('rule-methods')).toHaveValue('GET');
    expect(screen.getByTestId('rule-host')).toHaveValue('api.test');
    expect(screen.getByTestId('rule-path')).toHaveValue('/v1/me');
    expect(screen.getByTestId('rule-action')).toHaveValue('mock');
    expect(screen.getByTestId('rule-save')).toBeEnabled();
  });

  it('offers a retry when the rules cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, {})));
    render(RulesCard);
    expect(await screen.findByText('Rules unavailable.')).toBeInTheDocument();
  });
});

describe('Capture rule markers (U6)', () => {
  it('RuleBadge says MOCK or RULE and names the rules', () => {
    render(RuleBadge, { rules: [{ id: 'a', name: 'Mock login', action: 'mock', phase: 'request' }], mocked: true });
    const b = screen.getByTestId('rule-badge');
    expect(b).toHaveTextContent('mock');
    expect(b.getAttribute('title')).toContain('Mock login');
    cleanup();
    render(RuleBadge, { rules: [{ id: 'b', name: 'Slow', action: 'delay', phase: 'response' }] });
    expect(screen.getByTestId('rule-badge')).toHaveTextContent('rule');
  });

  it('AppliedRules lists the rules in order and the original request', () => {
    render(AppliedRules, {
      row: {
        method: 'PUT', url: 'https://staging.test/v2', originalMethod: 'POST', originalUrl: 'https://api.test/v1',
        rules: [{ id: 'a', name: 'To staging', action: 'rewrite', phase: 'request' }, { id: 'b', name: 'Slow', action: 'delay', phase: 'response' }],
      },
    });
    const el = screen.getByTestId('applied-rules');
    expect(within(el).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['To staging request rewrite', 'Slow response delay']);
    expect(screen.getByTestId('original-request')).toHaveTextContent('POST https://api.test/v1');
    expect(el).toHaveTextContent('as sent upstream');
  });
});
