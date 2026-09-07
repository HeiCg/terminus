<script lang="ts">
  import type { BodyCache } from '../lib/bodyCache.js';
  import { utf8Bytes } from '../lib/format.js';

  type Props = { hash: string; mode: 'json' | 'raw'; cache: BodyCache };
  let { hash, mode, cache }: Props = $props();

  type Seg = { t: string; c: 'key' | 'str' | 'num' | 'bool' | null };

  // Above this, tokenizing would emit a span per token and choke the DOM, so a
  // large body renders as one plain <pre> with a note instead of tinted spans.
  const TINT_MAX_BYTES = 200 * 1024;

  // JSON token matcher: a (possibly key) string, a literal, or a number. Anything
  // between matches — braces, commas, colons, whitespace — is emitted as plain
  // text (it inherits the muted punctuation colour from `.json`), so only the
  // value tokens carry tint spans and a large body does not explode into DOM.
  const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

  function tokenize(text: string): Seg[] {
    const segs: Seg[] = [];
    let last = 0;
    TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN.exec(text)) !== null) {
      if (m.index > last) segs.push({ t: text.slice(last, m.index), c: null });
      if (m[1] !== undefined) {
        if (m[2] !== undefined) {
          segs.push({ t: m[1], c: 'key' });
          segs.push({ t: m[2], c: null }); // the colon (+ any leading space)
        } else {
          segs.push({ t: m[1], c: 'str' });
        }
      } else if (m[3] !== undefined) {
        segs.push({ t: m[3], c: 'bool' });
      } else if (m[4] !== undefined) {
        segs.push({ t: m[4], c: 'num' });
      }
      last = TOKEN.lastIndex;
    }
    if (last < text.length) segs.push({ t: text.slice(last), c: null });
    return segs;
  }

  const fmt = $derived(cache.format(hash, mode));
  // Tint only valid JSON, in json mode, under the size cap. Everything else —
  // raw mode, invalid/too-large fallbacks, or an oversize pretty body — renders
  // as plain text so nothing is re-parsed, mis-highlighted, or DOM-bombed.
  const tintSkipped = $derived(
    !!fmt && mode === 'json' && fmt.warning === null && utf8Bytes(fmt.text) > TINT_MAX_BYTES,
  );
  const segments = $derived(
    mode === 'json' && fmt?.warning === null && !tintSkipped ? tokenize(fmt.text) : null,
  );
  const note = $derived(
    fmt?.warning === 'too-large'
      ? 'Pretty-print skipped: too large'
      : fmt?.warning === 'invalid'
        ? 'Not valid JSON — showing raw'
        : tintSkipped
          ? 'Syntax highlighting skipped (large body)'
          : null,
  );
</script>

{#if fmt}
  {#if note}<p class="note">{note}</p>{/if}
  {#if segments}
    <pre class="json"><code>{#each segments as s, i (i)}{#if s.c}<span class={`tok-${s.c}`}>{s.t}</span>{:else}{s.t}{/if}{/each}</code></pre>
  {:else}
    <pre class="json"><code>{fmt.text}</code></pre>
  {/if}
{/if}

<style>
  .json {
    margin: 0;
    padding: 16px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    overflow: auto;
  }
  .tok-key {
    color: var(--fg-primary);
  }
  .tok-str {
    color: var(--kind-sse);
  }
  .tok-num {
    color: var(--status-4xx);
  }
  .tok-bool {
    color: var(--kind-ws);
  }
  .note {
    margin: 0;
    padding: 8px 16px;
    font-family: var(--font-ui);
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
