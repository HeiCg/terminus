import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, afterEach } from 'vitest';
import ReplayEditor from '../ReplayEditor.svelte';
import { ReplayDraft, type CapturedBody } from '../../../lib/state/ReplayDraft.svelte.js';

function draft(body: CapturedBody = { kind: 'text', text: '{"a":1}' }) {
  return new ReplayDraft('d1', 'r1', {
    method: 'POST', url: 'https://api.test/v1', headers: { 'content-type': 'application/json', cookie: '***' }, body,
  });
}

function stubFetch() {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string));
    return { ok: true, json: async () => ({ key: { deviceId: 'd1', id: 'replay-1' }, status: 200, error: null, stripped: ['cookie'] }) } as unknown as Response;
  }));
  return sent;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('ReplayEditor', () => {
  it('prefills the form and focuses the first field', () => {
    render(ReplayEditor, { props: { draft: draft(), onclose: () => {}, onsent: () => {} } });
    expect(screen.getByRole('textbox', { name: 'Method' })).toHaveValue('POST');
    expect(screen.getByRole('textbox', { name: 'Method' })).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Header 1 name' })).toHaveValue('content-type');
    expect(screen.getByRole('textbox', { name: 'Request body text' })).toHaveValue('{"a":1}');
    expect(screen.getByTestId('replay-byte-count')).toHaveTextContent('7 bytes');
  });

  it('sends the edited fields as overrides and reports the outcome', async () => {
    const sent = stubFetch();
    const onsent = vi.fn();
    render(ReplayEditor, { props: { draft: draft(), onclose: () => {}, onsent } });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Header 1 value' }), { target: { value: 'text/plain' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Remove header cookie' }));
    await fireEvent.input(screen.getByRole('textbox', { name: 'Request body text' }), { target: { value: 'hello' } });
    expect(screen.getByTestId('replay-byte-count')).toHaveTextContent('5 bytes');
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(onsent).toHaveBeenCalledWith({ deviceId: 'd1', id: 'replay-1' }));
    expect(sent[0]).toEqual({
      deviceId: 'd1', id: 'r1', credentials: 'strip',
      overrides: { headers: { 'content-type': 'text/plain' }, body: 'hello' },
    });
    expect(screen.getByRole('status')).toHaveTextContent('stripped: cookie');
  });

  it('the credential toggle needs a confirming second Send', async () => {
    const sent = stubFetch();
    render(ReplayEditor, { props: { draft: draft(), onclose: () => {}, onsent: () => {} } });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Include captured credentials' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sent).toHaveLength(0);
    const armed = screen.getByRole('button', { name: 'Send with credentials' });
    await fireEvent.click(armed);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].credentials).toBe('keep');
  });

  it('switches the body to the hex grid and back', async () => {
    render(ReplayEditor, { props: { draft: draft({ kind: 'text', text: 'hi' }), onclose: () => {}, onsent: () => {} } });
    await fireEvent.click(screen.getByRole('radio', { name: 'Hex' }));
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(screen.getByTestId('hex-editor-count')).toHaveTextContent('2 bytes');
    await fireEvent.click(screen.getByRole('radio', { name: 'Text' }));
    expect(screen.getByRole('textbox', { name: 'Request body text' })).toHaveValue('hi');
  });

  it('Escape closes, and keystrokes never reach the App shortcuts', async () => {
    const onclose = vi.fn();
    const appKeys = vi.fn();
    window.addEventListener('keydown', appKeys);
    try {
      render(ReplayEditor, { props: { draft: draft(), onclose, onsent: () => {} } });
      await fireEvent.keyDown(screen.getByRole('textbox', { name: 'URL' }), { key: 'j' });
      await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
      expect(onclose).toHaveBeenCalledTimes(1);
      expect(appKeys).not.toHaveBeenCalled();
    } finally { window.removeEventListener('keydown', appKeys); }
  });
});
