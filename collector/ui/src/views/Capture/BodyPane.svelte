<script lang="ts">
  import type { Selection } from '../../lib/state/Selection.svelte.js';
  import { useCache } from '../../lib/context.js';
  import { fmtBytes } from '../../lib/format.js';
  import Segmented from '../../components/Segmented.svelte';
  import JsonView from '../../components/JsonView.svelte';
  import OmittedCard from '../../components/OmittedCard.svelte';

  // One side of the exchange, rendered for the Response and Payload tabs alike.
  // `testid` is the container the browser spec reads the rendered body from.
  type Props = { selection: Selection; side: 'request' | 'response'; testid: string };
  let { selection, side, testid }: Props = $props();

  const cache = useCache();

  const bs = $derived(selection.bodies[side]);

  const headers = $derived(side === 'request' ? selection.detail?.requestHeaders : selection.detail?.responseHeaders);
  const contentType = $derived.by(() => {
    const h = headers ?? {};
    const key = Object.keys(h).find((k) => k.toLowerCase() === 'content-type');
    return key ? h[key] : null;
  });

  // Non-textual content types the pane must NOT render as text. Anything under
  // these top-level types (plus the two opaque application blobs) is treated as
  // bytes; `image/*` additionally gets an inline preview below.
  const NON_TEXTUAL = /^(image|audio|video|font)\//i;
  function isNonTextualType(ct: string | null): boolean {
    if (!ct) return false;
    const t = ct.split(';', 1)[0].trim().toLowerCase();
    return NON_TEXTUAL.test(t) || t === 'application/octet-stream' || t === 'application/pdf';
  }

  // A body is binary when the server flagged its encoding as binary, the
  // content-type is non-textual, or the payload carries a NUL byte in its first
  // 512 chars (a mislabeled binary body). `peek` is non-touching — reading it in
  // a $derived must not reorder the cache LRU.
  const isBinary = $derived.by((): boolean => {
    const b = bs;
    if (b.kind !== 'ok') return false;
    if (b.encoding === 'binary') return true;
    if (isNonTextualType(contentType)) return true;
    const raw = cache.peek(b.hash);
    return raw != null && raw.slice(0, 512).includes('\u0000');
  });

  const binaryType = $derived((contentType?.split(';', 1)[0].trim() || null) ?? 'application/octet-stream');
  const isImage = $derived(/^image\//i.test(binaryType));

  // atob → bytes, so a binary (base64) body downloads as its real bytes. Backed
  // by a concrete ArrayBuffer so the result is a valid BlobPart under strict DOM
  // lib typings (a plain Uint8Array is inferred as ArrayBufferLike). Throws on
  // malformed base64 — callers guard with try/catch.
  function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Base64-encode a text body's UTF-8 bytes (for an image/* body stored as utf8).
  function utf8ToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(s);
  }

  // A binary (base64) payload that fails to decode: the card shows an invalid
  // state instead of a broken preview or a download of garbage.
  const payloadInvalid = $derived.by((): boolean => {
    const b = bs;
    if (b.kind !== 'ok' || b.encoding !== 'binary') return false;
    const raw = cache.peek(b.hash);
    if (raw == null) return false;
    try { atob(raw); return false; } catch { return true; }
  });

  // Inline preview source for an image body: a data URL. binary bodies hold base64
  // directly; a utf8-stored image is re-encoded to base64. Null when not a
  // resident image, or when the payload cannot be encoded.
  const imgSrc = $derived.by((): string | null => {
    const b = bs;
    if (b.kind !== 'ok' || !isImage) return null;
    const raw = cache.peek(b.hash);
    if (raw == null) return null;
    try {
      const b64 = b.encoding === 'binary' ? raw : utf8ToBase64(raw);
      atob(b64); // validate binary payloads before handing the browser a data URL
      return `data:${binaryType};base64,${b64}`;
    } catch {
      return null;
    }
  });

  function rawText(): string | null {
    return bs.kind === 'ok' ? cache.getRaw(bs.hash) ?? null : null;
  }

  // Common file extensions for the binary types we card, so a path with no
  // extension still downloads with a sensible one.
  const EXT_BY_TYPE: Record<string, string> = {
    'application/octet-stream': 'bin', 'application/pdf': 'pdf',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
    'font/woff2': 'woff2', 'font/woff': 'woff',
  };
  function extFromType(type: string): string {
    if (EXT_BY_TYPE[type]) return EXT_BY_TYPE[type];
    const sub = type.split('/')[1] ?? '';
    const cleaned = sub.split('+')[0].replace(/[^a-z0-9]/gi, '');
    return cleaned || 'bin';
  }

  // Filename for a binary download, derived and SANITIZED from the request path:
  // its last non-empty segment with query/fragment stripped, traversal and unsafe
  // characters removed, falling back to `body.bin`, and an extension from the
  // content-type appended when the name carries none.
  function binaryName(): string {
    const p = selection.current?.path ?? '';
    const last = p.split(/[?#]/, 1)[0].split('/').filter(Boolean).pop() ?? '';
    let name = last.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '');
    if (!name || name === '.') name = 'body.bin';
    if (!/\.[A-Za-z0-9]+$/.test(name)) name += `.${extFromType(binaryType)}`;
    return name;
  }

  function downloadBinary(): void {
    const b = bs;
    if (b.kind !== 'ok') return;
    const raw = rawText();
    if (raw == null) return;
    const type = binaryType;
    let blob: Blob;
    try {
      blob = b.encoding === 'binary'
        ? new Blob([base64ToBytes(raw)], { type }) // real bytes for a base64 body
        : new Blob([raw], { type });               // text body: its bytes as-is
    } catch {
      return; // malformed base64: the card already shows the invalid state
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = binaryName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function copy(): Promise<void> {
    const text = rawText();
    if (text == null) return;
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  }

  function download(): void {
    const text = rawText();
    if (text == null) return;
    const type = contentType ?? 'text/plain';
    const ext = type.includes('application/json') ? 'json' : 'txt';
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${side}-body.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer the revoke so the browser has started the download before the object
    // URL is torn down (a synchronous revoke can cancel it in some browsers).
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const MODES = [
    { id: 'json', label: 'Pretty' },
    { id: 'raw', label: 'Raw' },
  ];
</script>

{#if bs.kind === 'absent'}
  <OmittedCard kind="absent" label={side} />
{:else if bs.kind === 'omitted'}
  <OmittedCard kind="omitted" reason={bs.reason} size={bs.size} label={side} />
{:else if bs.kind === 'gone'}
  <OmittedCard kind="gone" label={side} />
{:else if bs.kind === 'error'}
  <div class="err-card" data-testid={testid}>
    <p class="err-title">Couldn’t load the {side} body</p>
    <p class="err-hint">The request failed. This is a transport error, not a cleared record.</p>
    <button type="button" class="err-retry" onclick={() => void selection.loadBody(side)}>Retry</button>
  </div>
{:else if bs.kind === 'ok' && isBinary}
  <div class="body" data-testid={testid}>
    <div class="bin-card">
      <p class="bin-title">Binary · {binaryType} · {fmtBytes(bs.size)}</p>
      {#if payloadInvalid}
        <p class="bin-invalid">Invalid payload — the body could not be decoded.</p>
      {:else}
        {#if imgSrc}<img class="bin-preview" src={imgSrc} alt="{side} body preview" />{/if}
        <button type="button" class="bin-download" onclick={downloadBinary}>Download</button>
      {/if}
    </div>
  </div>
{:else if bs.kind === 'ok'}
  <div class="toolbar">
    <Segmented options={MODES} value={selection.mode} onchange={(m) => (selection.mode = m as 'json' | 'raw')} />
    <button type="button" class="ghost" onclick={copy}>Copy</button>
    <button type="button" class="ghost" onclick={download}>Download</button>
    <span class="meta">
      {#if contentType}<span class="ct">{contentType}</span>{/if}
      <span class="size">{fmtBytes(bs.size)}</span>
    </span>
  </div>
  <div class="body" data-testid={testid}>
    <JsonView hash={bs.hash} mode={selection.mode} {cache} />
  </div>
{:else}
  <p class="loading">Loading…</p>
{/if}

<style>
  .loading {
    padding: 16px;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 40px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .ghost {
    height: 28px;
    padding: 0 10px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--fg-primary);
    background: var(--bg-elevated);
  }
  .meta {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .body {
    min-height: 0;
    overflow: auto;
  }
  .bin-card {
    margin: 16px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    background: var(--bg-elevated);
    border-radius: 8px;
  }
  .bin-title {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--fg-primary);
  }
  .bin-preview {
    max-width: 320px;
    max-height: 320px;
    border-radius: var(--radius-sm);
  }
  .bin-invalid {
    margin: 0;
    font-size: 12px;
    color: var(--status-4xx);
  }
  .bin-download {
    height: 28px;
    padding: 0 12px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .bin-download:hover {
    color: var(--fg-primary);
    background: var(--bg-surface);
  }
  .err-card {
    margin: 16px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    background: var(--bg-elevated);
    border-radius: 8px;
  }
  .err-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .err-hint {
    margin: 0;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  .err-retry {
    margin-top: 4px;
    height: 28px;
    padding: 0 12px;
    font-family: var(--font-ui);
    font-size: 12px;
    color: var(--fg-secondary);
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .err-retry:hover {
    color: var(--fg-primary);
    background: var(--bg-surface);
  }
</style>
