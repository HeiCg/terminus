<script lang="ts">
  type Props = { request: Record<string, string>; response: Record<string, string> };
  let { request, response }: Props = $props();

  const groups = $derived([
    { title: 'Request', rows: Object.entries(request) },
    { title: 'Response', rows: Object.entries(response) },
  ]);

  // Copy "key: value" to the clipboard. jsdom (and any denied-permission context)
  // has no clipboard, so the write is best-effort and never throws into render.
  async function copy(key: string, value: string): Promise<void> {
    try {
      await navigator.clipboard?.writeText(`${key}: ${value}`);
    } catch {
      /* clipboard unavailable — nothing to recover */
    }
  }
</script>

<div class="headers">
  {#each groups as group (group.title)}
    <section class="group">
      <h3 class="cap">{group.title}</h3>
      {#if group.rows.length === 0}
        <p class="empty">No headers.</p>
      {:else}
        <dl class="rows">
          {#each group.rows as [key, value] (key)}
            <div class="hrow">
              <dt class="key">{key}</dt>
              <dd class="val">{value}</dd>
              <button
                type="button"
                class="copy"
                aria-label={`Copy ${key}`}
                onclick={() => copy(key, value)}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" />
                  <path d="M2.5 8V2.5H8" stroke="currentColor" />
                </svg>
              </button>
            </div>
          {/each}
        </dl>
      {/if}
    </section>
  {/each}
</div>

<style>
  .headers {
    padding: 16px;
    overflow: auto;
  }
  .group + .group {
    margin-top: 20px;
  }
  .cap {
    margin: 0 0 8px;
    font-family: var(--font-ui);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-secondary);
  }
  .empty {
    margin: 0;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .rows {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .hrow {
    display: grid;
    grid-template-columns: minmax(120px, 240px) 1fr auto;
    align-items: start;
    gap: 12px;
    padding: 3px 0;
  }
  .key {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-secondary);
    word-break: break-word;
  }
  .val {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
    word-break: break-word;
  }
  /* Always in the DOM (a screen reader can reach it); revealed on row hover or
     when the button itself takes focus, so it never shifts the row layout. */
  .copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--fg-secondary);
    cursor: pointer;
    opacity: 0;
  }
  .hrow:hover .copy,
  .copy:focus-visible {
    opacity: 1;
  }
  .copy:hover {
    background: var(--bg-elevated);
    color: var(--fg-primary);
  }
</style>
