<script lang="ts">
  import type { Selection, Tab } from '../../lib/state/Selection.svelte.js';
  import { fmtBytes, fmtMs, fmtTime } from '../../lib/format.js';
  import { resizer } from '../../lib/attach/resizer.js';
  import MethodTag from '../../components/MethodTag.svelte';
  import StatusPill from '../../components/StatusPill.svelte';
  import SourceDot from '../../components/SourceDot.svelte';
  import Tabs from '../../components/Tabs.svelte';
  import HeadersTab from './HeadersTab.svelte';
  import PayloadTab from './PayloadTab.svelte';
  import ResponseTab from './ResponseTab.svelte';
  import TimingTab from './TimingTab.svelte';
  import CurlTab from './CurlTab.svelte';

  type Props = { selection: Selection };
  let { selection }: Props = $props();

  const TABS = [
    { id: 'headers', label: 'Headers' },
    { id: 'payload', label: 'Payload' },
    { id: 'response', label: 'Response' },
    { id: 'timing', label: 'Timing' },
    { id: 'curl', label: 'cURL' },
  ];

  // Copy the cURL of the current selection. The request body is pulled in first so
  // the command includes `--data-raw` even if the Payload tab was never opened.
  async function copyCurl(): Promise<void> {
    await selection.loadBody('request');
    try {
      await navigator.clipboard?.writeText(selection.curl);
    } catch {
      /* clipboard unavailable */
    }
  }
</script>

{#if selection.current}
  {@const row = selection.current}
  <aside class="panel" data-testid="detail-panel" style={`width:${selection.panelWidth}px`}>
    <div
      class="handle"
      {@attach resizer({
        onResize: (px) => (selection.panelWidth = px),
        min: 480,
        max: () => window.innerWidth * 0.6,
      })}
    ></div>

    <header class="head">
      <div class="summary">
        <MethodTag method={row.method} />
        <StatusPill status={row.status} error={row.error} />
        <span class="stat">{fmtMs(row.durationMs)}</span>
        <span class="stat">{fmtBytes(row.size)}</span>
      </div>
      <p class="url">{row.url}</p>
      <div class="meta">
        <span class="dev">{row.deviceId}</span>
        <span class="sep">·</span>
        <SourceDot source={row.source} label />
        <span class="sep">·</span>
        <span class="time">{fmtTime(row.startedAt)}</span>
        <button type="button" class="curl-btn" onclick={copyCurl}>Copy as cURL</button>
      </div>
    </header>

    <div class="tabs">
      <Tabs tabs={TABS} value={selection.tab} onchange={(id) => selection.setTab(id as Tab)} />
    </div>

    <div class="content">
      {#key row}
        {#if selection.tab === 'headers'}
          <HeadersTab {selection} />
        {:else if selection.tab === 'payload'}
          <PayloadTab {selection} />
        {:else if selection.tab === 'response'}
          <ResponseTab {selection} />
        {:else if selection.tab === 'timing'}
          <TimingTab {selection} />
        {:else}
          <CurlTab {selection} />
        {/if}
      {/key}
    </div>
  </aside>
{/if}

<style>
  .panel {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-width: 60vw;
    background: var(--bg-surface);
    border-left: 1px solid var(--border-subtle);
  }
  .handle {
    position: absolute;
    top: 0;
    left: -3px;
    width: 6px;
    height: 100%;
    cursor: col-resize;
    z-index: 1;
  }
  .handle:hover {
    background: var(--accent);
  }
  .head {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .stat {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .url {
    margin: 8px 0 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-all;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .dev,
  .time {
    font-family: var(--font-mono);
  }
  .sep {
    color: var(--border-strong);
  }
  .curl-btn {
    margin-left: auto;
    height: 24px;
    padding: 0 8px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .curl-btn:hover {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .tabs {
    padding: 0 8px;
  }
  .content {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: auto;
  }
</style>
