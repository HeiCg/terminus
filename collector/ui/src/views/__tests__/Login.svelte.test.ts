import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Login from '../Login.svelte';
import { Session } from '../../lib/state/Session.svelte.js';
import { CTX } from '../../lib/context.js';

function renderLogin(session: Session) {
  return render(Login, { context: new Map<symbol, unknown>([[CTX.session, session]]) });
}

afterEach(() => cleanup());

describe('Login', () => {
  it('shows the Terminus title, subtitle and Entrar button', () => {
    renderLogin(new Session());
    expect(screen.getByText('Terminus')).toBeInTheDocument();
    expect(screen.getByText('Cole o admin token impresso no terminal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument();
  });

  it('submits the entered token to the session', async () => {
    const session = new Session();
    const spy = vi.spyOn(session, 'submitToken').mockResolvedValue();
    renderLogin(session);

    const user = userEvent.setup();
    // The token field is a password input (no textbox role), reached by its
    // placeholder — the Figma card masks the admin token as it is pasted.
    await user.type(screen.getByPlaceholderText('admin token'), 'my-token');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(spy).toHaveBeenCalledWith('my-token');
  });
});
