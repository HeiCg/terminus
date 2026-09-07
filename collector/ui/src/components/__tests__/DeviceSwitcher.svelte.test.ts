import { render, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import DeviceSwitcher from '../DeviceSwitcher.svelte';
import type { UiDevice } from '../../lib/protocol.js';

const now = 1_700_000_000_000;

const device = (over: Partial<UiDevice> = {}): UiDevice => ({
  deviceId: 'abcdef123456',
  platform: 'ios',
  appVersion: '1.0.0',
  buildProfile: 'debug',
  dropped: 0,
  lastSeen: now,
  ...over,
});

describe('DeviceSwitcher', () => {
  it('marks the switcher live when lastSeen is within 30s', () => {
    const { container } = render(DeviceSwitcher, {
      props: { devices: [device({ lastSeen: now - 5_000 })], value: 'abcdef123456', onchange: () => {}, now },
    });
    expect(container.querySelector('.switcher')!.className).toContain('live');
  });

  it('is not live when lastSeen is stale', () => {
    const { container } = render(DeviceSwitcher, {
      props: { devices: [device({ lastSeen: now - 40_000 })], value: 'abcdef123456', onchange: () => {}, now },
    });
    expect(container.querySelector('.switcher')!.className).not.toContain('live');
  });

  it('shows the first six chars of the device id', () => {
    const { container } = render(DeviceSwitcher, {
      props: { devices: [device()], value: 'abcdef123456', onchange: () => {}, now },
    });
    expect(container.querySelector('.id')).toHaveTextContent('abcdef');
  });

  it('calls onchange when the select changes', async () => {
    const onchange = vi.fn();
    const { container } = render(DeviceSwitcher, {
      props: { devices: [device()], value: 'all', onchange, now },
    });
    const select = container.querySelector('select')! as HTMLSelectElement;
    select.value = 'abcdef123456';
    await fireEvent.change(select);
    expect(onchange).toHaveBeenCalledWith('abcdef123456');
  });
});
