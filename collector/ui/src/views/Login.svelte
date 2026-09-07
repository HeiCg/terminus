<script lang="ts">
  import { useSession } from '../lib/context.js';

  // The token never touches storage: it goes straight to Session.submitToken,
  // which trades it for a cookie and (on failure) sets session.error.
  const session = useSession();
  let token = $state('');

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    void session.submitToken(token);
  }
</script>

<div class="login">
  <form onsubmit={submit}>
    <div class="mark" aria-hidden="true">T</div>
    <h1>Terminus</h1>
    <p class="subtitle">Cole o admin token impresso no terminal</p>
    <input
      type="password"
      bind:value={token}
      autocomplete="off"
      spellcheck="false"
      placeholder="admin token"
      aria-label="Admin token"
    />
    <button type="submit">Entrar</button>
    {#if session.error}<div class="err">{session.error}</div>{/if}
    <p class="footnote">Sessão vale enquanto o collector estiver rodando.</p>
  </form>
</div>

<style>
  .login {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    background: var(--bg-base);
  }
  form {
    width: 400px;
    max-width: 92vw;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    padding: 32px;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
  }
  .mark {
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    font-size: 20px;
    font-weight: 700;
    color: var(--fg-on-accent);
    background: var(--accent);
    border-radius: var(--radius-sm);
  }
  h1 {
    margin: 4px 0 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--fg-primary);
  }
  .subtitle {
    margin: 0;
    font-size: 12px;
    color: var(--fg-secondary);
  }
  input {
    height: 36px;
    padding: 0 11px;
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--fg-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
  }
  input::placeholder {
    color: var(--fg-muted);
  }
  button {
    width: 100%;
    height: 36px;
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 600;
    color: var(--fg-on-accent);
    background: var(--accent);
    border: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  .err {
    font-size: 12px;
    color: var(--status-5xx);
  }
  .footnote {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--fg-muted);
  }
</style>
