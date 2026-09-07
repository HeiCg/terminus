import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Tabs from '../Tabs.svelte';

const tabs = [
  { id: 'req', label: 'Request' },
  { id: 'res', label: 'Response' },
];

describe('Tabs', () => {
  it('marks the value tab active', () => {
    const { getByRole } = render(Tabs, { props: { tabs, value: 'res', onchange: () => {} } });
    expect(getByRole('tab', { name: 'Response' }).className).toContain('active');
    expect(getByRole('tab', { name: 'Request' }).className).not.toContain('active');
  });

  it('calls onchange with the clicked id', async () => {
    const onchange = vi.fn();
    const { getByRole } = render(Tabs, { props: { tabs, value: 'req', onchange } });
    await fireEvent.click(getByRole('tab', { name: 'Response' }));
    expect(onchange).toHaveBeenCalledWith('res');
  });
});
