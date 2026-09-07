import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import RequestTable from '../RequestTable.svelte';
import type { Row, SortKey } from '../../../lib/state/Filters.svelte.js';
import type { BodyRef } from '../../../lib/protocol.js';

const absent: BodyRef = { state: 'absent', sha256: null, size: 0, storedSize: 0, encoding: 'utf8', omitted: null };

function row(i: number): Row {
  return {
    id: `e${i}`, deviceId: 'd1', source: 'atlantis', startedAt: i, method: 'GET',
    url: `https://a.test/${i}`, status: 200, durationMs: 5, error: null,
    requestBody: absent, responseBody: absent,
    kind: 'xhr', host: 'a.test', path: `/${i}`, bucket: '2xx', size: null,
  };
}

const rows = Array.from({ length: 500 }, (_, i) => row(i));
const sort = { key: 'time', dir: 'desc' } as const;

// Fill in the required-but-irrelevant props for a given test.
function props(over: Record<string, unknown> = {}) {
  return {
    rows, selectedKey: null, onselect: () => {}, sort,
    onsort: (_k: SortKey) => {}, version: 0, resetKey: 'k', ...over,
  };
}

// jsdom does no layout: give the scroller a real clientHeight and recompute the
// window by dispatching a scroll, so the range is deterministic.
async function layout(clientHeight: number, scrollTop = 0): Promise<void> {
  const scroll = screen.getByTestId('request-scroll');
  Object.defineProperty(scroll, 'clientHeight', { value: clientHeight, configurable: true });
  scroll.scrollTop = scrollTop;
  scroll.dispatchEvent(new Event('scroll'));
  await tick();
}

describe('RequestTable', () => {
  it('mounts only the visible window, not the whole list', async () => {
    render(RequestTable, { props: props() });
    await layout(320);
    const mounted = screen.getAllByTestId(/^entry-row-/);
    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(60);
    expect(screen.getByTestId('entry-row-e0')).toBeInTheDocument();
    expect(screen.queryByTestId('entry-row-e499')).toBeNull();
  });

  it('marks the selected row', async () => {
    // selectedKey is the entityKey of e0 (JSON of [deviceId, id]).
    const key = JSON.stringify(['d1', 'e0']);
    render(RequestTable, { props: props({ selectedKey: key }) });
    await layout(320); // ensure e0 is actually in the mounted window
    const selected = screen.getAllByTestId('entry-row-e0').find((el) => el.getAttribute('aria-pressed') === 'true');
    expect(selected).toBeTruthy();
  });

  it('emits onselect with the clicked row', async () => {
    const onselect = vi.fn();
    render(RequestTable, { props: props({ onselect }) });
    await layout(320);
    await fireEvent.click(screen.getByTestId('entry-row-e0'));
    expect(onselect).toHaveBeenCalledOnce();
    expect(onselect.mock.calls[0][0].id).toBe('e0');
  });

  it('calls onsort when a sortable header is clicked', async () => {
    const onsort = vi.fn();
    render(RequestTable, { props: props({ onsort }) });
    await fireEvent.click(screen.getByRole('button', { name: /Host/i }));
    expect(onsort).toHaveBeenCalledWith('host');
  });

  it('shows a filtered-empty message when there are no rows', () => {
    render(RequestTable, { props: props({ rows: [] }) });
    expect(screen.getByText(/No requests match/)).toBeInTheDocument();
  });

  it('hides the "N new" pill under a non-time sort', async () => {
    const hostSort = { key: 'host', dir: 'asc' } as const;
    const { rerender } = render(RequestTable, { props: props({ sort: hostSort, version: 1 }) });
    await layout(320);
    await rerender(props({ sort: hostSort, version: 2 })); // an "arrival" — must not raise a pill
    await tick();
    expect(screen.queryByText(/new/)).toBeNull();
  });

  it('shows "↑ N new" under time desc when scrolled away from the top edge', async () => {
    const { rerender } = render(RequestTable, { props: props({ sort, version: 1 }) });
    const scroll = screen.getByTestId('request-scroll');
    Object.defineProperty(scroll, 'scrollTop', { value: 300, configurable: true }); // away from the top
    await rerender(props({ sort, version: 2 })); // one arrival
    await tick();
    expect(screen.getByText(/↑ 1 new/)).toBeInTheDocument();
  });

  it('scrollToKey scrolls a below-viewport row to the bottom edge (block: nearest)', async () => {
    // 200 rows; scroll index 150 into view from the top. The row is unmounted under
    // virtualization, so scrollToKey computes index*ROW_HEIGHT, not a DOM offset.
    const rows200 = Array.from({ length: 200 }, (_, i) => row(i));
    let scrollTo: ((key: string) => void) | null = null;
    render(RequestTable, { props: props({ rows: rows200, registerScrollTo: (fn: typeof scrollTo) => (scrollTo = fn) }) });
    await layout(320); // give the scroller a real clientHeight

    const ROW = 32;
    const viewport = 320;
    scrollTo!(JSON.stringify(['d1', 'e150']));
    const scroll = screen.getByTestId('request-scroll');
    expect(scroll.scrollTop).toBe(150 * ROW - viewport + ROW);
  });
});
