<script lang="ts">
  import type { Sockets, FrameDirection } from '../../lib/state/Sockets.svelte.js';
  import type { FrameSummary } from '../../lib/protocol.js';
  import { useCache } from '../../lib/context.js';
  import { fmtBytes, fmtTime } from '../../lib/format.js';
  import KindBadge from '../../components/KindBadge.svelte';
  import StatePill from '../../components/StatePill.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Chip from '../../components/Chip.svelte';
  import Button from '../../components/Button.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import JsonView from '../../components/JsonView.svelte';
  import OmittedCard from '../../components/OmittedCard.svelte';

  type Props = { sockets: Sockets };
  let { sockets }: Props = $props();

  const cache = useCache();

  const DIRECTIONS: { id: FrameDirection; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'in', label: '↓ In' },
    { id: 'out', label: '↑ Out' },
  ];

  const meta = $derived.by(() => {
    const s = sockets.selected;
    if (!s) return '';
    const opened = `opened ${fmtTime(s.openedAt)}`;
    // A live session has no close time and no close reason yet — don't append a
    // "no close reason" clause to a socket that has not closed.
    if (s.closedAt == null) return `${opened} · live`;
    const reason = s.closeReason?.trim() ? s.closeReason : 'no close reason';
    return `${opened} · closed ${fmtTime(s.closedAt)} · ${reason}`;
  });

  // Re-run the frame load for the current selection (the error-state retry).
  function retry(): void {
    const id = sockets.selectedId;
    if (id) void sockets.select(id);
  }

  // Register the frame scroller with the store so `jumpToLive` can snap to the live
  // edge. The store owns no DOM, so it holds the callback; the scroll is deferred to
  // the next animation frame so it runs after the swapped window has painted — an
  // attachment, not a reactive effect.
  function registerLiveScroll(node: HTMLElement) {
    sockets.scrollToLive = () => {
      requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
    };
    return () => { sockets.scrollToLive = null; };
  }
</script>

