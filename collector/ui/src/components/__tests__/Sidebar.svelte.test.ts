import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi } from 'vitest';
import Sidebar from '../Sidebar.svelte';
import { Nav } from '../../lib/state/Nav.svelte.js';
import { Session } from '../../lib/state/Session.svelte.js';
import { CTX } from '../../lib/context.js';

function renderSidebar() {
  const nav = new Nav();
  const session = new Session();
  const context = new Map<symbol, unknown>([[CTX.nav, nav], [CTX.session, session]]);
  render(Sidebar, { context });
  return { nav, session };
}

describe('Sidebar', () => {
  it('logs out via session.logout when the Sair button is clicked', async () => {
    const { session } = renderSidebar();
    const spy = vi.spyOn(session, 'logout').mockResolvedValue(undefined);
    await fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    expect(spy).toHaveBeenCalledOnce();
  });
});
