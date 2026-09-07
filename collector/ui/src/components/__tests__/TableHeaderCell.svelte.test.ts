import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import TableHeaderCell from '../TableHeaderCell.svelte';

describe('TableHeaderCell', () => {
  it('renders as a non-interactive cell without onsort', () => {
    const { container, queryByRole } = render(TableHeaderCell, {
      props: { label: 'Name', sort: null },
    });
    expect(container.querySelector('.thc')).toHaveTextContent('Name');
    expect(queryByRole('button')).toBeNull();
  });

  it('renders a button and fires onsort when clickable', async () => {
    const onsort = vi.fn();
    const { getByRole } = render(TableHeaderCell, {
      props: { label: 'Size', sort: null, onsort },
    });
    await fireEvent.click(getByRole('button', { name: /Size/ }));
    expect(onsort).toHaveBeenCalledOnce();
  });

  it('shows the ascending arrow and exposes the sort direction to AT', () => {
    const { container, getByRole } = render(TableHeaderCell, {
      props: { label: 'Size', sort: 'asc', onsort: () => {} },
    });
    expect(container.querySelector('.arrow')).toHaveTextContent('▲');
    expect(getByRole('button', { name: 'Size, sorted ascending' })).not.toBeNull();
  });

  it('shows the descending arrow', () => {
    const { container } = render(TableHeaderCell, {
      props: { label: 'Size', sort: 'desc', onsort: () => {} },
    });
    expect(container.querySelector('.arrow')).toHaveTextContent('▼');
  });
});
