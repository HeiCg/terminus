import type { Attachment } from 'svelte/attachments';

// App-wide keyboard shortcuts as an attachment: `{@attach hotkeys(map)}` on the
// App root OWNS the listener lifecycle (bound on mount, removed on unmount) but
// binds it on `window`, so a shortcut fires even when focus sits on document.body
// (nothing focused) — an element-scoped listener would miss those. `mod` is ⌘ on
// macOS and Ctrl elsewhere, sniffed once — userAgentData.platform when present,
// navigator.platform otherwise.
type Handler = (e: KeyboardEvent) => void;

function isMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac/i.test(platform);
}

const MAC = isMac();

// Map a keydown to the map key it triggers, or null for "no binding". Plain
// letters only fire with NO modifier held, so ⌘K never doubles as `k`.
function comboFor(e: KeyboardEvent): string | null {
  const mod = MAC ? e.metaKey : e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'k') return 'mod+k';
  if (key === 'escape') return 'escape';
  // The shortcuts sheet: `?` (Shift+/ on most layouts, so shift is expected) or
  // mod+/. Both surface as the single `help` binding.
  if (key === '?') return 'help';
  if (mod && key === '/') return 'help';
  if (!e.metaKey && !e.ctrlKey && !e.altKey) {
    if (key === 'j') return 'j';
    if (key === 'k') return 'k';
    if (key === '/') return '/';
  }
  return null;
}

// The row-navigation / focus shortcuts (j, k, /) must never fire while the user
// is entering text OR operating a <select> — where the keystroke has its own
// meaning. A <button> is NOT excluded: the request rows themselves are buttons,
// so "click a row, press j" must keep working (Space/Enter aren't in the map).
// `mod+k` (toggle palette) and `escape` (dismiss) are exempt entirely: they work
// from anywhere, including the search box and the palette input.
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function hotkeys(map: Record<string, Handler>): Attachment {
  // `element` is only the lifecycle anchor; the listener lives on `window`.
  return () => {
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.isComposing) return; // never steal keys mid-IME-composition
      const combo = comboFor(e);
      if (!combo) return;
      const handler = map[combo];
      if (!handler) return;
      // mod+k and escape are unconditional; j/k/`/` yield to text-entry targets.
      if (combo !== 'mod+k' && combo !== 'escape' && isTextEntryTarget(e.target)) return;
      handler(e);
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  };
}
