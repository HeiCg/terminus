<script lang="ts">
  import { useSockets } from '../../lib/context.js';
  import SessionList from './SessionList.svelte';
  import FrameTimeline from './FrameTimeline.svelte';

  // App-lifetime singleton (created in main.ts, seeded into context): reading it
  // here means a tab switch preserves the selected socket, its loaded frames and
  // every filter. Nothing is disposed on unmount — the instance lives for the page.
  const sockets = useSockets();
</script>

<div class="sockets">
  <div class="list-pane">
    <SessionList {sockets} />
  </div>
  <FrameTimeline {sockets} />
</div>

<style>
  .sockets {
    display: flex;
    height: 100%;
    min-height: 0;
  }
  .list-pane {
    flex: 0 0 40%;
    min-width: 360px;
    display: flex;
    min-height: 0;
    border-right: 1px solid var(--border-subtle);
  }
</style>
