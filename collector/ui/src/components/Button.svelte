<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  // Rest props (…rest) are spread onto the <button> so attachments and native
  // attributes pass straight through. `children` is the text/content label;
  // `icon` is an optional leading glyph snippet.
  type Props = {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md';
    disabled?: boolean;
    active?: boolean;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
    icon?: Snippet;
  } & Omit<HTMLButtonAttributes, 'children' | 'disabled' | 'onclick'>;

  let {
    variant = 'primary',
    size = 'md',
    disabled = false,
    active = false,
    onclick,
    children,
    icon,
    ...rest
  }: Props = $props();
</script>

<button
  {...rest}
  type={rest.type ?? 'button'}
  class={['btn', `v-${variant}`, `s-${size}`, { active }, rest.class]}
  {disabled}
  {onclick}
>
  {#if icon}<span class="icon">{@render icon()}</span>{/if}
  <span class="label">{@render children()}</span>
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--fg-primary);
    background: transparent;
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .s-md {
    height: 32px;
  }
  .s-sm {
    height: 28px;
  }
  .icon {
    display: inline-flex;
    align-items: center;
  }

  .v-primary {
    background: var(--accent);
    color: var(--fg-on-accent);
  }
  .v-secondary {
    background: var(--bg-elevated);
    border-color: var(--border-strong);
    color: var(--fg-primary);
  }
  .v-ghost {
    background: transparent;
    color: var(--fg-secondary);
  }
  .v-ghost:hover {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .v-danger {
    --tint: var(--status-5xx);
    background: var(--tint-surface);
    color: var(--status-5xx);
  }

  .btn.active {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
