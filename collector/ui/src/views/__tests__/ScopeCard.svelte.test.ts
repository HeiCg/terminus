import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ScopeCard from '../Settings/ScopeCard.svelte';
import TunnelInfo from '../Capture/TunnelInfo.svelte';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
const SCOPE = { include: ['*.app.test'], exclude: ['cdn.app.test'], dropped: { excluded: 3, notIncluded: 7 } };

describe('ScopeCard (U5)', () => {
  it('loads the scope into the editors with the drop counters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, SCOPE)));
    render(ScopeCard);
    await waitFor(() => expect(screen.getByTestId('scope-include')).toHaveValue('*.app.test'));
    expect(screen.getByTestId('scope-exclude')).toHaveValue('cdn.app.test');
    expect(screen.getByTestId('scope-dropped')).toHaveTextContent('excluded 3');
    expect(screen.getByTestId('scope-dropped')).toHaveTextContent('not included 7');
    expect(screen.getByTestId('scope-save')).toBeDisabled(); // nothing changed yet
  });

  it('saves edited lists with PUT /api/scope (one pattern per line or comma)', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'PUT') return json(200, { ...JSON.parse(String(init.body)), dropped: { excluded: 0, notIncluded: 0 } });
      return json(200, SCOPE);
    }));
    render(ScopeCard);
    const user = userEvent.setup();
    const exclude = await screen.findByTestId('scope-exclude');
    await waitFor(() => expect(exclude).toHaveValue('cdn.app.test'));
    await user.type(exclude, '\nads.test, tracker.test');
    await user.click(screen.getByTestId('scope-save'));
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(put.url).toBe('/api/scope');
    expect(JSON.parse(String(put.init!.body))).toEqual({ include: ['*.app.test'], exclude: ['cdn.app.test', 'ads.test', 'tracker.test'] });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  });

  it('shows the server validation message on 400 and keeps the edit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? json(400, { error: 'bad_request', message: 'invalid pattern: "a.com:80" (a port or IPv6 literal is not allowed)' }) : json(200, SCOPE)));
    render(ScopeCard);
    const user = userEvent.setup();
    const include = await screen.findByTestId('scope-include');
    await waitFor(() => expect(include).toHaveValue('*.app.test'));
    await user.type(include, '\na.com:80');
    await user.click(screen.getByTestId('scope-save'));
    await waitFor(() => expect(screen.getByTestId('scope-error')).toHaveTextContent('a.com:80'));
    expect(include).toHaveValue('*.app.test\na.com:80');
  });

  it('offers a retry when the scope cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(403, {})));
    render(ScopeCard);
    expect(await screen.findByText('Scope unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('TunnelInfo (U5)', () => {
  it('shows destination, SNI, byte counts and open state', () => {
    render(TunnelInfo, { tunnel: { host: 'pinned.example', port: 443, sni: 'pinned.example', bytesUp: 2048, bytesDown: null, openedAt: 1000, closedAt: null } });
    const el = screen.getByTestId('tunnel-info');
    expect(el).toHaveTextContent('not intercepted');
    expect(el).toHaveTextContent('pinned.example:443');
    expect(el).toHaveTextContent('2.0 KB / —');
    expect(el).toHaveTextContent('open');
  });
});
