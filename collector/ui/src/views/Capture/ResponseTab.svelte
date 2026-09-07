<script lang="ts">
  import type { Selection } from '../../lib/state/Selection.svelte.js';
  import BodyPane from './BodyPane.svelte';

  type Props = { selection: Selection };
  let { selection }: Props = $props();
</script>

<BodyPane {selection} side="response" testid="body-response" />
