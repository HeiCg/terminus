<script lang="ts">
  import type { EntrySummary } from '../../lib/protocol.js';

  // U6: marks a proxy entry an interception rule touched, in the Capture list.
  // MOCK when a rule answered without contacting upstream, RULE otherwise.
  type Props = { rules: NonNullable<EntrySummary['rules']>; mocked?: boolean };
  let { rules, mocked = false }: Props = $props();

  const title = $derived(`${mocked ? 'Answered by a rule (no upstream). ' : ''}Rules: ${rules.map((r) => r.name).join(', ')}`);
</script>

<span class={['rule-badge', { mocked }]} {title} data-testid="rule-badge">{mocked ? 'mock' : 'rule'}</span>

<style>
  .rule-badge {
    display: inline-flex;
    align-items: center;
    height: 16px;
    padding: 0 5px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    line-height: 1;
    text-transform: uppercase;
    color: var(--source-proxy);
    background: color-mix(in srgb, var(--source-proxy) 16%, transparent);
    border-radius: 999px;
  }
  .rule-badge.mocked {
    color: var(--source-replay);
    background: color-mix(in srgb, var(--source-replay) 16%, transparent);
  }
</style>
