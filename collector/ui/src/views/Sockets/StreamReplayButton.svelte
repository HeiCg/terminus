<script lang="ts">
  import type { WsSummary } from '../../lib/protocol.js';
  import * as realApi from '../../lib/api.js';
  import { StreamReplayDraft, type StreamReplayKey } from '../../lib/state/StreamReplayDraft.svelte.js';
  import Button from '../../components/Button.svelte';
  import StreamReplayEditor from './StreamReplayEditor.svelte';

  // U7: the "Replay stream" affordance in the Sockets detail of a raw TCP/TLS
  // session. Clicking opens the stream replay editor on a fresh draft (its client
  // frames listed through the frames API); a TLS pass-through tunnel has no
  // captured plaintext, so the button is shown disabled with the reason. The UI is
  // admin-only by construction (the /ui socket requires the admin session).
  type Api = Pick<typeof realApi, 'fetchFrames' | 'fetchFrameBody'>;
  type Props = { session: WsSummary; onsent: (key: StreamReplayKey) => void; api?: Api };
  let { session, onsent, api = realApi }: Props = $props();

  let draft = $state<StreamReplayDraft | null>(null);
  const plaintext = $derived(session.stream?.plaintext === true);

  function open(): void {
    const d = new StreamReplayDraft(session, api);
    draft = d;
    void d.load();
  }
</script>

<Button
  variant="secondary"
  size="sm"
  disabled={!plaintext}
  onclick={open}
  title={plaintext ? 'Re-send this stream\'s client frames from the collector' : 'A TLS pass-through tunnel has no captured plaintext to replay'}
>
  Replay stream
</Button>

{#if draft}
  <StreamReplayEditor {draft} onclose={() => (draft = null)} {onsent} />
{/if}
