<script lang="ts">
  import type { Selection } from '../../lib/state/Selection.svelte.js';
  import TimingBar from '../../components/TimingBar.svelte';

  type Props = { selection: Selection };
  let { selection }: Props = $props();
</script>

<TimingBar durationMs={selection.current?.durationMs ?? null} />