{#if !sockets.selected}
  <div class="frametimeline empty">
    <EmptyState title="Select a session" hint="Choose a session to inspect its frames." />
  </div>
{:else}
  {@const s = sockets.selected}
  <div class="frametimeline">
    <header class="head">
      <div class="summary">
        <KindBadge kind={s.kind === 'sse' ? 'sse' : 'ws'} />
        <span class="url">{s.url}</span>
        <StatePill closedAt={s.closedAt} closeCode={s.closeCode} />
      </div>
      <p class="meta">{meta}</p>
    </header>

    <div class="toolbar">
      <Segmented options={DIRECTIONS} value={sockets.direction} onchange={(d) => (sockets.direction = d as FrameDirection)} />
      <Chip active={sockets.binaryOnly} onclick={() => (sockets.binaryOnly = !sockets.binaryOnly)}>Binary</Chip>
      <input
        class="search"
        type="search"
        placeholder="search frames…"
        aria-label="Search frames"
        bind:value={sockets.search}
      />
      <div class="grow"></div>
      {#if sockets.canJumpToLive}
        <Button variant="secondary" size="sm" onclick={() => sockets.jumpToLive()}>
          Jump to live
        </Button>
      {/if}
      {#if sockets.canLoadNewer}
        <Button variant="secondary" size="sm" onclick={() => sockets.loadNewer()}>
          Load newer
        </Button>
      {/if}
      <Button variant="secondary" size="sm" disabled={!sockets.canLoadOlder} onclick={() => sockets.loadOlder()}>
        Load older
      </Button>
    </div>

    <div class="frames" {@attach registerLiveScroll}>
      {#if sockets.framesStatus === 'error'}
        <div class="error">
          <p class="hint">Failed to load frames</p>
          <Button variant="secondary" size="sm" onclick={retry}>Retry</Button>
        </div>
      {:else if sockets.framesStatus === 'loading'}
        <p class="hint">Loading frames…</p>
      {:else if sockets.visibleFrames.length === 0}
        <p class="hint">No frames.</p>
      {:else}
        <div class="list" role="list">
          {#each sockets.visibleFrames as fr (fr.sequence)}
            {@render frameRow(fr)}
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/if}

{#snippet frameRow(fr: FrameSummary)}
  {@const body = sockets.bodies[fr.sequence]}
  <div class="frame" role="listitem" class:expanded={sockets.expanded.has(fr.sequence)}>
    <button
      type="button"
      class="framerow"
      data-testid={`ws-frame-${fr.sequence}`}
      aria-expanded={sockets.expanded.has(fr.sequence)}
      onclick={() => sockets.toggleFrame(fr.sequence)}
    >
      <span class="sr-only">{fr.direction === 'in' ? 'received' : 'sent'}</span>
      <span
        class="glyph"
        style={`--tint: var(--${fr.direction === 'in' ? 'kind-sse' : 'accent'})`}
        aria-hidden="true"
      >{fr.direction === 'in' ? '↓' : '↑'}</span>
      <span class="seq">#{fr.sequence}</span>
      <span class="ts">{fmtTime(fr.ts)}</span>
      <span class="size">{fmtBytes(fr.body.size)}</span>
      {#if fr.binary}
        <span class="prev binary" style="--tint: var(--status-4xx)">binary · {fmtBytes(fr.body.size)}</span>
      {:else if fr.body.state === 'omitted'}
        <span class="prev muted">omitted:{fr.body.omitted}</span>
      {:else}
        {@const p = sockets.preview(fr)}
        <span class="prev mono">{p ?? ''}</span>
      {/if}
    </button>

    {#if sockets.expanded.has(fr.sequence)}
      <div class="body">
        {#if body?.kind === 'ok'}
          <div class="body-text" data-testid="frame-body-text">
            <JsonView hash={body.hash} mode="raw" {cache} />
          </div>
        {:else if body?.kind === 'omitted'}
          <OmittedCard kind="omitted" reason={body.reason} size={body.size} label="frame" />
        {:else if body?.kind === 'absent'}
          <OmittedCard kind="absent" label="frame" />
        {:else if body?.kind === 'gone'}
          <OmittedCard kind="gone" label="frame" />
        {:else if body?.kind === 'error'}
          <div class="body-error" data-testid="frame-body-error">
            <p class="hint">Couldn’t load this frame. Transport error, not a cleared record.</p>
            <Button variant="secondary" size="sm" onclick={() => sockets.reloadFrameBody(fr.sequence)}>Retry</Button>
          </div>
        {:else}
          <p class="hint">Loading…</p>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .frametimeline {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-base);
  }
  .frametimeline.empty {
    align-items: stretch;
    justify-content: center;
  }
  .head {
    flex: 0 0 auto;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .url {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--fg-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    margin: 6px 0 0;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    flex: 0 0 40px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .search {
    width: 220px;
    max-width: 30vw;
    height: 28px;
    padding: 0 10px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
  .search::placeholder {
    color: var(--fg-muted);
  }
  .grow {
    flex: 1 1 auto;
  }
  .frames {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .hint {
    padding: 16px;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px;
  }
  .body-error {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  .frame {
    border-bottom: 1px solid var(--border-subtle);
  }
  .framerow {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    height: 28px;
    padding: 0 12px;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .framerow:hover {
    background: var(--bg-surface);
  }
  .frame.expanded > .framerow {
    background: var(--bg-surface);
  }
  .glyph {
    flex: 0 0 auto;
    width: 12px;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--tint);
    text-align: center;
  }
  .seq {
    flex: 0 0 auto;
    min-width: 40px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-secondary);
  }
  .ts {
    flex: 0 0 auto;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .size {
    flex: 0 0 auto;
    min-width: 56px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .prev {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .prev.mono {
    font-family: var(--font-mono);
    color: var(--fg-secondary);
  }
  .prev.binary {
    font-family: var(--font-mono);
    color: var(--tint);
  }
  .prev.muted {
    font-family: var(--font-mono);
    color: var(--fg-muted);
  }
  .body {
    min-height: 0;
    overflow: auto;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-surface);
  }
  .body-text {
    min-height: 0;
    overflow: auto;
  }
</style>
