<script lang="ts">
  import type { Selection } from '../../lib/state/Selection.svelte.js';
  import HeadersTable from '../../components/HeadersTable.svelte';

  type Props = { selection: Selection };
  let { selection }: Props = $props();
</script>

<HeadersTable
  request={selection.detail?.requestHeaders ?? {}}
  response={selection.detail?.responseHeaders ?? {}}
/>
