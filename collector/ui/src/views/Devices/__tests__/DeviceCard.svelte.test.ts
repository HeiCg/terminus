import { render, screen, within } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import DeviceCard from '../DeviceCard.svelte';
import type { UiDevice } from '../../../lib/protocol.js';

const NOW = 1_700_000_000_000;

const device = (over: Partial<UiDevice> = {}): UiDevice => ({
  deviceId: 'abcdef123456',
  platform: 'android',
  appVersion: '1.0.0',
  buildProfile: 'unknown',
  dropped: 0,
  lastSeen: NOW,
  ...over,
});

const props = (d: UiDevice) => ({
  device: d, entries: 0, ws: 0, now: NOW, onclear: () => {}, onexport: () => {},
});

describe('DeviceCard channels', () => {
  it('renders a chip per observed channel with relative last-seen', () => {
    render(DeviceCard, {
      props: props(device({ channels: { ingest: { lastSeenAt: NOW - 4000 }, atlantis: { lastSeenAt: NOW - 9000 } } })),
    });
    const row = screen.getByTestId('device-channels');
    const ingest = within(row).getByTestId('channel-ingest');
    const atlantis = within(row).getByTestId('channel-atlantis');
    expect(ingest.textContent).toContain('ingest');
    expect(atlantis.textContent).toContain('atlantis');
  });

  it('shows only the channels that are present', () => {
    render(DeviceCard, { props: props(device({ channels: { atlantis: { lastSeenAt: NOW } } })) });
    expect(screen.queryByTestId('channel-ingest')).toBeNull();
    expect(screen.getByTestId('channel-atlantis')).toBeInTheDocument();
  });

  it('renders no channels row when the device has none', () => {
    render(DeviceCard, { props: props(device({ channels: undefined })) });
    expect(screen.queryByTestId('device-channels')).toBeNull();
  });

  it('renders an unknown build profile as an em dash, not the word', () => {
    const { container } = render(DeviceCard, { props: props(device({ buildProfile: 'unknown' })) });
    const profile = container.querySelector('.profile')!;
    expect(profile.textContent?.trim()).toBe('—');
    expect(profile.textContent).not.toContain('unknown');
  });

  it('keeps a normal build profile intact', () => {
    const { container } = render(DeviceCard, { props: props(device({ buildProfile: 'qa' })) });
    expect(container.querySelector('.profile')!.textContent?.trim()).toBe('qa');
  });
});
