import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import ReplayButton from '../ReplayButton.svelte';

// A fetch stub that records the parsed request body and returns a canned 201.
function stubFetch(response: { status?: number | null; error?: string | null; stripped?: string[] } = {}) {
  const calls: { credentials: string }[] = [];
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return {
      ok: true,
      json: async () => ({ status: response.status ?? 200, error: response.error ?? null, stripped: response.stripped ?? [] }),
      text: async () => '',
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('ReplayButton (T8.1)', () => {
  it('replays with credentials stripped by default', async () => {
    const { calls } = stubFetch();
    const { getByRole } = render(ReplayButton, { props: { deviceId: 'd1', id: 'r1' } });
    await fireEvent.click(getByRole('button'));
    expect(calls).toHaveLength(1);
    expect(calls[0].credentials).toBe('strip');
  });

  it('shows the stripped names after a replay', async () => {
    stubFetch({ stripped: ['authorization', 'cookie'] });
    const { getByRole, findByText } = render(ReplayButton, { props: { deviceId: 'd1', id: 'r1' } });
    await fireEvent.click(getByRole('button'));
    expect(await findByText(/stripped: authorization, cookie/)).toBeTruthy();
  });

  it('requires a confirming second click before replaying with credentials', async () => {
    const { calls } = stubFetch();
    const { getByRole, container } = render(ReplayButton, { props: { deviceId: 'd1', id: 'r1' } });
    const checkbox = container.querySelector('input[type=checkbox]') as HTMLInputElement;
    await fireEvent.click(checkbox); // opt into credentials

    const button = getByRole('button');
    await fireEvent.click(button); // first click only arms the confirmation
    expect(calls).toHaveLength(0);
    expect(button.textContent).toContain('Replay with credentials');

    await fireEvent.click(button); // second click sends
    expect(calls).toHaveLength(1);
    expect(calls[0].credentials).toBe('keep');
  });

  it('toggling the checkbox back off disarms the confirmation', async () => {
    const { calls } = stubFetch();
    const { getByRole, container } = render(ReplayButton, { props: { deviceId: 'd1', id: 'r1' } });
    const checkbox = container.querySelector('input[type=checkbox]') as HTMLInputElement;
    await fireEvent.click(checkbox);
    await fireEvent.click(getByRole('button')); // arm
    await fireEvent.click(checkbox); // toggle off disarms
    await fireEvent.click(getByRole('button')); // now a plain strip replay
    expect(calls).toHaveLength(1);
    expect(calls[0].credentials).toBe('strip');
  });
});
