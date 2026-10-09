<script lang="ts">
  import ScopeCard from './ScopeCard.svelte';
  import RulesCard from './RulesCard.svelte';

  // Settings (U5): collector-side configuration the admin can change at runtime:
  // the capture scope and the proxy's interception rules (U6). Each card owns its
  // own load/save.
</script>

<div class="settings">
  <div class="scroll">
    <h1 class="page-title">Settings</h1>
    <div class="cards">
      <ScopeCard />
      <RulesCard />
    </div>
  </div>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .page-title {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 20px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .cards {
    display: grid;
    grid-template-columns: minmax(0, 720px);
    gap: 20px;
  }
</style>
