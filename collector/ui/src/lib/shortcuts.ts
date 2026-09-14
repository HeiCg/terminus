// The single source of truth for the keyboard-shortcut sheet (`?`). The App root
// binds the handlers (it owns the closures over palette/selection/sockets state);
// this table is only the DISPLAYED keymap, so the sheet and the command-palette
// entry render one list that stays in step with the bindings in `hotkeys.ts` and
// `App.svelte`. Keep the two in sync by hand: a shortcut shown here should have a
// real binding, and a new binding should gain a row here.

// `mod` renders as ⌘ on macOS and Ctrl elsewhere, matching how `hotkeys.ts`
// resolves the modifier. Sniffed the same way (userAgentData first) and once.
function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac/i.test(platform);
}

export const MOD_LABEL = isMac() ? '⌘' : 'Ctrl';

export interface Shortcut {
  keys: string; // display string, e.g. "⌘K" or "Shift+Enter"
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Global',
    items: [
      { keys: `${MOD_LABEL}K`, label: 'Open the command palette' },
      { keys: '?', label: 'Show this shortcuts sheet' },
      { keys: 'Esc', label: 'Close a dialog, or clear the selection' },
    ],
  },
  {
    title: 'Capture',
    items: [
      { keys: '/', label: 'Focus the search box' },
      { keys: 'j', label: 'Select the next request' },
      { keys: 'k', label: 'Select the previous request' },
    ],
  },
  {
    title: 'Socket frames',
    items: [
      { keys: 'Enter', label: 'Jump to the next frame match' },
      { keys: 'Shift+Enter', label: 'Jump to the previous frame match' },
    ],
  },
];
